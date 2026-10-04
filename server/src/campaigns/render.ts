import Handlebars from 'handlebars';
import { spin } from '../common/random';
import { toChatId } from '../common/phone';

export type RecipientMode = 'father' | 'mother' | 'both' | 'primary' | 'student' | 'all';

export interface StudentRow {
  id: number; admission_no: string; student_name: string; program: string | null; section: string | null;
  father_name: string | null; mother_name: string | null; father_phone: string | null; mother_phone: string | null; student_phone: string | null;
  csv?: Record<string, string> | null;
}
export interface ContactRow { id: number; name: string | null; phone: string; label?: string | null; extra?: Record<string, string> | null; csv?: Record<string, string> | null }

export interface Recipient {
  phone: string;
  chatId: string;
  display: string;
  vars: Record<string, unknown>;
  /** when per-child, which child this message is for (0-based) – used to space messages to the same phone */
  childIndex: number;
  /** which of the person's numbers this is: Father, Mother, Work, Mobile… */
  label?: string | null;
}

/** CSV header → variable name: "Max Marks" → max_marks */
export const varName = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function csvVars(csv?: Record<string, string> | null) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(csv ?? {})) {
    const n = varName(k);
    if (n) out[n] = v;
  }
  return out;
}

export function joinNames(names: string[]): string {
  const u = [...new Set(names.filter(Boolean))];
  if (u.length <= 1) return u[0] ?? '';
  return `${u.slice(0, -1).join(', ')} & ${u[u.length - 1]}`;
}

function childVars(s: StudentRow, relation: 'Father' | 'Mother' | 'Student') {
  const first = s.student_name.split(/\s+/)[0] ?? s.student_name;
  return {
    student_name: s.student_name,
    first_name: first,
    admission_no: s.admission_no,
    class: s.program ?? '',
    section: s.section ?? '',
    father_name: s.father_name ?? '',
    mother_name: s.mother_name ?? '',
    parent_name: relation === 'Father' ? s.father_name ?? '' : relation === 'Mother' ? s.mother_name ?? '' : '',
    relation,
    ...csvVars(s.csv),
  };
}

/** Which numbers of a student receive the message, given the recipient mode. */
export function phonesFor(s: StudentRow, mode: RecipientMode, primary: 'father' | 'mother'): { phone: string; relation: 'Father' | 'Mother' | 'Student' }[] {
  const f = s.father_phone ? { phone: s.father_phone, relation: 'Father' as const } : null;
  const m = s.mother_phone ? { phone: s.mother_phone, relation: 'Mother' as const } : null;
  switch (mode) {
    case 'father': return f ? [f] : [];
    case 'mother': return m ? [m] : [];
    case 'student': return s.student_phone ? [{ phone: s.student_phone, relation: 'Student' }] : [];
    case 'both':
    case 'all': {
      const st = mode === 'all' && s.student_phone ? { phone: s.student_phone, relation: 'Student' as const } : null;
      const out = [f, m, st].filter(Boolean) as { phone: string; relation: 'Father' | 'Mother' | 'Student' }[];
      return out.filter((x, i) => out.findIndex((y) => y.phone === x.phone) === i);
    }
    case 'primary':
    default: {
      const order = primary === 'mother' ? [m, f] : [f, m];
      const p = order.find(Boolean);
      return p ? [p] : [];
    }
  }
}

/**
 * Builds the list of messages to send for students.
 * perChild=false → one message per phone ("household"); siblings are merged and available as {{#each children}}.
 * perChild=true  → one message per (phone, child).
 */
export function studentRecipients(students: StudentRow[], mode: RecipientMode, primary: 'father' | 'mother', perChild: boolean): { recipients: Recipient[]; noNumber: StudentRow[] } {
  const byPhone = new Map<string, { relation: 'Father' | 'Mother' | 'Student'; kids: StudentRow[] }>();
  const noNumber: StudentRow[] = [];
  for (const s of students) {
    const targets = phonesFor(s, mode, primary);
    if (!targets.length) { noNumber.push(s); continue; }
    for (const t of targets) {
      const h = byPhone.get(t.phone) ?? { relation: t.relation, kids: [] };
      if (!h.kids.some((k) => k.id === s.id)) h.kids.push(s);
      byPhone.set(t.phone, h);
    }
  }
  const recipients: Recipient[] = [];
  for (const [phone, h] of byPhone) {
    const children = h.kids.map((k) => childVars(k, h.relation));
    if (perChild) {
      children.forEach((c, i) => recipients.push({
        phone, chatId: toChatId(phone), display: `${h.relation === 'Student' ? '' : 'Parent of '}${c.student_name}`.trim(),
        vars: { ...c, children: [c], child_count: 1 }, childIndex: i, label: h.relation,
      }));
    } else {
      const first = children[0];
      const names = joinNames(children.map((c) => c.student_name));
      recipients.push({
        phone, chatId: toChatId(phone), display: h.relation === 'Student' ? names : `Parent of ${names}`,
        vars: {
          ...first,
          student_name: names,
          first_name: joinNames(children.map((c) => c.first_name)),
          class: joinNames(children.map((c) => c.class)),
          section: joinNames(children.map((c) => c.section)),
          admission_no: children.map((c) => c.admission_no).join(', '),
          children,
          child_count: children.length,
        },
        childIndex: 0, label: h.relation,
      });
    }
  }
  return { recipients, noNumber };
}

export function contactRecipients(contacts: ContactRow[]): Recipient[] {
  const byPhone = new Map<string, Recipient>();
  for (const c of contacts) {
    if (byPhone.has(c.phone)) continue;
    const vars = { name: c.name ?? '', phone: c.phone, number_label: c.label ?? '', ...csvVars(c.extra), ...csvVars(c.csv) };
    byPhone.set(c.phone, { phone: c.phone, chatId: toChatId(c.phone), display: c.name || 'Unnamed contact', vars: { ...vars, children: [], child_count: 0 }, childIndex: 0, label: c.label ?? null });
  }
  return [...byPhone.values()];
}

const hb = Handlebars.create();
hb.registerHelper('upper', (s: unknown) => String(s ?? '').toUpperCase());
hb.registerHelper('lower', (s: unknown) => String(s ?? '').toLowerCase());
hb.registerHelper('eq', (a: unknown, b: unknown) => a === b);
hb.registerHelper('inc', (n: unknown) => Number(n) + 1);

/** Validates template syntax; throws with a readable message. */
export function checkTemplate(body: string) {
  try {
    hb.precompile(body);
  } catch (e) {
    throw new Error(`Template error: ${(e as Error).message.split('\n')[0]}`);
  }
}

/** Spintax first (random per message), then variables. Missing variables render as empty text. */
export function renderMessage(body: string, vars: Record<string, unknown>): string {
  const t = hb.compile(spin(body), { noEscape: true });
  return t(vars).replace(/\n{3,}/g, '\n\n').trim();
}

/** Variables referenced in a template (top level + inside #each children). */
export function templateVars(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(/\{\{\s*([#/]?)([a-z_][\w.]*)?\s*([^}]*)\}\}/gi)) {
    if (m[1] === '#' || m[1] === '/') continue;
    if (m[2] && !['else', 'this'].includes(m[2])) out.add(m[2]);
  }
  return [...out];
}
