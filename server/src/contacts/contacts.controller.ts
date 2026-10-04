import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { parse } from 'csv-parse/sync';
import { Db } from '../db/db.service';
import { FrappeSyncService } from './frappe-sync.service';
import { normalizePhone } from '../common/phone';

export function parseCsv(buf: Buffer): Record<string, string>[] {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  return parse(text, { columns: (h: string[]) => h.map((x) => x.trim()), skip_empty_lines: true, trim: true, relax_column_count: true, bom: true });
}

const findCol = (cols: string[], re: RegExp) => cols.find((c) => re.test(c.toLowerCase().replace(/[\s_-]+/g, '')));

@Controller()
export class ContactsController {
  constructor(private readonly db: Db, private readonly sync: FrappeSyncService) {}

  // ---------- groups ----------
  @Get('groups')
  async tree() {
    const rows = await this.db.query(`
      select g.id, g.parent_id, g.name, g.source, g.sort_order, g.description, g.created_at,
        (select count(*)::int from students s where s.group_id = g.id and s.active) as students,
        (select count(*)::int from contacts c where c.group_id = g.id) as contacts
      from contact_groups g order by g.source, g.sort_order, g.name`);
    const byId = new Map<number, any>(rows.map((r) => [r.id, { ...r, children: [] }]));
    const roots: any[] = [];
    for (const g of byId.values()) (g.parent_id && byId.get(g.parent_id) ? byId.get(g.parent_id).children : roots).push(g);
    // A person in a list and one of its sublists counts once
    const people = new Map((await this.db.query<{ root: number; n: number }>(
      `select coalesce(g.parent_id, g.id) as root, count(distinct c.phone)::int as n
       from contacts c join contact_groups g on g.id = c.group_id group by 1`)).map((r) => [r.root, r.n]));
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

  /** Everyone in your own lists, one row per phone number, with the lists they are in. */
  @Get('contacts')
  allContacts(@Query('q') q = '') {
    return this.db.query(
      `select c.phone, max(c.name) as name, array_agg(distinct g.name order by g.name) as lists,
              bool_or(c.phone in (select phone from opt_outs)) as opted_out, min(c.created_at) as created_at
       from contacts c join contact_groups g on g.id = c.group_id
       where ($1 = '' or c.name ilike $2 or ($3 <> '%%' and c.phone like $3))
       group by c.phone order by max(c.name) nulls last, c.phone limit 2000`,
      [q, `%${q}%`, `%${q.replace(/\D/g, '')}%`]);
  }

  @Delete('groups/:id')
  async deleteGroup(@Param('id', ParseIntPipe) id: number) {
    await this.manualGroup(id);
    await this.db.query('delete from contact_groups where id=$1', [id]);
    return { ok: true };
  }

  @Get('groups/:id/members')
  async members(@Param('id', ParseIntPipe) id: number, @Query('q') q = '') {
    const like = `%${q}%`;
    const students = await this.db.query(
      `select s.id, s.admission_no, s.student_name, s.program, s.section, s.father_name, s.mother_name, s.father_phone, s.mother_phone,
              (s.father_phone in (select phone from opt_outs)) as father_opted_out, (s.mother_phone in (select phone from opt_outs)) as mother_opted_out
       from students s join contact_groups g on g.id = s.group_id
       where s.active and (g.id = $1 or g.parent_id = $1) and ($2 = '' or s.student_name ilike $3 or s.admission_no ilike $3)
       order by s.section, s.student_name limit 2000`, [id, q, like]);
    // List + its sublists, once per phone (the list's own entry wins over a sublist's)
    const contacts = await this.db.query(
      `select * from (
         select distinct on (c.phone) c.id, c.name, c.phone, c.extra, (c.phone in (select phone from opt_outs)) as opted_out
         from contacts c join contact_groups g on g.id = c.group_id
         where (g.id = $1 or g.parent_id = $1) and ($2 = '' or c.name ilike $3 or c.phone ilike $3)
         order by c.phone, (g.id = $1) desc, c.id
       ) x order by name nulls last, phone limit 2000`, [id, q, like]);
    return { students, contacts };
  }

  // ---------- manual contacts ----------
  @Post('groups/:id/contacts')
  async addContacts(@Param('id', ParseIntPipe) id: number, @Body() b: { text?: string; contacts?: { name?: string; phone: string }[] }) {
    await this.manualGroup(id);
    let list = b.contacts ?? [];
    if (b.text) {
      // One per line: "Name, 98765 43210", "98765 43210 Name" or just numbers (also comma/semicolon separated numbers)
      list = b.text.split(/\r?\n/).flatMap((line) => {
        const t = line.trim();
        if (/[a-z]/i.test(t)) {
          const m = /^(.*?)[\s,;\t]*(\+?\d[\d\s-]{7,}\d)[\s,;\t]*(.*)$/.exec(t);
          const name = m && [m[1], m[3]].map((x) => x.replace(/^[\s,;:-]+|[\s,;:-]+$/g, '')).filter(Boolean).join(' ');
          if (m && name && /[a-z]/i.test(name)) return [{ name, phone: m[2] }];
        }
        return t.split(/[,;\t]/).map((p) => ({ phone: p.trim() })).filter((p) => p.phone);
      });
    }
    return this.insertContacts(id, list.map((c) => ({ name: c.name ?? null, phone: c.phone, extra: {} })));
  }

  @Post('groups/:id/import')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async importCsv(@Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File) {
    await this.manualGroup(id);
    if (!file) throw new BadRequestException('CSV file is required');
    const rows = parseCsv(file.buffer);
    if (!rows.length) throw new BadRequestException('CSV is empty');
    const cols = Object.keys(rows[0]);
    const phoneCol = findCol(cols, /^(phone|mobile|number|whatsapp|contact|mobileno|phoneno)/);
    const nameCol = findCol(cols, /^(name|fullname|contactname|parentname)/);
    if (!phoneCol) throw new BadRequestException(`No phone column found. Columns: ${cols.join(', ')}`);
    const list = rows.map((r) => {
      const extra: Record<string, string> = {};
      for (const c of cols) if (c !== phoneCol && c !== nameCol) extra[c] = r[c];
      return { name: nameCol ? r[nameCol] : null, phone: r[phoneCol], extra };
    });
    return { ...(await this.insertContacts(id, list)), phoneColumn: phoneCol, nameColumn: nameCol ?? null };
  }

  @Delete('contacts/:id')
  async deleteContact(@Param('id', ParseIntPipe) id: number) {
    await this.db.query('delete from contacts where id=$1', [id]);
    return { ok: true };
  }

  private async insertContacts(groupId: number, list: { name: string | null; phone: string; extra: Record<string, string> }[]) {
    let added = 0, updated = 0;
    const invalid: string[] = [];
    for (const c of list) {
      const phone = normalizePhone(c.phone);
      if (!phone) { invalid.push(String(c.phone)); continue; }
      const r = await this.db.one<{ inserted: boolean }>(
        `insert into contacts(group_id, name, phone, extra) values ($1,$2,$3,$4)
         on conflict (group_id, phone) do update set name=coalesce(excluded.name, contacts.name), extra=contacts.extra || excluded.extra
         returning (xmax = 0) as inserted`, [groupId, c.name?.trim() || null, phone, c.extra]);
      r?.inserted ? added++ : updated++;
    }
    return { added, updated, invalid: invalid.length, invalidSamples: invalid.slice(0, 10) };
  }

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
