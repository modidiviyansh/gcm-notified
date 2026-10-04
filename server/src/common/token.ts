import { createHmac, timingSafeEqual } from 'crypto';

// Minimal signed session token: base64url(payload).base64url(hmac-sha256)

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signToken(payload: Record<string, unknown>, secret: string): string {
  const body = b64(JSON.stringify(payload));
  const sig = b64(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken<T = any>(token: string | undefined, secret: string): T | null {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p as T;
  } catch {
    return null;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const x = createHmac('sha256', 'cmp').update(a).digest();
  const y = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(x, y);
}
