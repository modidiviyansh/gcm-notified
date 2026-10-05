import { readSheet } from '../common/sheet';
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Db } from '../db/db.service';
import { FrappeSyncService } from './frappe-sync.service';
import { normalizePhone } from '../common/phone';
import { detectNameColumn, detectPhoneColumns, NewPerson, parsePaste, PeopleService, PhoneColumn } from './people.service';
import { cleanLabel, cleanRules, COMMON_LABELS, labelForColumn } from './rules';

/** CSV or Excel (.xlsx) → rows keyed by the header row. */
export function parseCsv(buf: Buffer, filename = ''): Record<string, string>[] {
  return readSheet(buf, filename);
}

// A person's numbers as JSON: [{phone, label, is_primary, opted_out}], primary first
const PHONES_JSON = `coalesce((select json_agg(json_build_object('phone', pp.phone, 'label', pp.label, 'is_primary', pp.is_primary,
  'opted_out', pp.phone in (select phone from opt_outs), 'wa', (select on_whatsapp from phone_checks c where c.phone = pp.phone)) order by pp.is_primary desc, pp.id) from person_phones pp where pp.person_id = p.id), '[]')`;

@Controller()
export class ContactsController {
  constructor(private readonly db: Db, private readonly sync: FrappeSyncService, private readonly people: PeopleService) {}

  // ---------- groups ----------
  @Get('groups')
  async tree() {
    const rows = await this.db.query(`
      select g.id, g.parent_id, g.name, g.source, g.sort_order, g.description, g.created_at, g.rules,
        (select count(*)::int from students s where s.group_id = g.id and s.active) as students,
        (select count(*)::int from list_members m where m.group_id = g.id) as contacts
      from contact_groups g order by g.source, g.sort_order, g.name`);
    const byId = new Map<number, any>(rows.map((r) => [r.id, { ...r, children: [] }]));
    const roots: any[] = [];
    for (const g of byId.values()) (g.parent_id && byId.get(g.parent_id) ? byId.get(g.parent_id).children : roots).push(g);
    // A person in a list and one of its sublists counts once
    const people = new Map((await this.db.query<{ root: number; n: number }>(
      `select coalesce(g.parent_id, g.id) as root, count(distinct m.person_id)::int as n
       from list_members m join contact_groups g on g.id = m.group_id group by 1`)).map((r) => [r.root, r.n]));
    for (const r of roots) {
      r.total = r.students + r.children.reduce((a: number, c: any) => a + c.students, 0) + (people.get(r.id) ?? 0);
    }
    return roots;
  }

  @Post('groups')
  async createGroup(@Body() b: { name: string; parent_id?: number | null; description?: string | null }) {
    if (!b.name?.trim()) throw new BadRequestException('Name is required');
    if (b.parent_id) {
      const p = await this.db.one('select source, parent_id from contact_groups where id=$1', [b.parent_id]);
      if (!p) throw new NotFoundException('Parent group not found');
      if (p.source !== 'manual' || p.parent_id) throw new BadRequestException('Subgroups can only be added to a top-level manual group');
    }
    return this.db.one(`insert into contact_groups(name, parent_id, source, description) values ($1,$2,'manual',$3) returning *`,
      [b.name.trim(), b.parent_id ?? null, b.description?.trim() || null]);
  }

  @Put('groups/:id')
  async renameGroup(@Param('id', ParseIntPipe) id: number, @Body() b: { name?: string; description?: string | null }) {
    const g = await this.manualGroup(id);
    return this.db.one('update contact_groups set name=$2, description=$3 where id=$1 returning *',
      [g.id, b.name?.trim() || g.name, b.description === undefined ? g.description : b.description?.trim() || null]);
  }

  /** Number rules of a list: which label to use per message type. Sublists without a rule use their parent's. */
  @Put('groups/:id/rules')
  async setRules(@Param('id', ParseIntPipe) id: number, @Body() b: { rules: unknown }) {
    await this.manualGroup(id);
    return this.db.one('update contact_groups set rules=$2 where id=$1 returning id, rules', [id, JSON.stringify(cleanRules(b.rules))]);
  }

  /** Column names in the given lists (from imported CSVs), for picking a date column. */
  @Get('columns')
  async columns(@Query('groupIds') ids = '') {
    const groupIds = ids.split(',').map(Number).filter(Number.isFinite);
    if (!groupIds.length) return [];
    return (await this.db.query<{ k: string }>(
      `select k, count(*)::int n from list_members m join contact_groups g on g.id = m.group_id, jsonb_object_keys(m.extra) k
       where g.id = any($1) or g.parent_id = any($1) group by k order by n desc, k limit 50`, [groupIds])).map((r) => r.k);
  }

  @Get('labels')
  async labels(@Query('groupId') groupId?: string) {
    return { used: await this.people.labels(groupId ? Number(groupId) : undefined), common: COMMON_LABELS };
  }

  /** Everyone in your own lists, once per person, with their numbers and lists. */
  @Get('contacts')
  allContacts(@Query('q') q = '') {
    return this.db.query(
      `select p.id, p.name, ${PHONES_JSON} as phones,
              (select array_agg(distinct g.name order by g.name) from list_members m join contact_groups g on g.id = m.group_id where m.person_id = p.id) as lists,
              p.created_at
       from people p
       where exists (select 1 from list_members m where m.person_id = p.id)
         and ($1 = '' or p.name ilike $2 or ($3 <> '%%' and exists (select 1 from person_phones x where x.person_id = p.id and x.phone like $3)))
       order by p.name nulls last, p.id limit 2000`,
      [q, `%${q}%`, `%${q.replace(/\D/g, '')}%`]);
  }

  @Delete('groups/:id')
  async deleteGroup(@Param('id', ParseIntPipe) id: number) {
    await this.manualGroup(id);
    await this.db.tx(async (tx) => {
      const ids = (await tx.query<{ person_id: number }>(
        'select distinct person_id from list_members m join contact_groups g on g.id = m.group_id where g.id = $1 or g.parent_id = $1', [id])).rows.map((r) => r.person_id);
      await tx.query('delete from contact_groups where id=$1', [id]);
      await tx.query('delete from people p where p.id = any($1) and not exists (select 1 from list_members m where m.person_id = p.id)', [ids]);
    });
    return { ok: true };
  }

  @Get('groups/:id/members')
  async members(@Param('id', ParseIntPipe) id: number, @Query('q') q = '') {
    const like = `%${q}%`;
    const digits = `%${q.replace(/\D/g, '')}%`;
    const students = await this.db.query(
      `select s.id, s.admission_no, s.student_name, s.program, s.section, s.father_name, s.mother_name, s.father_phone, s.mother_phone,
              (s.father_phone in (select phone from opt_outs)) as father_opted_out, (s.mother_phone in (select phone from opt_outs)) as mother_opted_out,
              (select on_whatsapp from phone_checks c where c.phone = s.father_phone) as father_wa, (select on_whatsapp from phone_checks c where c.phone = s.mother_phone) as mother_wa
       from students s join contact_groups g on g.id = s.group_id
       where s.active and (g.id = $1 or g.parent_id = $1)
         and ($2 = '' or s.student_name ilike $3 or s.admission_no ilike $3 or ($4 <> '%%' and (s.father_phone like $4 or s.mother_phone like $4)))
       order by s.section, s.student_name limit 2000`, [id, q, like, digits]);
    // List + its sublists, once per person (the list's own membership wins over a sublist's)
    const contacts = await this.db.query(
      `select * from (
         select distinct on (p.id) p.id, p.name, p.rules, m.group_id, m.extra, ${PHONES_JSON} as phones
         from list_members m join people p on p.id = m.person_id join contact_groups g on g.id = m.group_id
         where (g.id = $1 or g.parent_id = $1)
           and ($2 = '' or p.name ilike $3 or ($4 <> '%%' and exists (select 1 from person_phones x where x.person_id = p.id and x.phone like $4)))
         order by p.id, (g.id = $1) desc
       ) x order by name nulls last, id limit 2000`, [id, q, like, digits]);
    return { students, contacts };
  }

  // ---------- people in your own lists ----------
  @Post('groups/:id/contacts')
  async addContacts(@Param('id', ParseIntPipe) id: number, @Body() b: { text?: string; people?: NewPerson[] }) {
    await this.manualGroup(id);
    return this.people.addToList(id, b.text ? parsePaste(b.text) : (b.people ?? []));
  }

  /** Step 1 of a CSV import: columns, first rows and the suggested name / phone columns. */
  @Post('groups/:id/import/preview')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async importPreview(@Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File) {
    await this.manualGroup(id);
    const rows = this.csvRows(file);
    const columns = Object.keys(rows[0]);
    return { rows: rows.length, columns, sample: rows.slice(0, 5), nameColumn: detectNameColumn(columns), phoneColumns: detectPhoneColumns(rows) };
  }

  /** Step 2: import with the chosen mapping (or the suggested one when none is sent). */
  @Post('groups/:id/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async importCsv(@Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File, @Body('mapping') mappingJson?: string) {
    await this.manualGroup(id);
    const rows = this.csvRows(file);
    const columns = Object.keys(rows[0]);
    let nameColumn = detectNameColumn(columns);
    let phoneColumns = detectPhoneColumns(rows);
    if (mappingJson) {
      let m: { nameColumn?: string | null; phoneColumns?: PhoneColumn[] };
      try { m = JSON.parse(mappingJson); } catch { throw new BadRequestException('Invalid column mapping'); }
      nameColumn = m.nameColumn && columns.includes(m.nameColumn) ? m.nameColumn : null;
      phoneColumns = (m.phoneColumns ?? []).filter((p) => columns.includes(p.column))
        .map((p) => ({ column: p.column, label: cleanLabel(p.label) || labelForColumn(p.column) }));
    }
    if (!phoneColumns.length) throw new BadRequestException(`No phone column chosen. Columns: ${columns.join(', ')}`);
    const r = await this.people.addToList(id, this.people.rowsToPeople(rows, nameColumn, phoneColumns));
    return { ...r, nameColumn, phoneColumns };
  }

  private csvRows(file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('CSV file is required');
    const rows = parseCsv(file.buffer, file.originalname);
    if (!rows.length) throw new BadRequestException('CSV is empty');
    return rows;
  }

  @Delete('groups/:id/members/:personId')
  async removeMember(@Param('id', ParseIntPipe) id: number, @Param('personId', ParseIntPipe) personId: number) {
    await this.manualGroup(id);
    await this.people.removeFromList(id, personId);
    return { ok: true };
  }

  @Get('people/:id') person(@Param('id', ParseIntPipe) id: number) { return this.people.person(id); }
  @Put('people/:id') updatePerson(@Param('id', ParseIntPipe) id: number, @Body() b: any) { return this.people.updatePerson(id, b); }

  private async manualGroup(id: number) {
    const g = await this.db.one('select * from contact_groups where id=$1', [id]);
    if (!g) throw new NotFoundException('Group not found');
    if (g.source !== 'manual') throw new BadRequestException('Groups synced from Frappe are read-only. Change them in Frappe.');
    return g;
  }

  // ---------- opt-outs ----------
  @Get('opt-outs')
  optOuts() { return this.db.query('select * from opt_outs order by created_at desc limit 5000'); }

  @Post('opt-outs')
  async addOptOut(@Body() b: { phone: string }) {
    const phone = normalizePhone(b.phone);
    if (!phone) throw new BadRequestException('Invalid phone number');
    await this.db.query(`insert into opt_outs(phone, reason) values ($1,'manual') on conflict do nothing`, [phone]);
    return { ok: true, phone };
  }

  @Delete('opt-outs/:phone')
  async removeOptOut(@Param('phone') raw: string) {
    const phone = normalizePhone(raw) ?? raw;
    await this.db.query('delete from opt_outs where phone=$1', [phone]);
    return { ok: true };
  }

  // ---------- Frappe ----------
  @Get('sync') syncStatus() { return this.sync.status(); }
  @Post('sync') runSync() { return this.sync.sync(); }

  @Get('reports/missing-numbers')
  missing() {
    return this.db.query(`
      select s.admission_no, s.student_name, s.program, s.section,
             (s.father_phone is null) as father_missing, (s.mother_phone is null) as mother_missing
      from students s where s.active and (s.father_phone is null or s.mother_phone is null)
      order by (s.father_phone is null and s.mother_phone is null) desc, s.program, s.section, s.student_name`);
  }
}
