import { createCipheriv, createDecipheriv, createHash, createHmac } from 'crypto';

// Phone numbers leave the server masked ("•••••• 3210") with an encrypted reference next to them.
// The reference can only be turned back into the number by POST /api/reveal (logged), and expires.

// Refs are valid 12–18 h and identical for the same number within a 6 h bucket, so a revealed number stays
// revealed when a table reloads (search, paging).
const BUCKET_MS = 6 * 3600_000;
let key: Buffer | null = null;
// SESSION_SECRET is validated at startup by config.ts; read directly so this module has no other env needs
const keyOf = () => (key ??= createHash('sha256').update(String(process.env.SESSION_SECRET) + ':phone-ref').digest());

export const MASK = '••••••';

/** Masks to the last 4 digits; leaves short or digit-less values alone. */
export function maskDigits(v: string): string {
  const d = v.replace(/\D/g, '');
  return d.length >= 7 ? `${MASK} ${d.slice(-4)}` : v;
}

export const isMasked = (v: unknown) => typeof v === 'string' && v.startsWith(MASK);

export function encryptRef(value: string, now = Date.now()): string {
  const exp = Math.floor(((Math.floor(now / BUCKET_MS) + 3) * BUCKET_MS) / 1000);
  const plain = `${exp}|${value}`;
  const iv = createHmac('sha256', keyOf()).update(plain).digest().subarray(0, 12);
  const c = createCipheriv('aes-256-gcm', keyOf(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function decryptRef(ref: string, now = Date.now()): string | null {
  try {
    const b = Buffer.from(ref, 'base64url');
    if (b.length < 29) return null;
    const d = createDecipheriv('aes-256-gcm', keyOf(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    const text = Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    const i = text.indexOf('|');
    if (i < 0 || Number(text.slice(0, i)) * 1000 < now) return null;
    return text.slice(i + 1);
  } catch {
    return null;
  }
}

// Keys whose values are phone numbers: phone, father_phone, "Phone 2", mobile, pn…
const PHONE_KEY = /(^|[_\s-])(phone|mobile|pn)(\s?\d+)?$|^phone|phone$/i;
const PERSONAL_CHAT = /^(\d{7,})@(c\.us|s\.whatsapp\.net)$/;

const isPlain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Returns a copy of `data` with every phone masked and a `<key>_ref` added beside it. */
export function maskDeep(data: unknown, depth = 0): unknown {
  if (depth > 12) return data;
  if (Array.isArray(data)) return data.map((x) => maskDeep(x, depth + 1));
  if (!isPlain(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && v && !isMasked(v)) {
      if (PHONE_KEY.test(k) && !k.endsWith('_ref') && v.replace(/\D/g, '').length >= 7) {
        out[k] = maskDigits(v); out[`${k}_ref`] = encryptRef(v); continue;
      }
      if (k === 'chat_id' && PERSONAL_CHAT.test(v)) {
        out[k] = maskDigits(v.split('@')[0]); out[`${k}_ref`] = encryptRef(v.split('@')[0]); continue;
      }
    }
    out[k] = typeof v === 'object' && v !== null ? maskDeep(v, depth + 1) : v;
  }
  return out;
}
