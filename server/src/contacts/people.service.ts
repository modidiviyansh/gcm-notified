import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../db/db.service';
import { normalizePhone } from '../common/phone';
import type { ContactRow } from '../campaigns/render';
import { cleanLabel, cleanRules, labelForColumn, NumberRule, PersonPhone, pickPhones, resolveRule, RuleSource } from './rules';

export interface NewPerson { name: string | null; phones: { phone: string; label?: string | null }[]; extra?: Record<string, string> }
export interface ImportResult { added: number; updated: number; invalid: number; invalidSamples: string[]; conflicts: number; people: number }
export interface PhoneColumn { column: string; label: string }

/** One person per line. "Name, 98765 43210, 98111 22233" = one person with two numbers; bare numbers = one person each. */
export function parsePaste(text: string): NewPerson[] {
  const out: NewPerson[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const nums = [...t.matchAll(/\+?\d[\d\s()-]{7,}\d/g)].map((m) => m[0]);
    const name = t.replace(/\+?\d[\d\s()-]{7,}\d/g, ' ').replace(/[,;\t|]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s:-]+|[\s:-]+$/g, '').trim();
    if (name && /\p{L}/u.test(name) && nums.length) {
      out.push({ name, phones: nums.map((phone, i) => ({ phone, label: i === 0 ? 'Mobile' : `Mobile ${i + 1}` })) });
    } else {
      for (const p of t.split(/[,;\t|]/).map((x) => x.trim()).filter(Boolean)) out.push({ name: null, phones: [{ phone: p, label: 'Mobile' }] });
    }
  }
  return out;
}

/** Columns that hold phone numbers: by header, or because most values are valid mobile numbers. */
export function detectPhoneColumns(rows: Record<string, string>[]): PhoneColumn[] {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  const sample = rows.slice(0, 50);
  const found: PhoneColumn[] = [];
  for (const c of cols) {
    const n = c.toLowerCase();
    if (/admission|adm\b|roll|id$|code|pin|zip|amount|fee|marks/.test(n)) continue;
    const vals = sample.map((r) => String(r[c] ?? '').trim()).filter(Boolean);
    if (!vals.length) continue;
    const valid = vals.filter((v) => normalizePhone(v)).length;
    const byHeader = /phone|mobile|whats ?app|contact|cell|tel/.test(n);
    if ((byHeader && valid > 0) || valid / vals.length >= 0.6) found.push({ column: c, label: labelForColumn(c) });
  }
  // Same label twice (e.g. "Phone" and "Mobile") → number them
  const count = new Map<string, number>();
  for (const f of found) {
    const k = f.label.toLowerCase();
    count.set(k, (count.get(k) ?? 0) + 1);
    if (count.get(k)! > 1) f.label = `${f.label} ${count.get(k)}`;
  }
  return found;
}

export const detectNameColumn = (cols: string[]) =>
  cols.find((h) => /^(name|full ?name|contact ?name|parent ?name|staff ?name|person|employee ?name)$/i.test(h.trim())) ?? null;

@Injectable()
export class PeopleService {
  constructor(private readonly db: Db) {}

  /** Adds people to a list. A number already known joins its existing person; new numbers are added to that person. */
  async addToList(groupId: number, items: NewPerson[]): Promise<ImportResult> {
    const r: ImportResult = { added: 0, updated: 0, invalid: 0, invalidSamples: [], conflicts: 0, people: 0 };
    await this.db.tx(async (tx) => {
      for (const item of items) {
        const phones: { phone: string; label: string }[] = [];
        for (const p of item.phones) {
          const n = normalizePhone(p.phone);
          if (!n) { if (String(p.phone ?? '').trim()) { r.invalid++; if (r.invalidSamples.length < 10) r.invalidSamples.push(String(p.phone)); } continue; }
          if (!phones.some((x) => x.phone === n)) phones.push({ phone: n, label: cleanLabel(p.label) || 'Mobile' });
        }
        if (!phones.length) continue;
        const owners = (await tx.query<{ person_id: number; phone: string }>('select person_id, phone from person_phones where phone = any($1)', [phones.map((p) => p.phone)])).rows;
        let personId = owners.find((o) => o.phone === phones[0].phone)?.person_id ?? owners[0]?.person_id ?? null;
        const name = item.name?.trim() || null;
        if (personId) {
          if (name) await tx.query('update people set name = coalesce(name, $2) where id=$1', [personId, name]);
        } else {
          personId = (await tx.query<{ id: number }>('insert into people(name) values ($1) returning id', [name])).rows[0].id;
        }
        for (const p of phones) {
          const owner = owners.find((o) => o.phone === p.phone);
          if (owner && owner.person_id !== personId) { r.conflicts++; continue; }
          if (owner) continue;
          await tx.query(
            `insert into person_phones(person_id, phone, label, is_primary)
             values ($1,$2,$3, not exists (select 1 from person_phones where person_id=$1 and is_primary))`, [personId, p.phone, p.label]);
        }
        const m = await tx.query<{ inserted: boolean }>(
          `insert into list_members(group_id, person_id, extra) values ($1,$2,$3)
           on conflict (group_id, person_id) do update set extra = list_members.extra || excluded.extra
           returning (xmax = 0) as inserted`, [groupId, personId, item.extra ?? {}]);
        m.rows[0]?.inserted ? r.added++ : r.updated++;
      }
    });
    r.people = r.added + r.updated;
    return r;
  }

  /** CSV rows → people, using the chosen name column and labelled phone columns. Other columns stay as list columns. */
  rowsToPeople(rows: Record<string, string>[], nameColumn: string | null, phoneColumns: PhoneColumn[]): NewPerson[] {
    const used = new Set([nameColumn, ...phoneColumns.map((p) => p.column)].filter(Boolean) as string[]);
    return rows.map((row) => {
      const extra: Record<string, string> = {};
      for (const [k, v] of Object.entries(row)) if (!used.has(k) && v !== '' && v !== undefined) extra[k] = v;
      return {
        name: nameColumn ? row[nameColumn] || null : null,
        phones: phoneColumns.map((p) => ({ phone: row[p.column], label: p.label })).filter((p) => String(p.phone ?? '').trim()),
        extra,
      };
    });
  }

  async person(id: number) {
    const p = await this.db.one('select * from people where id=$1', [id]);
    if (!p) throw new NotFoundException('Person not found');
    const phones = await this.db.query(
      `select pp.phone, pp.label, pp.is_primary, (pp.phone in (select phone from opt_outs)) as opted_out
       from person_phones pp where person_id=$1 order by is_primary desc, id`, [id]);
    const lists = await this.db.query(
      `select g.id, g.name, pg.name as parent_name from list_members lm join contact_groups g on g.id = lm.group_id
       left join contact_groups pg on pg.id = g.parent_id where lm.person_id=$1 order by pg.name nulls first, g.name`, [id]);
    return { ...p, phones, lists };
  }

  async updatePerson(id: number, b: { name?: string | null; notes?: string | null; phones?: { phone: string; label?: string; is_primary?: boolean }[]; rules?: unknown }) {
    await this.person(id);
    await this.db.tx(async (tx) => {
      if (b.name !== undefined || b.notes !== undefined || b.rules !== undefined) {
        await tx.query(
          `update people set name = case when $2 then $3 else name end, notes = case when $4 then $5 else notes end,
             rules = case when $6 then $7::jsonb else rules end where id=$1`,
          [id, b.name !== undefined, b.name?.trim() || null, b.notes !== undefined, b.notes?.trim() || null, b.rules !== undefined, JSON.stringify(cleanRules(b.rules))]);
      }
      if (b.phones) {
        const list: { phone: string; label: string; is_primary: boolean }[] = [];
        for (const p of b.phones) {
          const n = normalizePhone(p.phone);
          if (!n) throw new BadRequestException(`"${p.phone}" is not a valid mobile number`);
          if (list.some((x) => x.phone === n)) throw new BadRequestException('The same number is listed twice');
          list.push({ phone: n, label: cleanLabel(p.label) || 'Mobile', is_primary: !!p.is_primary });
        }
        if (!list.length) throw new BadRequestException('Keep at least one number — or remove the person from the list instead');
        if (!list.some((x) => x.is_primary)) list[0].is_primary = true;
        let seenPrimary = false;
        for (const x of list) { if (x.is_primary && seenPrimary) x.is_primary = false; if (x.is_primary) seenPrimary = true; }
        const taken = (await tx.query<{ phone: string; name: string | null }>(
          `select pp.phone, p.name from person_phones pp join people p on p.id = pp.person_id where pp.phone = any($1) and pp.person_id <> $2`,
          [list.map((x) => x.phone), id])).rows;
        if (taken.length) throw new BadRequestException(`Number ending ${taken[0].phone.slice(-4)} already belongs to ${taken[0].name ?? 'another person'}`);
        await tx.query('delete from person_phones where person_id=$1', [id]);
        for (const x of list) await tx.query('insert into person_phones(person_id, phone, label, is_primary) values ($1,$2,$3,$4)', [id, x.phone, x.label, x.is_primary]);
      }
    });
    return this.person(id);
  }

  /** Removes a person from one list; people who are in no list any more are deleted. */
  async removeFromList(groupId: number, personId: number) {
    await this.db.query('delete from list_members where group_id=$1 and person_id=$2', [groupId, personId]);
    await this.db.query('delete from people p where id=$1 and not exists (select 1 from list_members where person_id=$1)', [personId]);
  }

  /** Labels in use (for rule pickers), most used first. */
  async labels(groupId?: number) {
    return (await this.db.query<{ label: string }>(
      `select pp.label from person_phones pp
       where $1::int is null or pp.person_id in (select lm.person_id from list_members lm join contact_groups g on g.id = lm.group_id where g.id = $1 or g.parent_id = $1)
       group by pp.label order by count(*) desc, pp.label limit 50`, [groupId ?? null])).map((r) => r.label);
  }

  /**
   * People in the given lists (and their sublists) → one ContactRow per selected number, following the rule layers.
   * Also returns a breakdown of which labels were used.
   */
  async audience(groupIds: number[], type: string, campaignRule: NumberRule | null, typeDefault: NumberRule | null) {
    if (!groupIds.length) return { contacts: [] as ContactRow[], people: 0, noNumber: 0, breakdown: [] as { label: string; n: number; fallback?: boolean }[], sources: {} as Record<RuleSource, number> };
    const groups = new Map((await this.db.query<{ id: number; parent_id: number | null; rules: Record<string, NumberRule> }>(
      'select id, parent_id, rules from contact_groups')).map((g) => [g.id, g]));
    const members = await this.db.query<{ person_id: number; group_id: number; extra: Record<string, string>; name: string | null; rules: Record<string, NumberRule> }>(
      `select lm.person_id, lm.group_id, lm.extra, p.name, p.rules from list_members lm
       join people p on p.id = lm.person_id join contact_groups g on g.id = lm.group_id
       where g.id = any($1) or g.parent_id = any($1) order by lm.person_id, lm.created_at`, [groupIds]);
    const ids = [...new Set(members.map((m) => m.person_id))];
    const phonesBy = new Map<number, PersonPhone[]>();
    for (const p of await this.db.query<PersonPhone & { person_id: number }>(
      'select person_id, phone, label, is_primary from person_phones where person_id = any($1) order by is_primary desc, id', [ids])) {
      phonesBy.set(p.person_id, [...(phonesBy.get(p.person_id) ?? []), p]);
    }
    const contacts: ContactRow[] = [];
    const tally = new Map<string, { label: string; n: number; fallback?: boolean }>();
    const sources = { campaign: 0, person: 0, list: 0, type: 0 } as Record<RuleSource, number>;
    let noNumber = 0;
    const seen = new Set<number>();
    for (const m of members) {
      if (seen.has(m.person_id)) continue;
      seen.add(m.person_id);
      const mine = members.filter((x) => x.person_id === m.person_id);
      // First membership with a list rule for this type wins; columns from all memberships are merged (first wins)
      const withRule = mine.find((x) => { const g = groups.get(x.group_id); return g?.rules?.[type] || (g?.parent_id && groups.get(g.parent_id)?.rules?.[type]); }) ?? m;
      const g = groups.get(withRule.group_id);
      const { rule, source } = resolveRule(type, {
        campaign: campaignRule, person: m.rules, list: g?.rules, parentList: g?.parent_id ? groups.get(g.parent_id)?.rules : null, typeDefault,
      });
      const phones = phonesBy.get(m.person_id) ?? [];
      const { picked, fallback: fell } = pickPhones(phones, rule);
      const fallback = fell && phones.length > 1;   // with a single number there was nothing to choose
      if (!picked.length) { noNumber++; continue; }
      sources[source]++;
      const extra = Object.assign({}, ...[...mine].reverse().map((x) => x.extra ?? {}));
      for (const p of picked) {
        contacts.push({ id: m.person_id, name: m.name, phone: p.phone, label: p.label, extra });
        const key = `${p.label.toLowerCase()}|${fallback}`;
        const t = tally.get(key) ?? { label: p.label, n: 0, ...(fallback ? { fallback: true } : {}) };
        t.n++; tally.set(key, t);
      }
    }
    return { contacts, people: seen.size - noNumber, noNumber, breakdown: [...tally.values()].sort((a, b) => b.n - a.n), sources };
  }
}
