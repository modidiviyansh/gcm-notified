import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Post } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Db } from '../db/db.service';
import { frappeConfigured } from '../config';
import { FrappeAccessError, FrappeSyncService } from '../contacts/frappe-sync.service';
import { SettingsService } from '../settings/settings.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { checkTemplate, phonesFor, renderMessage, StudentRow, studentRecipients } from '../campaigns/render';
import { buildFees, buildMarks, fmtDate, rupees, StudentVars } from './build';
import { localDay } from '../campaigns/schedule';

type Kind = 'marks' | 'fees';
const TYPE: Record<Kind, 'academic' | 'fees'> = { marks: 'academic', fees: 'fees' };

interface Fetched {
  kind: Kind; ref: string; label: string; at: number;
  data: Map<number, StudentVars>;            // local student id → variables
}
interface FetchBody { kind: Kind; year?: string; exam?: string; groupIds?: number[]; dueBy?: string | null; minAmount?: number }

/**
 * 1-Click notifications: fetch marks / pending fees from Frappe, review who gets what, send.
 * A fetch is kept for 30 minutes so the send uses exactly the data that was reviewed.
 */
@Injectable()
export class OneClickService {
  private fetched = new Map<string, Fetched>();

  constructor(
    private readonly db: Db, private readonly frappe: FrappeSyncService, private readonly settings: SettingsService, private readonly campaigns: CampaignsService,
  ) {}

  private async frappeGet<T>(doctype: string, fields: string[], filters?: unknown[]): Promise<T[]> {
    if (!frappeConfigured()) throw new BadRequestException('Frappe is not configured (FRAPPE_URL / FRAPPE_API_KEY / FRAPPE_API_SECRET)');
    try { return await this.frappe.get<T>(doctype, fields, filters); } catch (e) {
      throw new BadRequestException(e instanceof FrappeAccessError
        ? `GCM Notified can't read "${e.doctype}" in Frappe yet. Ask the Frappe admin to give the API user's role read permission on ${e.doctype}.`
        : (e as Error).message);
    }
  }

  /** Exams with results in Frappe (newest year first), for the picker. */
  async exams() {
    const rows = await this.frappeGet<{ academic_year: string; assessment_group: string; student: string }>(
      'Assessment Result', ['academic_year', 'assessment_group', 'student'], [['docstatus', '=', 1]]);
    const by = new Map<string, { year: string; exam: string; students: Set<string>; results: number }>();
    for (const r of rows) {
      if (!r.assessment_group) continue;
      const k = `${r.academic_year ?? ''}|${r.assessment_group}`;
      const e = by.get(k) ?? { year: r.academic_year ?? '', exam: r.assessment_group, students: new Set(), results: 0 };
      e.students.add(r.student); e.results++; by.set(k, e);
    }
    const sent = new Map((await this.db.query<{ ref: string; n: number; last: Date }>(
      `select ref, count(distinct student_id)::int n, max(created_at) last from oneclick_log where kind='marks' group by ref`)).map((r) => [r.ref, r]));
    return [...by.values()]
      .map((e) => ({ year: e.year, exam: e.exam, students: e.students.size, results: e.results, sent: sent.get(`${e.year}|${e.exam}`) ?? null }))
      .sort((a, b) => b.year.localeCompare(a.year) || a.exam.localeCompare(b.exam));
  }

  /** Fetches from Frappe and returns one row per student with what they would get. */
  async fetch(b: FetchBody) {
    const kind: Kind = b.kind === 'fees' ? 'fees' : 'marks';
    let byFrappe: Map<string, StudentVars>, ref: string, label: string;
    if (kind === 'marks') {
      if (!b.exam) throw new BadRequestException('Choose an exam');
      const filters: unknown[] = [['docstatus', '=', 1], ['assessment_group', '=', b.exam]];
      if (b.year) filters.push(['academic_year', '=', b.year]);
      const rows = await this.frappeGet<any>('Assessment Result',
        ['student', 'course', 'total_score', 'maximum_score', 'grade', 'assessment_group', 'academic_year'], filters);
      byFrappe = buildMarks(rows, b.exam);
      ref = `${b.year ?? ''}|${b.exam}`;
      label = `${b.exam}${b.year ? ` ${b.year}` : ''} marks`;
    } else {
      const rows = await this.frappeGet<any>('Fees',
        ['name', 'student', 'outstanding_amount', 'grand_total', 'due_date', 'academic_term', 'fee_structure', 'fee_schedule', 'posting_date'],
        [['docstatus', '=', 1], ['outstanding_amount', '>', 0]]);
      byFrappe = buildFees(rows, { dueBy: b.dueBy || null, minAmount: Number(b.minAmount) || 0 });
      ref = 'fees';
      label = `Fee reminder${b.dueBy ? ` (due by ${fmtDate(b.dueBy)})` : ''}`;
    }

    // Match to students in the app (synced from Frappe), optionally only some classes
    const ids = (b.groupIds ?? []).map(Number).filter(Number.isFinite);
    const students = await this.db.query<StudentRow & { frappe_id: string }>(
      `select s.* from students s join contact_groups g on g.id = s.group_id
       where s.active and s.frappe_id = any($1) and (cardinality($2::int[]) = 0 or g.id = any($2) or g.parent_id = any($2))
       order by s.program, s.section, s.student_name`, [[...byFrappe.keys()], ids]);
    const notInApp = ids.length ? 0 : byFrappe.size - students.length;

    const s = await this.settings.get();
    const type = await this.settings.builtInType(TYPE[kind]);
    const opted = new Set((await this.db.query<{ phone: string }>('select phone from opt_outs')).map((r) => r.phone));
    const phones = students.flatMap((x) => [x.father_phone, x.mother_phone, x.student_phone]).filter(Boolean) as string[];
    const wa = new Map((await this.db.query<{ phone: string; on_whatsapp: boolean }>('select phone, on_whatsapp from phone_checks where phone = any($1)', [phones])).map((r) => [r.phone, r.on_whatsapp]));
    const last = new Map((await this.db.query<{ student_id: number; created_at: Date; summary: string }>(
      `select distinct on (student_id) student_id, created_at, summary from oneclick_log where kind=$1 and ref=$2 order by student_id, created_at desc`,
      [kind, ref])).map((r) => [r.student_id, r]));

    const data = new Map<number, StudentVars>();
    const recentDays = kind === 'fees' ? 3 : 3650;
    const rows = students.map((st) => {
      const v = byFrappe.get(st.frappe_id)!;
      data.set(st.id, v);
      const to = phonesFor(st, type.school, s.primaryParent).map((p) => ({
        relation: p.relation, phone: p.phone, optedOut: opted.has(p.phone), wa: wa.get(p.phone) ?? null,
      }));
      const reachable = to.filter((p) => !p.optedOut && p.wa !== false);
      const status = !to.length ? 'no_number' : !reachable.length ? (to.every((p) => p.optedOut) ? 'opted_out' : 'not_on_whatsapp') : 'ready';
      const prev = last.get(st.id) ?? null;
      const recently = !!prev && Date.now() - prev.created_at.getTime() < recentDays * 86_400_000;
      return {
        id: st.id, name: st.student_name, admission_no: st.admission_no, class: st.program, section: st.section,
        summary: v.summary, to, status, lastSent: prev ? { at: prev.created_at, summary: prev.summary } : null,
        selected: status === 'ready' && !recently,
      };
    });

    const fetchId = randomBytes(9).toString('base64url');
    this.prune();
    this.fetched.set(fetchId, { kind, ref, label, at: Date.now(), data });
    const total = kind === 'fees' ? rupees([...data.values()].reduce((a, x) => a + Number(x.vars.amount_number), 0)) : null;
    return {
      fetchId, kind, label, fetchedAt: new Date(), rows, notInApp, total,
      type: { key: type.key, name: type.name, icon: type.icon, school: type.school },
      template: s.oneClick[kind].template,
    };
  }

  private prune() {
    for (const [k, f] of this.fetched) if (Date.now() - f.at > 30 * 60_000) this.fetched.delete(k);
  }
  private get(fetchId: string) {
    const f = this.fetched.get(fetchId);
    if (!f) throw new NotFoundException('This list has expired — fetch again from Frappe');
    return f;
  }

  /** The message one student's parent would get. */
  async render(b: { fetchId: string; studentId: number; template: string }) {
    const f = this.get(b.fetchId);
    const v = f.data.get(Number(b.studentId));
    if (!v) throw new NotFoundException('Student not in this list');
    const st = await this.db.one<StudentRow>('select * from students where id=$1', [b.studentId]);
    const s = await this.settings.get();
    const type = await this.settings.builtInType(TYPE[f.kind]);
    const r = studentRecipients([{ ...st!, csv: v.vars as any }], type.school, s.primaryParent, true).recipients[0];
    try { checkTemplate(b.template); } catch (e) { throw new BadRequestException((e as Error).message); }
    // No usable number: still preview with the student's details (the parent name stays empty)
    const vars = r?.vars ?? { student_name: st!.student_name, first_name: st!.student_name.split(/\s+/)[0], admission_no: st!.admission_no,
      class: st!.program ?? '', section: st!.section ?? '', father_name: st!.father_name ?? '', mother_name: st!.mother_name ?? '', parent_name: '', ...v.vars };
    return { to: r?.display ?? `${st!.student_name} (no number)`, text: renderMessage(b.template, vars) };
  }

  /** Creates the campaign (type Academic / Fees), launches it, and remembers who was notified. */
  async send(b: { fetchId: string; studentIds: number[]; template: string; numberIds: number[]; saveTemplate?: boolean }) {
    const f = this.get(b.fetchId);
    const ids = [...new Set((b.studentIds ?? []).map(Number))].filter((id) => f.data.has(id));
    if (!ids.length) throw new BadRequestException('Select at least one student');
    const template = String(b.template ?? '').trim();
    if (!template) throw new BadRequestException('The message is empty');
    try { checkTemplate(template); } catch (e) { throw new BadRequestException((e as Error).message); }
    if (!(b.numberIds ?? []).length) throw new BadRequestException('Choose at least one number to send from');

    if (b.saveTemplate) {
      const s = await this.settings.get();
      await this.settings.update({ oneClick: { ...s.oneClick, [f.kind]: { template } } });
    }
    const type = await this.settings.builtInType(TYPE[f.kind]);
    const known = await this.settings.messageType(type.key);
    const name = `${type.icon} ${f.label} · ${fmtDate(localDay(new Date()))}`;
    const c = await this.campaigns.create({ name, kind: 'contacts' });
    await this.campaigns.update(c!.id, {
      ...(known ? { message_type: type.key } : { recipient_mode: type.school, respect_quiet_hours: type.quietHours }),
      body: template, number_ids: b.numberIds, per_child: true,
    });
    const students = await this.db.query<{ id: number; admission_no: string }>('select id, admission_no from students where id = any($1)', [ids]);
    const columns = [...new Set(students.flatMap((x) => Object.keys(f.data.get(x.id)!.vars)))];
    await this.db.tx(async (tx) => {
      let i = 0;
      for (const st of students) {
        await tx.query('insert into campaign_rows(campaign_id, row_no, key_value, data, student_id, matched) values ($1,$2,$3,$4,$5,true)',
          [c!.id, ++i, st.admission_no, JSON.stringify(f.data.get(st.id)!.vars), st.id]);
      }
      const csv = { filename: `Frappe · ${f.label}`, keyColumn: 'admission_no', keyType: 'admission', nameColumn: null, columns, variables: columns, rows: students.length, matched: students.length, unmatched: 0 };
      await tx.query(`update campaigns set audience = $2 where id=$1`, [c!.id, JSON.stringify({ csv, oneClick: { kind: f.kind, ref: f.ref, label: f.label } })]);
    });
    const launched = await this.campaigns.launch(c!.id, false);
    for (const st of students) {
      await this.db.query('insert into oneclick_log(kind, ref, student_id, campaign_id, summary) values ($1,$2,$3,$4,$5)',
        [f.kind, f.ref, st.id, c!.id, f.data.get(st.id)!.summary]);
    }
    await this.db.event('campaign', `1-Click: ${f.label} sent for ${students.length} students`);
    return { campaignId: c!.id, total: launched.total };
  }

  history() {
    return this.db.query(
      `select id, name, status, total, sent, delivered, read, failed, skipped, created_at, audience->'oneClick'->>'kind' as kind
       from campaigns where audience ? 'oneClick' order by id desc limit 20`);
  }
}

@Controller('oneclick')
export class OneClickController {
  constructor(private readonly oc: OneClickService) {}
  @Get('exams') exams() { return this.oc.exams(); }
  @Post('fetch') fetch(@Body() b: FetchBody) { return this.oc.fetch(b); }
  @Post('render') render(@Body() b: any) { return this.oc.render(b); }
  @Post('send') send(@Body() b: any) { return this.oc.send(b); }
  @Get('history') history() { return this.oc.history(); }
}
