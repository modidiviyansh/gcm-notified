import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

// Normalises any Indian (or international) number to digits-only E.164 without "+", e.g. 919876543210.
// Returns null when the number is not a valid mobile number.
export function normalizePhone(raw: unknown, defaultCountry: 'IN' = 'IN'): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  // 0XXXXXXXXXX → local Indian with trunk prefix
  if (/^0\d{10}$/.test(s)) s = s.slice(1);
  // 91XXXXXXXXXX without plus
  if (/^91[6-9]\d{9}$/.test(s)) s = '+' + s;
  const p = parsePhoneNumberFromString(s, defaultCountry);
  if (!p || !p.isValid()) return null;
  const type = p.getType();
  if (type && type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE') return null;
  return p.number.replace('+', '');
}

export const toChatId = (phone: string) => `${phone}@c.us`;

export function phoneFromChatId(chatId: string | undefined | null): string | null {
  if (!chatId) return null;
  const m = /^(\d+)@(c\.us|s\.whatsapp\.net)$/.exec(chatId);
  return m ? m[1] : null;
}

export const maskPhone = (p: string | null | undefined) => (p ? p.slice(0, 4) + '•••••' + p.slice(-3) : '');
