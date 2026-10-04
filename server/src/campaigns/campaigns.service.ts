import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { NumbersService } from '../numbers/numbers.service';
import { parseCsv } from '../contacts/contacts.controller';
import { normalizePhone, toChatId } from '../common/phone';
import { checkTemplate, contactRecipients, ContactRow, Recipient, RecipientMode, renderMessage, StudentRow, studentRecipients, varName } from './render';
import { estimate } from './estimate';

export interface Campaign {
  id: number; name: string; kind: 'contacts' | 'wa_groups'; status: string; body: string; media_id: number | null;
  audience: { groupIds?: number[]; csv?: CsvInfo | null; waGroups?: { numberId: number; chatId: string; subject?: string }[] };
  recipient_mode: RecipientMode; per_child: boolean; number_ids: number[];
  delay_min_ms: number; delay_max_ms: number; burst_min: number; burst_max: number; burst_pause_min_ms: number; burst_pause_max_ms: number;
  typing: boolean; respect_quiet_hours: boolean;
  total: number; sent: number; delivered: number; read: number; failed: number; skipped: number;
  created_at: Date; started_at: Date | null; finished_at: Date | null;
}
interface CsvInfo { filename: string; keyColumn: string; keyType: 'admission' | 'phone'; nameColumn?: string | null; columns: string[]; variables: string[]; rows: number; matched: number; unmatched: number }

const EDITABLE = ['name', 'body', 'media_id', 'recipient_mode', 'per_child', 'number_ids', 'delay_min_ms', 'delay_max_ms', 'burst_min', 'burst_max',
  'burst_pause_min_ms', 'burst_pause_max_ms', 'typing', 'respect_quiet_hours', 'audience'] as const;
const SPEED_FIELDS = ['delay_min_ms', 'delay_max_ms', 'burst_min', 'burst_max', 'burst_pause_min_ms', 'burst_pause_max_ms', 'typing', 'respect_quiet_hours', 'number_ids'];
const stripZeros = (s: string) => String(s ?? '').trim().replace(/^0+(?=\d)/, '');

@Injectable()
export class CampaignsService {
  constructor(private readonly db: Db, private readonly settings: SettingsService, private readonly numbers: NumbersService) {}

  list() {
    return this.db.query(`select id, name, kind, status, total, sent, delivered, read, failed, skipped, created_at, started_at, finished_at
                          from campaigns order by id desc limit 300`);
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
    return { ...c, byNumber, queued: queued?.n ?? 0 };
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
    return row;
  }

  async update(id: number, b: Record<string, any>) {
    const c = await this.get(id);
    const allowed: readonly string[] = c.status === 'draft' ? EDITABLE : ['running', 'paused'].includes(c.status) ? SPEED_FIELDS : [];
    if (!allowed.length) throw new BadRequestException(`A ${c.status} campaign cannot be edited`);
    const sets: string[] = [], vals: unknown[] = [id];
    for (const k of allowed) {
      if (b[k] === undefined) continue;
      let v = b[k];
      if (k === 'body') checkTemplate(String(v));
      if (k === 'audience') v = { ...c.audience, ...v, csv: c.audience.csv ?? null }; // csv info is only changed via upload
      if (k === 'number_ids') v = (v as unknown[]).map(Number).filter(Number.isFinite);
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
         burst_min, burst_max, burst_pause_min_ms, burst_pause_max_ms, typing, respect_quiet_hours)
       select name || ' (copy)', kind, body, media_id, audience - 'csv', recipient_mode, per_child, number_ids, delay_min_ms, delay_max_ms,
         burst_min, burst_max, burst_pause_min_ms, burst_pause_max_ms, typing, respect_quiet_hours from campaigns where id=$1 returning *`, [c.id]);
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
  private async resolve(c: Campaign): Promise<{ recipients: Recipient[]; fixed?: { numberId: number }[]; noNumber: number; studentsCount: number; contactsCount: number }> {
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
      if (ids.length) {
        students = await this.db.query<StudentRow>(
          `select s.* from students s join contact_groups g on g.id = s.group_id
           where s.active and (g.id = any($1) or g.parent_id = any($1)) order by s.program, s.section, s.student_name`, [ids]);
        contacts = await this.db.query<ContactRow>(
          `select c.* from contacts c join contact_groups g on g.id = c.group_id where g.id = any($1) or g.parent_id = any($1) order by c.id`, [ids]);
      }
    }
    const st = studentRecipients(students, c.recipient_mode, s.primaryParent, c.per_child);
    const ct = contactRecipients(contacts).filter((r) => !st.recipients.some((x) => x.phone === r.phone));
    return { recipients: [...st.recipients, ...ct], noNumber: st.noNumber.length, studentsCount: students.length, contactsCount: contacts.length };
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
    const est = estimate(r.recipients.length - optedOut, numbers.map((n) => ({ remaining: n.remaining_today })), c, c.body.length || 160);
    return {
      recipients: r.recipients.length, optedOut, notAdmin, noNumber: r.noNumber, students: r.studentsCount, contacts: r.contactsCount,
      csv: c.audience.csv ?? null, samples, estimate: est,
      numbers: numbers.map((n) => ({ id: n.id, label: n.label, status: n.status, paused: n.paused, remaining_today: n.remaining_today })),
    };
  }

  // ---------- lifecycle ----------
  async launch(id: number) {
    const c = await this.get(id);
    if (c.status !== 'draft') throw new BadRequestException('Only draft campaigns can be launched');
    if (!c.body.trim() && !c.media_id) throw new BadRequestException('Add a message or an attachment');
    checkTemplate(c.body);
    if (c.kind === 'contacts' && !c.number_ids.length) throw new BadRequestException('Select at least one WhatsApp number to send from');
    const known = new Set((await this.db.query<{ id: number }>('select id from wa_numbers')).map((n) => n.id));
    if (c.number_ids.some((n) => !known.has(n))) throw new BadRequestException('A selected number no longer exists');

    const r = await this.resolve(c);
    if (!r.recipients.length) throw new BadRequestException('This campaign has no recipients');
    const opted = new Set((await this.db.query<{ phone: string }>('select phone from opt_outs')).map((x) => x.phone));
    const blocked = await this.blockedTargets(c);

    await this.db.tx(async (tx) => {
      let i = 0;
      for (const rec of r.recipients) {
        const fixed = r.fixed?.[i]?.numberId ?? null;
        i++;
        const isOpted = !!rec.phone && opted.has(rec.phone);
        if (fixed !== null && blocked.has(`${fixed}:${rec.chatId}`)) {
          await tx.query(
            `insert into messages(campaign_id, number_id, fixed_number, chat_id, recipient, body, media_id, status, error) values ($1,$2,true,$3,$4,'',$5,'skipped',$6)`,
            [c.id, fixed, rec.chatId, rec.display, c.media_id, 'Not an admin — only admins can post in this group or community']);
          continue;
        }
        const body = c.body ? safeRender(c.body, rec.vars) : '';
        // Space out several per-child messages to the same parent by 3 minutes each
        const notBefore = rec.childIndex > 0 ? new Date(Date.now() + rec.childIndex * 180_000) : null;
        await tx.query(
          `insert into messages(campaign_id, number_id, fixed_number, chat_id, phone, recipient, body, media_id, status, error, not_before)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [c.id, fixed, fixed !== null, rec.chatId, rec.phone || null, rec.display, body, c.media_id,
           isOpted ? 'skipped' : 'queued', isOpted ? 'Opted out' : null, notBefore],
        );
      }
      await tx.query(`update campaigns set status='running', started_at=now() where id=$1`, [c.id]);
    });
    await this.refreshCounters(c.id);
    await this.db.event('campaign', `Campaign "${c.name}" launched (${r.recipients.length} recipients)`);
    return this.detail(c.id);
  }

  async setStatus(id: number, to: 'paused' | 'running' | 'cancelled') {
    const c = await this.get(id);
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
      `select m.id, m.recipient, m.phone, m.chat_id, m.status, m.error, m.attempts, m.sent_at, m.ack_at, n.label as number_label, left(m.body, 300) as body
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
