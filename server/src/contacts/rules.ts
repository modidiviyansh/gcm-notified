// Which of a person's numbers a message goes to.
//
// A rule is chosen in layers: campaign override → person exception → list rule (or its parent list's) → message type default.
// Labels are matched case-insensitively. A rule that finds nothing falls back to the primary number.

export interface NumberRule { use: 'primary' | 'all' | 'labels'; labels?: string[]; mode?: 'first' | 'all' }
export interface PersonPhone { phone: string; label: string; is_primary: boolean }
export type RuleSource = 'campaign' | 'person' | 'list' | 'type';

export const PRIMARY_RULE: NumberRule = { use: 'primary' };
export const COMMON_LABELS = ['Mobile', 'Personal', 'Work', 'Home', 'Mobile 2', 'WhatsApp'];

export function cleanRule(r: unknown): NumberRule | null {
  const x = r as Partial<NumberRule> | null;
  if (!x || typeof x !== 'object') return null;
  if (x.use === 'primary' || x.use === 'all') return { use: x.use };
  if (x.use === 'labels') {
    const labels = [...new Set((x.labels ?? []).map((l) => cleanLabel(l)).filter(Boolean))].slice(0, 10);
    return labels.length ? { use: 'labels', labels, mode: x.mode === 'all' ? 'all' : 'first' } : null;
  }
  return null;
}

/** Keeps only valid rules, keyed by message type (or "*" for every type). */
export function cleanRules(r: unknown): Record<string, NumberRule> {
  const out: Record<string, NumberRule> = {};
  if (!r || typeof r !== 'object') return out;
  for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
    const rule = cleanRule(v);
    if (rule && /^[\w*-]{1,40}$/.test(k)) out[k] = rule;
  }
  return out;
}

export const cleanLabel = (l: unknown) => String(l ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function primaryOf(phones: PersonPhone[]): PersonPhone | null {
  return phones.find((p) => p.is_primary) ?? phones[0] ?? null;
}

/** The numbers a rule selects, and whether it had to fall back to the primary number. */
export function pickPhones(phones: PersonPhone[], rule: NumberRule): { picked: PersonPhone[]; fallback: boolean } {
  if (!phones.length) return { picked: [], fallback: false };
  if (rule.use === 'all') return { picked: [...phones], fallback: false };
  if (rule.use === 'labels') {
    const labels = rule.labels ?? [];
    if (rule.mode === 'all') {
      const picked = phones.filter((p) => labels.some((l) => same(l, p.label)));
      if (picked.length) return { picked, fallback: false };
    } else {
      for (const l of labels) {
        const p = phones.find((x) => same(x.label, l));
        if (p) return { picked: [p], fallback: false };
      }
    }
    return { picked: [primaryOf(phones)!], fallback: true };
  }
  return { picked: [primaryOf(phones)!], fallback: false };
}

/** First rule that applies, from the most specific layer to the least. */
export function resolveRule(type: string, layers: {
  campaign?: NumberRule | null; person?: Record<string, NumberRule> | null;
  list?: Record<string, NumberRule> | null; parentList?: Record<string, NumberRule> | null; typeDefault?: NumberRule | null;
}): { rule: NumberRule; source: RuleSource } {
  if (layers.campaign) return { rule: layers.campaign, source: 'campaign' };
  const p = layers.person?.[type] ?? layers.person?.['*'];
  if (p) return { rule: p, source: 'person' };
  const l = layers.list?.[type] ?? layers.parentList?.[type];
  if (l) return { rule: l, source: 'list' };
  return { rule: layers.typeDefault ?? PRIMARY_RULE, source: 'type' };
}

export function describeRule(r: NumberRule): string {
  if (r.use === 'all') return 'All numbers';
  if (r.use === 'labels') return `${(r.labels ?? []).join(r.mode === 'all' ? ' + ' : ' → ')}${r.mode === 'all' ? '' : ' (first available)'}`;
  return 'Primary number';
}

/** Label for a CSV phone column: "Work Phone" → Work, "Mobile 2" → Mobile 2, "Phone" → Mobile. */
export function labelForColumn(header: string): string {
  const h = header.trim();
  const n = h.toLowerCase().replace(/[\s_.-]+/g, ' ').trim();
  if (/^(phone|mobile|number|contact|cell|whatsapp number|mobile no|phone no|phone number|mobile number|contact no)$/.test(n)) return 'Mobile';
  if (/whats ?app/.test(n)) return 'WhatsApp';
  if (/work|office|official|staff/.test(n)) return 'Work';
  if (/home|landline|residence/.test(n)) return 'Home';
  if (/personal|private/.test(n)) return 'Personal';
  if (/father/.test(n)) return 'Father';
  if (/mother/.test(n)) return 'Mother';
  const m = /^(?:phone|mobile|contact|number|cell)\s*(\d)$/.exec(n);
  if (m) return m[1] === '1' ? 'Mobile' : `Mobile ${m[1]}`;
  const stripped = h.replace(/\b(phone|mobile|number|no\.?|contact|cell)\b/gi, '').replace(/\s+/g, ' ').trim();
  return cleanLabel(stripped || h);
}
