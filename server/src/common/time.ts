// Read directly (not via config) so these helpers work without the app's secrets, e.g. in tests
const appTz = () => process.env.APP_TIMEZONE || 'Asia/Kolkata';

// Wall-clock parts in the app timezone (default Asia/Kolkata).
function parts(d: Date, tz = appTz()) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}

/** YYYY-MM-DD in the app timezone */
export function localDate(d = new Date()): string {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Minutes since local midnight */
export function localMinutes(d = new Date()): number {
  const p = parts(d);
  return Number(p.hour) * 60 + Number(p.minute);
}

export function hhmmToMinutes(s: string): number {
  const [h, m] = s.split(':').map(Number);
  return (h % 24) * 60 + (m || 0);
}

/** True when `now` falls inside a quiet window like 22:00–06:00 (wraps midnight). */
export function inQuietHours(start: string, end: string, now = new Date()): boolean {
  const s = hhmmToMinutes(start), e = hhmmToMinutes(end), n = localMinutes(now);
  if (s === e) return false;
  return s < e ? n >= s && n < e : n >= s || n < e;
}

/** Milliseconds until the quiet window ends (0 if not in quiet hours). */
export function msUntilQuietEnds(start: string, end: string, now = new Date()): number {
  if (!inQuietHours(start, end, now)) return 0;
  const n = localMinutes(now), e = hhmmToMinutes(end);
  const mins = e > n ? e - n : 24 * 60 - n + e;
  return mins * 60_000 - now.getSeconds() * 1000;
}
