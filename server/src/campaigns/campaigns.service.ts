import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { NumbersService } from '../numbers/numbers.service';
import { parseCsv } from '../contacts/contacts.controller';
import { normalizePhone, toChatId } from '../common/phone';
import { checkTemplate, contactRecipients, ContactRow, Recipient, RecipientMode, renderMessage, StudentRow, studentRecipients, varName } from './render';
import { estimate } from './estimate';
import { PeopleService } from '../contacts/people.service';
import { cleanRule, describeRule, NumberRule } from '../contacts/rules';
import { addDays, cleanSchedule, dateMatches, DatedSchedule, localDay, nextRunAt, offsetLabel, parseDate, RepeatSchedule, Schedule, spreadPlan, upcoming, variants } from './schedule';

export interface DateMatch { source: 'birthday' | 'column'; column?: string; yearly: boolean; target: string; offset: number }
const isTemplate = (c: { schedule: Schedule | null }) => c.schedule?.mode === 'repeat' || c.schedule?.mode === 'dated';
const fmtDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export interface Campaign {
  id: number; name: string; kind: 'contacts' | 'wa_groups'; status: string; body: string; media_id: number | null;
  audience: { groupIds?: number[]; csv?: CsvInfo | null; waGroups?: { numberId: number; chatId: string; subject?: string }[]; dateMatch?: DateMatch };
  recipient_mode: RecipientMode; per_child: boolean; number_ids: number[];
  delay_min_ms: number; delay_max_ms: number; burst_min: number; burst_max: number; burst_pause_min_ms: number; burst_pause_max_ms: number;
  typing: boolean; respect_quiet_hours: boolean;
  message_type: string | null; number_rule: NumberRule | null; override_opt_out: boolean;
  schedule: Schedule | null; parent_id: number | null; run_day: string | null; next_run_at: Date | null; runs: number; last_run_at: Date | null;
  total: number; sent: number; delivered: number; read: number; failed: number; skipped: number;
  created_at: Date; started_at: Date | null; finished_at: Date | null;
}
interface CsvInfo { filename: string; keyColumn: string; keyType: 'admission' | 'phone'; nameColumn?: string | null; columns: string[]; variables: string[]; rows: number; matched: number; unmatched: number }

const EDITABLE = ['name', 'body', 'media_id', 'recipient_mode', 'per_child', 'number_ids', 'delay_min_ms', 'delay_max_ms', 'burst_min', 'burst_max',
  'burst_pause_min_ms', 'burst_pause_max_ms', 'typing', 'respect_quiet_hours', 'audience', 'message_type', 'number_rule', 'schedule'] as const;
const SPEED_FIELDS = ['delay_min_ms', 'delay_max_ms', 'burst_min', 'burst_max', 'burst_pause_min_ms', 'burst_pause_max_ms', 'typing', 'respect_quiet_hours', 'number_ids'];
const stripZeros = (s: string) => String(s ?? '').trim().replace(/^0+(?=\d)/, '');

@Injectable()
export class CampaignsService {
  constructor(private readonly db: Db, private readonly settings: SettingsService, private readonly numbers: NumbersService, private readonly people: PeopleService) {}

  list() {
    // Runs of scheduled campaigns are listed under their schedule, not here
    return this.db.query(`select id, name, kind, status, total, sent, delivered, read, failed, skipped, created_at, started_at, finished_at,
                                 schedule, next_run_at, runs, message_type
                          from campaigns where parent_id is null order by id desc limit 300`);
  }

  async get(id: number): Promise<Campaign> {
    const c = await this.db.one<Campaign>('select * from campaigns where id=$1', [id]);
    if (!c) throw new NotFoundException('Campaign not found');
    return c;
  }

  async detail(id: number) {
    const c = await this.get(id);
    const byNumber = await this.db.query(`
      select n.id, n.label, count(*) filter (where m.status in ('sent','delivered','read'))::int as sent,
             count(*) filter (where m.status = 'failed')::int as failed
      from messages m join wa_numbers n on n.id = m.number_id where m.campaign_id = $1 group by n.id, n.label order by n.id`, [id]);
    const queued = await this.db.one<{ n: number }>(`select count(*)::int n from messages where campaign_id=$1 and status in ('queued','sending')`, [id]);
    const runList = isTemplate(c) ? await this.db.query(
      `select id, name, status, run_day, total, sent, delivered, read, failed, skipped, started_at, finished_at
       from campaigns where parent_id=$1 order by id desc limit 200`, [id]) : [];
    const parent = c.parent_id ? await this.db.one('select id, name from campaigns where id=$1', [c.parent_id]) : null;
    return { ...c, byNumber, queued: queued?.n ?? 0, runList, parent };
  }

  async create(b: Partial<Campaign>) {
    const s = await this.settings.get();
    const sp = s.speedPresets.normal;
    const kind = b.kind === 'wa_groups' ? 'wa_groups' : 'contacts';
    const row = await this.db.one<Campaign>(
      `insert into campaigns(name, kind, recipient_mode, delay_min_ms, delay_max_ms, burst_min, burst_max, burst_pause_min_ms, burst_pause_max_ms)
       values ($1,$2,'primary',$3,$4,$5,$6,$7,$8) returning *`,
      [b.name?.trim() || 'Untitled campaign', kind, sp.delayMinMs, sp.delayMaxMs, sp.burstMin, sp.burstMax, sp.burstPauseMinMs, sp.burstPauseMaxMs],
    );
    const first = s.messageTypes.find((t) => t.key === 'notice') ?? s.messageTypes[0];
    return first ? this.update(row!.id, { message_type: first.key }) : row;
  }

  async update(id: number, b: Record<string, any>) {
    const c = await this.get(id);
    const allowed: readonly string[] = c.status === 'draft' ? EDITABLE : ['running', 'paused'].includes(c.status) ? SPEED_FIELDS : [];
    if (!allowed.length) throw new BadRequestException(`A ${c.status} campaign cannot be edited`);
    // Choosing what the message is for fills in its recipients, speed, quiet hours and STOP handling
    if (allowed.includes('message_type') && b.message_type !== undefined && b.message_type !== c.message_type) {
      const s = await this.settings.get();
      const t = s.messageTypes.find((x) => x.key === b.message_type);
      if (!t) throw new BadRequestException('Unknown message type');
      const sp = s.speedPresets[t.speed];
      b = {
        recipient_mode: t.school, respect_quiet_hours: t.quietHours, number_rule: null,
        delay_min_ms: sp.delayMinMs, delay_max_ms: sp.delayMaxMs, burst_min: sp.burstMin, burst_max: sp.burstMax,
        burst_pause_min_ms: sp.burstPauseMinMs, burst_pause_max_ms: sp.burstPauseMaxMs, ...b,
      };
      await this.db.query('update campaigns set override_opt_out=$2 where id=$1', [id, t.overrideOptOut]);
    }
    const sets: string[] = [], vals: unknown[] = [id];
    for (const k of allowed) {
      if (b[k] === undefined) continue;
      let v = b[k];
      if (k === 'body') checkTemplate(String(v));
      if (k === 'audience') v = { ...c.audience, ...v, csv: c.audience.csv ?? null }; // csv info is only changed via upload
      if (k === 'number_ids') v = (v as unknown[]).map(Number).filter(Number.isFinite);
      if (k === 'number_rule') v = v === null ? null : JSON.stringify(cleanRule(v));
      if (k === 'schedule') {
        try { v = JSON.stringify(cleanSchedule(v, localDay(new Date()))); } catch (e) { throw new BadRequestException((e as Error).message); }
      }
      if (k === 'recipient_mode' && !['primary', 'father', 'mother', 'both', 'student', 'all'].includes(String(v))) continue;
      if (k.endsWith('_ms') || k.startsWith('burst_')) v = Math.max(0, Math.round(Number(v) || 0));
      vals.push(k === 'audience' ? JSON.stringify(v) : v);
      sets.push(`${k} = $${vals.length}`);
    }
    if (b.delay_min_ms !== undefined && b.delay_max_ms !== undefined && Number(b.delay_max_ms) < Number(b.delay_min_ms)) {
      throw new BadRequestException('Maximum delay must be ≥ minimum delay');
    }
    if (sets.length) await this.db.query(`update campaigns set ${sets.join(', ')} where id = $1`, vals);
    return this.get(id);
  }

  async remove(id: number) {
    const c = await this.get(id);
    if (['running', 'paused'].includes(c.status)) throw new BadRequestException('Cancel the campaign before deleting it');
    await this.db.query('delete from campaigns where id=$1', [id]);
    return { ok: true };
  }

  async duplicate(id: number) {
    const c = await this.get(id);
    const copy = await this.db.one<Campaign>(
      `insert into campaigns(name, kind, body, media_id, audience, recipient_mode, per_child, number_ids, delay_min_ms, delay_max_ms,
         burst_min, burst_max, burst_pause_min_ms, burst_pause_max_ms, typing, respect_quiet_hours, message_type, number_rule, override_opt_out, schedule)
       select name || ' (copy)', kind, body, media_id, audience - 'csv' - 'dateMatch', recipient_mode, per_child, number_ids, delay_min_ms, delay_max_ms,
         burst_min, burst_max, burst_pause_min_ms, burst_pause_max_ms, typing, respect_quiet_hours, message_type, number_rule, override_opt_out,
         case when schedule->>'mode' = 'spread' then null else schedule end
       from campaigns where id=$1 returning *`, [c.id]);
    return copy;
  }

  // ---------- CSV ----------
  async uploadCsv(id: number, file: Express.Multer.File | undefined, keyColumn?: string) {
    const c = await this.get(id);
    if (c.status !== 'draft') throw new BadRequestException('CSV can only be changed on a draft campaign');
    if (!file) throw new BadRequestException('CSV file is required');
    const rows = parseCsv(file.buffer);
    if (!rows.length) throw new BadRequestException('CSV is empty');
    const columns = Object.keys(rows[0]);
    const norm = (h: string) => h.toLowerCase().replace(/[\s_.-]+/g, '');
    const admCol = keyColumn && columns.includes(keyColumn) ? keyColumn : columns.find((h) => /^(admission(no|number)?|admno|adm|admissionid)$/.test(norm(h)));
    const phoneCol = columns.find((h) => /^(phone|mobile|number|whatsapp|mobileno|phoneno|contact)$/.test(norm(h)));
    const key = admCol ?? phoneCol;
    if (!key) throw new BadRequestException(`CSV needs an "Admission No" (or "Phone") column. Found: ${columns.join(', ')}`);
    const keyType: 'admission' | 'phone' = key === admCol ? 'admission' : 'phone';
    const nameCol = columns.find((h) => /^(name|fullname|contactname|parentname)$/.test(norm(h))) ?? null;

    const students = keyType === 'admission' ? await this.db.query<{ id: number; admission_no: string }>('select id, admission_no from students where active') : [];
    const byAdm = new Map(students.map((s) => [stripZeros(s.admission_no), s.id]));

    let matched = 0;
    const unmatchedSamples: string[] = [];
    await this.db.tx(async (tx) => {
      await tx.query('delete from campaign_rows where campaign_id=$1', [id]);
      let i = 0;
      for (const r of rows) {
        i++;
        const kv = String(r[key] ?? '').trim();
        let studentId: number | null = null, ok = false;
        if (keyType === 'admission') { studentId = byAdm.get(stripZeros(kv)) ?? null; ok = studentId !== null; }
        else ok = !!normalizePhone(kv);
        if (ok) matched++; else if (unmatchedSamples.length < 20) unmatchedSamples.push(`row ${i + 1}: ${kv || '(empty)'}`);
        await tx.query('insert into campaign_rows(campaign_id, row_no, key_value, data, student_id, matched) values ($1,$2,$3,$4,$5,$6)',
          [id, i, kv, r, studentId, ok]);
      }
    });
    const info: CsvInfo = {
      filename: file.originalname, keyColumn: key, keyType, nameColumn: nameCol, columns,
      variables: columns.map(varName).filter(Boolean), rows: rows.length, matched, unmatched: rows.length - matched,
    };
    await this.db.query(`update campaigns set audience = jsonb_set(audience, '{csv}', $2::jsonb) where id=$1`, [id, JSON.stringify(info)]);
    return { ...info, unmatchedSamples };
  }

  async removeCsv(id: number) {
    await this.db.query('delete from campaign_rows where campaign_id=$1', [id]);
    await this.db.query(`update campaigns set audience = audience - 'csv' where id=$1 and status='draft'`, [id]);
    return this.get(id);
  }

  // ---------- audience ----------
  private async resolve(c: Campaign): Promise<{ recipients: Recipient[]; fixed?: { numberId: number }[]; noNumber: number; studentsCount: number; contactsCount: number; breakdown?: { label: string; n: number; fallback?: boolean }[]; rule?: string }> {
    const s = await this.settings.get();
    if (c.kind === 'wa_groups') {
      const targets = c.audience.waGroups ?? [];
      return {
        recipients: targets.map((t) => ({ phone: '', chatId: t.chatId, display: t.subject ?? t.chatId, vars: { group_name: t.subject ?? '' }, childIndex: 0 })),
        fixed: targets.map((t) => ({ numberId: t.numberId })),
        noNumber: 0, studentsCount: 0, contactsCount: 0,
      };
    }
    const csv = c.audience.csv;
    let students: StudentRow[] = [];
    let contacts: ContactRow[] = [];
    let people: Awaited<ReturnType<PeopleService['audience']>> | null = null;
    const type = s.messageTypes.find((t) => t.key === c.message_type) ?? null;
    if (csv?.keyType === 'admission') {
      students = await this.db.query<StudentRow>(
        `select s.*, r.data as csv from campaign_rows r join students s on s.id = r.student_id where r.campaign_id=$1 and r.matched order by r.row_no`, [c.id]);
      // If several CSV rows point to the same student keep the first
      const seen = new Set<number>();
      students = students.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)));
    } else if (csv?.keyType === 'phone') {
      const rows = await this.db.query<{ id: number; key_value: string; data: Record<string, string> }>(
        'select id, key_value, data from campaign_rows where campaign_id=$1 and matched order by row_no', [c.id]);
      contacts = rows.map((r) => ({ id: r.id, name: csv.nameColumn ? r.data[csv.nameColumn] : null, phone: normalizePhone(r.key_value)!, csv: r.data }));
    } else {
      const ids = c.audience.groupIds ?? [];
      if (!ids.length && c.audience.dateMatch?.source === 'birthday') {
        students = await this.db.query<StudentRow>(`select s.* from students s where s.active and s.dob is not null order by s.program, s.section, s.student_name`);
      } else if (ids.length) {
        students = await this.db.query<StudentRow>(
          `select s.* from students s join contact_groups g on g.id = s.group_id
           where s.active and (g.id = any($1) or g.parent_id = any($1)) order by s.program, s.section, s.student_name`, [ids]);
        people = await this.people.audience(ids, c.message_type ?? '', c.number_rule, type?.rule ?? null);
        contacts = people.contacts;
      }
    }
    const dm = c.audience.dateMatch;
    if (dm) {
      // Date-based run: keep only people whose date (+ the step's offset) is the run day
      if (dm.source === 'birthday') {
        students = students.filter((x) => x.dob && dateMatches(x.dob, dm.target, true))
          .map((x) => ({ ...x, csv: { ...(x.csv ?? {}), age: String(Number(dm.target.slice(0, 4)) - Number(x.dob!.slice(0, 4))), birthday: fmtDay(x.dob!) } }));
        contacts = [];
      } else {
        students = [];
        contacts = contacts.filter((x) => { const d = parseDate(x.extra?.[dm.column!]); return !!d && dateMatches(d, dm.target, dm.yearly); })
          .map((x) => ({ ...x, csv: { ...(x.csv ?? {}), date: fmtDay(parseDate(x.extra?.[dm.column!])!), days_left: String(Math.max(0, -dm.offset)) } }));
      }
    }
    const st = studentRecipients(students, c.recipient_mode, s.primaryParent, c.per_child);
    const stPhones = new Set(st.recipients.map((x) => x.phone));
    const ct = contactRecipients(contacts).filter((r) => !stPhones.has(r.phone));
    // Which numbers were used: Father 612 · Mother 41 · Work 30 · Personal (fallback) 3
    const tally = new Map<string, { label: string; n: number; fallback?: boolean }>();
    for (const r of st.recipients) { const k = `${r.label}|false`; tally.set(k, { label: r.label ?? '', n: (tally.get(k)?.n ?? 0) + 1 }); }
    for (const b of dm ? [] : people?.breakdown ?? []) { const k = `${b.label}|${!!b.fallback}`; const t = tally.get(k); tally.set(k, t ? { ...t, n: t.n + b.n } : { ...b }); }
    return {
      recipients: [...st.recipients, ...ct], noNumber: st.noNumber.length + (dm ? 0 : people?.noNumber ?? 0),
      studentsCount: students.length, contactsCount: people && !dm ? people.people : contacts.length,
      breakdown: [...tally.values()].filter((t) => t.label).sort((a, b) => b.n - a.n),
      rule: c.number_rule ? describeRule(c.number_rule) : undefined,
    };
  }

  /** WhatsApp-group targets this campaign's numbers are not allowed to post into (admins-only groups / communities). */
  private async blockedTargets(c: Campaign): Promise<Set<string>> {
    const blocked = new Set<string>();
    if (c.kind !== 'wa_groups') return blocked;
    const byNumber = new Map<number, string[]>();
    for (const t of c.audience.waGroups ?? []) byNumber.set(t.numberId, [...(byNumber.get(t.numberId) ?? []), t.chatId]);
    for (const [numberId, chatIds] of byNumber) {
      const allowed = await this.numbers.checkPostRights(numberId, chatIds).catch(() => new Map<string, boolean>());
      for (const chatId of chatIds) if (allowed.get(chatId) === false) blocked.add(`${numberId}:${chatId}`);
    }
    return blocked;
  }

  async preview(id: number, limit = 5) {
    const c = await this.get(id);
    const r = await this.resolve(c);
    const blocked = await this.blockedTargets(c);
    const notAdmin = (c.audience.waGroups ?? []).filter((t) => blocked.has(`${t.numberId}:${t.chatId}`)).map((t) => t.subject ?? t.chatId);
    const opted = new Set((await this.db.query<{ phone: string }>('select phone from opt_outs')).map((x) => x.phone));
    const optedOut = r.recipients.filter((x) => x.phone && opted.has(x.phone)).length;
    const samples = r.recipients.slice(0, limit).map((x) => ({
      to: x.display, phone: x.phone, text: c.body ? safeRender(c.body, x.vars) : '',
    }));
    const numbers = (await this.numbers.list()).filter((n) =>
      c.kind === 'wa_groups' ? (c.audience.waGroups ?? []).some((g) => g.numberId === n.id) : c.number_ids.includes(n.id));
    const est = estimate(r.recipients.length - (c.override_opt_out ? 0 : optedOut), numbers.map((n) => ({ remaining: n.remaining_today })), c, c.body.length || 160);
    return {
      recipients: r.recipients.length, optedOut, overrideOptOut: c.override_opt_out, breakdown: r.breakdown ?? [],
      notAdmin, noNumber: r.noNumber, students: r.studentsCount, contacts: r.contactsCount,
      csv: c.audience.csv ?? null, samples, estimate: est,
      numbers: numbers.map((n) => ({ id: n.id, label: n.label, status: n.status, paused: n.paused, remaining_today: n.remaining_today })),
    };
  }

  // ---------- lifecycle ----------
  async launch(id: number, confirmOptOutOverride = false) {
    const c = await this.get(id);
    if (c.status !== 'draft') throw new BadRequestException('Only draft campaigns can be launched');
    if (isTemplate(c)) return this.activate(c);
    if (!c.body.trim() && !c.media_id) throw new BadRequestException('Add a message or an attachment');
    for (const v of variants(c.body)) checkTemplate(v);
    if (c.kind === 'contacts' && !c.number_ids.length) throw new BadRequestException('Select at least one WhatsApp number to send from');
    const known = new Set((await this.db.query<{ id: number }>('select id from wa_numbers')).map((n) => n.id));
    if (c.number_ids.some((n) => !known.has(n))) throw new BadRequestException('A selected number no longer exists');

    const r = await this.resolve(c);
    if (!r.recipients.length) throw new BadRequestException('This campaign has no recipients');
    const opted = new Set((await this.db.query<{ phone: string }>('select phone from opt_outs')).map((x) => x.phone));
    const blocked = await this.blockedTargets(c);
    const optedIn = r.recipients.filter((x) => x.phone && opted.has(x.phone)).length;
    if (c.override_opt_out && optedIn && !confirmOptOutOverride) {
      throw new BadRequestException(`${optedIn} recipients replied STOP. Confirm that this emergency message should reach them too.`);
    }

    await this.db.tx(async (tx) => {
      let i = 0;
      for (const rec of r.recipients) {
        const fixed = r.fixed?.[i]?.numberId ?? null;
        i++;
        const isOpted = !!rec.phone && opted.has(rec.phone) && !c.override_opt_out;
        if (fixed !== null && blocked.has(`${fixed}:${rec.chatId}`)) {
          await tx.query(
            `insert into messages(campaign_id, number_id, fixed_number, chat_id, recipient, body, media_id, status, error) values ($1,$2,true,$3,$4,'',$5,'skipped',$6)`,
            [c.id, fixed, rec.chatId, rec.display, c.media_id, 'Not an admin — only admins can post in this group or community']);
          continue;
        }
        // Versions separated by "===" are shared out evenly across recipients
        const versions = variants(c.body);
        const body = c.body ? safeRender(versions[(i - 1) % versions.length], rec.vars) : '';
        // Spread-out campaigns start at their start time; several per-child messages to one parent are 3 minutes apart
        const start = c.schedule?.mode === 'spread' ? Math.max(Date.now(), Date.parse(c.schedule.startAt)) : Date.now();
        const notBefore = rec.childIndex > 0 || start > Date.now() ? new Date(start + rec.childIndex * 180_000) : null;
        await tx.query(
          `insert into messages(campaign_id, number_id, fixed_number, chat_id, phone, recipient, body, media_id, status, error, not_before, phone_label, ignore_opt_out)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [c.id, fixed, fixed !== null, rec.chatId, rec.phone || null, rec.display, body, c.media_id,
           isOpted ? 'skipped' : 'queued', isOpted ? 'Opted out' : null, notBefore, rec.label ?? null, c.override_opt_out],
        );
      }
      await tx.query(`update campaigns set status='running', started_at=now() where id=$1`, [c.id]);
    });
    await this.refreshCounters(c.id);
    await this.db.event('campaign', `Campaign "${c.name}" launched (${r.recipients.length} recipients)`);
    if (c.override_opt_out && optedIn) {
      await this.db.event('campaign', `Emergency campaign "${c.name}" also sent to ${optedIn} people who had replied STOP`, 'warn');
    }
    return this.detail(c.id);
  }

  async setStatus(id: number, to: 'paused' | 'running' | 'cancelled') {
    const c = await this.get(id);
    if (isTemplate(c)) return this.setScheduleStatus(c, to);
    const allowed: Record<string, string[]> = { paused: ['running'], running: ['paused'], cancelled: ['running', 'paused'] };
    if (!allowed[to].includes(c.status)) throw new BadRequestException(`Cannot change a ${c.status} campaign to ${to}`);
    await this.db.query('update campaigns set status=$2 where id=$1', [id, to]);
    if (to === 'cancelled') {
      await this.db.query(`update messages set status='skipped', error='Campaign cancelled' where campaign_id=$1 and status='queued'`, [id]);
      await this.db.query('update campaigns set finished_at=now() where id=$1', [id]);
      await this.refreshCounters(id);
    }
    await this.db.event('campaign', `Campaign "${c.name}" ${to}`);
    return this.detail(id);
  }

  // ---------- schedules (repeating & date-based) ----------
  async holidays(): Promise<Set<string>> {
    const rows = await this.db.query<{ day: string }>('select day from holidays');
    return new Set([...rows.map((r) => r.day), ...(await this.settings.get()).holidays]);
  }

  /** Repeating / date-based: checks the setup and starts the schedule. Each occurrence becomes its own run. */
  private async activate(c: Campaign) {
    const s = c.schedule as RepeatSchedule | DatedSchedule;
    const bodies = s.mode === 'dated' ? s.steps.map((x) => x.body || c.body) : variants(c.body);
    if (bodies.some((b) => !b.trim()) && !c.media_id) throw new BadRequestException(s.mode === 'dated' ? 'Every step needs a message' : 'Add a message or an attachment');
    for (const b of bodies) { try { checkTemplate(b); } catch (e) { throw new BadRequestException((e as Error).message); } }
    if (c.kind === 'contacts' && !c.number_ids.length) throw new BadRequestException('Select at least one WhatsApp number to send from');
    const a = c.audience;
    const hasAudience = c.kind === 'wa_groups' ? !!a.waGroups?.length : !!a.groupIds?.length || !!a.csv || (s.mode === 'dated' && s.source.type === 'birthday');
    if (!hasAudience) throw new BadRequestException('Choose who receives it');
    if (s.mode === 'dated' && s.source.type === 'column' && !a.groupIds?.length) throw new BadRequestException('Choose the lists that have the date column');
    const next = nextRunAt(s, new Date(), await this.holidays(), c.runs);
    if (!next) throw new BadRequestException('This schedule has no future runs — check the start and end dates');
    await this.db.query(`update campaigns set status='scheduled', started_at=coalesce(started_at, now()), next_run_at=$2 where id=$1`, [c.id, next]);
    await this.db.event('campaign', `Schedule "${c.name}" activated — first run ${next.toISOString()}`);
    return this.detail(c.id);
  }

  private async setScheduleStatus(c: Campaign, to: 'paused' | 'running' | 'cancelled') {
    if (to === 'paused') {
      if (c.status !== 'scheduled') throw new BadRequestException('Only an active schedule can be paused');
      await this.db.query(`update campaigns set status='paused', next_run_at=null where id=$1`, [c.id]);
    } else if (to === 'running') {
      if (c.status !== 'paused') throw new BadRequestException('Only a paused schedule can be resumed');
      const next = nextRunAt(c.schedule as RepeatSchedule | DatedSchedule, new Date(), await this.holidays(), c.runs);
      await this.db.query(`update campaigns set status=$2, next_run_at=$3, finished_at=case when $3::timestamptz is null then now() end where id=$1`,
        [c.id, next ? 'scheduled' : 'completed', next]);
    } else {
      if (!['scheduled', 'paused'].includes(c.status)) throw new BadRequestException('This schedule has already ended');
      await this.db.query(`update campaigns set status='completed', next_run_at=null, finished_at=now() where id=$1`, [c.id]);
    }
    await this.db.event('campaign', `Schedule "${c.name}" ${to === 'running' ? 'resumed' : to === 'paused' ? 'paused' : 'ended'}`);
    return this.detail(c.id);
  }

  /** Back to draft so the schedule can be edited (runs so far are kept). */
  async unschedule(id: number) {
    const c = await this.get(id);
    if (!isTemplate(c) || !['scheduled', 'paused'].includes(c.status)) throw new BadRequestException('Only an active or paused schedule can be edited');
    await this.db.query(`update campaigns set status='draft', next_run_at=null where id=$1`, [c.id]);
    return this.get(id);
  }

  /**
   * Creates and launches one run of a schedule for `day`. Date-based schedules make one run per step that has recipients.
   * Returns the runs that were started.
   */
  async createRuns(t: Campaign, day: string): Promise<{ id: number; total: number; label: string }[]> {
    const s = t.schedule as RepeatSchedule | DatedSchedule;
    const jobs: { body: string; label: string; dateMatch?: DateMatch }[] = s.mode === 'dated'
      ? s.steps.map((st) => ({
          body: st.body || t.body, label: offsetLabel(st.offset),
          dateMatch: {
            source: s.source.type, column: s.source.type === 'column' ? s.source.column : undefined,
            yearly: s.source.type === 'birthday' || (s.source.type === 'column' && s.source.yearly), target: addDays(day, -st.offset), offset: st.offset,
          },
        }))
      : [{ body: (() => { const v = variants(t.body); return v[t.runs % v.length]; })(), label: '' }];
    const out: { id: number; total: number; label: string }[] = [];
    for (const j of jobs) {
      const name = `${t.name} · ${fmtDay(day)}${j.label && jobs.length > 1 ? ` (${j.label})` : ''}`;
      const audience = { ...t.audience, ...(j.dateMatch ? { dateMatch: j.dateMatch } : {}) };
      const child = await this.db.one<{ id: number }>(
        `insert into campaigns(name, kind, body, media_id, audience, recipient_mode, per_child, number_ids, delay_min_ms, delay_max_ms,
           burst_min, burst_max, burst_pause_min_ms, burst_pause_max_ms, typing, respect_quiet_hours, message_type, number_rule, override_opt_out, parent_id, run_day)
         select $2, kind, $3, media_id, $4, recipient_mode, per_child, number_ids, delay_min_ms, delay_max_ms,
           burst_min, burst_max, burst_pause_min_ms, burst_pause_max_ms, typing, respect_quiet_hours, message_type, number_rule, override_opt_out, id, $5
         from campaigns where id=$1 returning id`, [t.id, name, j.body, JSON.stringify(audience), day]);
      if (t.audience.csv) {
        await this.db.query(`insert into campaign_rows(campaign_id, row_no, key_value, data, student_id, matched)
                             select $2, row_no, key_value, data, student_id, matched from campaign_rows where campaign_id=$1`, [t.id, child!.id]);
      }
      try {
        const r = await this.launch(child!.id, true);
        out.push({ id: child!.id, total: r.total, label: j.label });
      } catch (e) {
        await this.db.query('delete from campaigns where id=$1', [child!.id]);
        if (!/no recipients/i.test((e as Error).message)) throw e;
      }
    }
    return out;
  }

  /** What a schedule will do next: upcoming runs, or for spread-out sending the number of days needed. */
  async schedulePreview(id: number) {
    const c = await this.get(id);
    const s = c.schedule;
    if (!s) return { mode: 'now' };
    const holidays = await this.holidays();
    if (s.mode === 'spread') {
      const r = await this.resolve(c).catch(() => null);
      const opted = new Set((await this.db.query<{ phone: string }>('select phone from opt_outs')).map((x) => x.phone));
      const total = r ? r.recipients.filter((x) => c.override_opt_out || !opted.has(x.phone)).length : 0;
      return { mode: 'spread', total, ...spreadPlan(s, total, holidays) };
    }
    const from = c.status === 'scheduled' && c.next_run_at ? new Date(c.next_run_at.getTime() - 1000) : new Date();
    const runs = upcoming(s, from, s.mode === 'dated' ? 31 : 5, holidays, c.runs);
    if (s.mode === 'repeat') return { mode: 'repeat', runs, nextRunAt: c.next_run_at };
    // Date-based: which upcoming days actually have someone to message
    const days: { day: string; at: Date | null; from?: string; to?: string; steps: { label: string; n: number }[] }[] = [];
    for (const r of runs) {
      const steps: { label: string; n: number }[] = [];
      for (const st of s.steps) {
        const dateMatch: DateMatch = {
          source: s.source.type, column: s.source.type === 'column' ? s.source.column : undefined,
          yearly: s.source.type === 'birthday' || (s.source.type === 'column' && s.source.yearly), target: addDays(r.day, -st.offset), offset: st.offset,
        };
        const res = await this.resolve({ ...c, audience: { ...c.audience, dateMatch } });
        if (res.recipients.length) steps.push({ label: offsetLabel(st.offset), n: res.recipients.length });
      }
      if (steps.length) days.push({ ...r, steps });
      if (days.length >= 5) break;
    }
    return { mode: 'dated', days, nextRunAt: c.next_run_at };
  }

  async retryFailed(id: number) {
    const c = await this.get(id);
    const r = await this.db.query(`update messages set status='queued', attempts=0, error=null, number_id = case when fixed_number then number_id else null end
                                   where campaign_id=$1 and status='failed' returning id`, [id]);
    if (r.length && ['completed', 'cancelled'].includes(c.status)) await this.db.query(`update campaigns set status='running', finished_at=null where id=$1`, [id]);
    await this.refreshCounters(id);
    return { requeued: r.length };
  }

  messages(id: number, status?: string, q?: string, offset = 0) {
    return this.db.query(
      `select m.id, m.recipient, m.phone, m.phone_label, m.chat_id, m.status, m.error, m.attempts, m.sent_at, m.ack_at, n.label as number_label, left(m.body, 300) as body
       from messages m left join wa_numbers n on n.id = m.number_id
       where m.campaign_id=$1 and ($2::text is null or m.status=$2) and ($3::text is null or m.recipient ilike '%'||$3||'%' or m.phone like '%'||$3||'%')
       order by m.id limit 200 offset $4`, [id, status || null, q || null, offset]);
  }

  async refreshCounters(id: number) {
    await this.db.query(`
      update campaigns c set
        total = s.total, sent = s.sent, delivered = s.delivered, read = s.read, failed = s.failed, skipped = s.skipped
      from (select count(*)::int total,
                   count(*) filter (where status in ('sent','delivered','read'))::int sent,
                   count(*) filter (where status in ('delivered','read'))::int delivered,
                   count(*) filter (where status = 'read')::int read,
                   count(*) filter (where status = 'failed')::int failed,
                   count(*) filter (where status = 'skipped')::int skipped
            from messages where campaign_id = $1) s
      where c.id = $1`, [id]);
  }

  /** Sends one message to a single phone immediately (test before launching). */
  async testSend(id: number, phone: string, numberId: number) {
    const c = await this.get(id);
    const p = normalizePhone(phone);
    if (!p) throw new BadRequestException('Invalid phone number');
    const r = await this.resolve(c);
    const vars = r.recipients[0]?.vars ?? {};
    const body = `${c.body ? safeRender(c.body, vars) : ''}`;
    const m = await this.db.one<{ id: number }>(
      `insert into messages(campaign_id, number_id, fixed_number, chat_id, phone, recipient, body, media_id, priority)
       values (null,$1,true,$2,$3,$4,$5,$6,100) returning id`, [numberId, toChatId(p), p, `Test: ${c.name}`, body, c.media_id]);
    return { queued: m!.id };
  }
}

function safeRender(body: string, vars: Record<string, unknown>) {
  try { return renderMessage(body, vars); } catch (e) { throw new BadRequestException((e as Error).message); }
}
