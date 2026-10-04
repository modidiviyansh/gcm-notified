// Campaign schedules. All dates/times are wall-clock in the app timezone (Asia/Kolkata by default).
//
//   spread  — one campaign, sent only inside a daily window, on chosen weekdays, at most N per day
//   repeat  — a template; every occurrence creates its own run (daily, weekdays, chosen days, every N days, monthly)
//   dated   — a template run every day; recipients whose date (birthday or a list column) + step offset is today

const appTz = () => process.env.APP_TIMEZONE || 'Asia/Kolkata';

export type TimeSpec = { type: 'exact'; at: string } | { type: 'random'; from: string; to: string };
export interface SpreadSchedule { mode: 'spread'; startAt: string; window: { start: string; end: string }; days: number[]; dailyLimit: number; skipHolidays: boolean }
export interface RepeatSchedule {
  mode: 'repeat'; freq: 'daily' | 'weekdays' | 'days' | 'every' | 'monthly';
  days?: number[]; every?: number; monthDay?: number | 'last';
  startDate: string; time: TimeSpec;
  end: { type: 'never' } | { type: 'date'; date: string } | { type: 'count'; count: number };
  skipHolidays: boolean;
}
export interface DatedStep { offset: number; body: string }
export interface DatedSchedule {
  mode: 'dated'; source: { type: 'birthday' } | { type: 'column'; column: string; yearly: boolean };
  steps: DatedStep[]; time: TimeSpec; startDate: string;
}
export type Schedule = SpreadSchedule | RepeatSchedule | DatedSchedule;

// ---------- local time ----------
function parts(d: Date) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: appTz(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}
export const localDay = (d: Date) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
const hm = (s: string) => { const [h, m] = s.split(':').map(Number); return (h % 24) * 60 + (m || 0); };
export const localMinutesOf = (d: Date) => { const p = parts(d); return Number(p.hour) * 60 + Number(p.minute); };

/** The UTC instant of a local wall-clock time, e.g. atLocal('2026-10-05', 546) = 09:06 IST. */
export function atLocal(day: string, minutes: number): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const p = parts(new Date(guess));
  const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(guess - (shown - guess));
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
export const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const lastDayOfMonth = (day: string) => { const [y, m] = day.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };

// ---------- validation ----------
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const isHm = (s: unknown): s is string => typeof s === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);
const fail = (m: string): never => { throw new Error(m); };

function cleanTime(t: any): TimeSpec {
  if (t?.type === 'random') {
    if (!isHm(t.from) || !isHm(t.to)) fail('Choose a start and end time for the random window');
    if (hm(t.to) <= hm(t.from)) fail('The random window must end after it starts');
    return { type: 'random', from: t.from, to: t.to };
  }
  if (!isHm(t?.at)) fail('Choose a send time, e.g. 09:06');
  return { type: 'exact', at: t.at };
}
const cleanDays = (d: unknown) => [...new Set((Array.isArray(d) ? d : []).map(Number).filter((x) => x >= 0 && x <= 6))].sort();

/** Validates a schedule from the editor. Throws Error with a readable message. */
export function cleanSchedule(s: any, today: string): Schedule | null {
  if (!s || s.mode === 'now') return null;
  if (s.mode === 'spread') {
    if (!isHm(s.window?.start) || !isHm(s.window?.end) || hm(s.window.end) <= hm(s.window.start)) fail('Choose a daily sending window, e.g. 10:00–16:00');
    const days = cleanDays(s.days);
    if (!days.length) fail('Pick at least one sending day');
    const limit = Math.round(Number(s.dailyLimit));
    if (!(limit >= 1)) fail('Set a daily limit of at least 1 message');
    const start = s.startAt ? new Date(s.startAt) : new Date();
    if (Number.isNaN(start.getTime())) fail('Invalid start date');
    return { mode: 'spread', startAt: start.toISOString(), window: { start: s.window.start, end: s.window.end }, days, dailyLimit: limit, skipHolidays: !!s.skipHolidays };
  }
  if (s.mode === 'repeat') {
    const freq = ['daily', 'weekdays', 'days', 'every', 'monthly'].includes(s.freq) ? s.freq : fail('Choose how often');
    const out: RepeatSchedule = {
      mode: 'repeat', freq, startDate: isDay(s.startDate) ? s.startDate : today, time: cleanTime(s.time),
      end: { type: 'never' }, skipHolidays: !!s.skipHolidays,
    };
    if (freq === 'days') { out.days = cleanDays(s.days); if (!out.days.length) fail('Pick at least one weekday'); }
    if (freq === 'weekdays') out.days = cleanDays(s.days?.length ? s.days : [1, 2, 3, 4, 5]);
    if (freq === 'every') { out.every = Math.round(Number(s.every)); if (!(out.every >= 2 && out.every <= 365)) fail('"Every N days" needs N between 2 and 365'); }
    if (freq === 'monthly') {
      out.monthDay = s.monthDay === 'last' ? 'last' : Math.round(Number(s.monthDay));
      if (out.monthDay !== 'last' && !(out.monthDay >= 1 && out.monthDay <= 31)) fail('Choose a day of the month');
    }
    if (s.end?.type === 'date') { if (!isDay(s.end.date)) fail('Choose an end date'); out.end = { type: 'date', date: s.end.date }; }
    if (s.end?.type === 'count') { const n = Math.round(Number(s.end.count)); if (!(n >= 1)) fail('Number of runs must be at least 1'); out.end = { type: 'count', count: n }; }
    return out;
  }
  if (s.mode === 'dated') {
    const source = s.source?.type === 'column'
      ? { type: 'column' as const, column: String(s.source.column ?? '').trim() || fail('Choose the date column'), yearly: !!s.source.yearly }
      : { type: 'birthday' as const };
    const steps = (Array.isArray(s.steps) ? s.steps : []).slice(0, 10).map((x: any) => ({ offset: Math.max(-90, Math.min(90, Math.round(Number(x?.offset) || 0))), body: String(x?.body ?? '') }));
    if (!steps.length) fail('Add at least one step');
    if (new Set(steps.map((x: DatedStep) => x.offset)).size !== steps.length) fail('Two steps have the same day');
    return { mode: 'dated', source, steps, time: cleanTime(s.time), startDate: isDay(s.startDate) ? s.startDate : today };
  }
  return fail('Unknown schedule');
}

// ---------- occurrences ----------
export function occursOn(s: RepeatSchedule, day: string, holidays: Set<string>): boolean {
  if (day < s.startDate) return false;
  if (s.end.type === 'date' && day > s.end.date) return false;
  if (s.skipHolidays && holidays.has(day)) return false;
  const wd = weekday(day);
  switch (s.freq) {
    case 'daily': return true;
    case 'weekdays':
    case 'days': return (s.days ?? []).includes(wd);
    case 'every': return daysBetween(s.startDate, day) % (s.every ?? 2) === 0;
    case 'monthly': {
      const dom = Number(day.slice(8));
      const last = lastDayOfMonth(day);
      return s.monthDay === 'last' ? dom === last : dom === Math.min(Number(s.monthDay), last);
    }
  }
}

/** Concrete send time on a day; random windows pick a minute inside the window. */
export function timeOn(day: string, t: TimeSpec, rand = Math.random): Date {
  if (t.type === 'exact') return atLocal(day, hm(t.at));
  const a = hm(t.from), b = hm(t.to);
  return new Date(atLocal(day, a).getTime() + Math.floor(rand() * (b - a) * 60_000));
}

export interface PlannedRun { day: string; at: Date | null; from?: string; to?: string }

/** Upcoming runs after `after` (at most `count`), honouring the end condition. `done` = runs already made. */
export function upcoming(s: RepeatSchedule | DatedSchedule, after: Date, count: number, holidays: Set<string>, done = 0): PlannedRun[] {
  const out: PlannedRun[] = [];
  let left = s.mode === 'repeat' && s.end.type === 'count' ? s.end.count - done : Infinity;
  let day = localDay(after) < s.startDate ? s.startDate : localDay(after);
  for (let i = 0; i < 800 && out.length < count && left > 0; i++, day = addDays(day, 1)) {
    if (s.mode === 'repeat' && !occursOn(s, day, holidays)) continue;
    if (s.mode === 'dated' && day < s.startDate) continue;
    const t = s.time;
    const latest = t.type === 'exact' ? atLocal(day, hm(t.at)) : atLocal(day, hm(t.to));
    if (latest <= after) continue;
    out.push(t.type === 'exact' ? { day, at: latest } : { day, at: null, from: t.from, to: t.to });
    left--;
  }
  return out;
}

/** Next concrete run time (random windows resolved now; never earlier than `after`). */
export function nextRunAt(s: RepeatSchedule | DatedSchedule, after: Date, holidays: Set<string>, done = 0, rand = Math.random): Date | null {
  const [n] = upcoming(s, after, 1, holidays, done);
  if (!n) return null;
  if (n.at) return n.at;
  const at = timeOn(n.day, s.time, rand);
  return at > after ? at : new Date(after.getTime() + 60_000);
}

// ---------- spread-out sending ----------
/** Whether a spread-out campaign may send right now, and why not. */
export function spreadBlock(s: SpreadSchedule, now: Date, sentToday: number, holidays: Set<string>): string | null {
  if (now < new Date(s.startAt)) return 'not started yet';
  const day = localDay(now);
  if (!s.days.includes(weekday(day))) return 'not a sending day';
  if (s.skipHolidays && holidays.has(day)) return 'holiday';
  const m = localMinutesOf(now);
  if (m < hm(s.window.start) || m >= hm(s.window.end)) return 'outside the sending window';
  if (sentToday >= s.dailyLimit) return 'daily limit reached';
  return null;
}

/** Sending days needed and the expected last day for `total` messages. */
export function spreadPlan(s: SpreadSchedule, total: number, holidays: Set<string>): { days: number; lastDay: string | null } {
  if (total <= 0) return { days: 0, lastDay: null };
  let day = localDay(new Date(s.startAt)), left = total, days = 0;
  for (let i = 0; i < 1000 && left > 0; i++, day = addDays(day, 1)) {
    if (!s.days.includes(weekday(day)) || (s.skipHolidays && holidays.has(day))) continue;
    left -= s.dailyLimit; days++;
    if (left <= 0) return { days, lastDay: day };
  }
  return { days, lastDay: null };
}

// ---------- dated (drip) ----------
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Reads 2026-10-04, 04-10-2026, 04/10/2026, 4.10.26, 4 Oct 2026 or 4-Oct as YYYY-MM-DD (day first, Indian style). */
export function parseDate(v: unknown, defaultYear = 2000): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (r) [y, m, d] = [+r[1], +r[2], +r[3]];
  else if ((r = /^(\d{1,2})[-/.](\d{1,2})(?:[-/.](\d{2,4}))?$/.exec(s))) [d, m, y] = [+r[1], +r[2], r[3] ? +r[3] : defaultYear];
  else if ((r = /^(\d{1,2})[\s-]+([a-z]{3})[a-z]*\.?(?:[\s,-]+(\d{2,4}))?$/.exec(s)) && MONTHS.includes(r[2])) [d, m, y] = [+r[1], MONTHS.indexOf(r[2]) + 1, r[3] ? +r[3] : defaultYear];
  else return null;
  if (y < 100) y += y > 50 ? 1900 : 2000;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Does a stored date match `target` (= run day − offset)? Yearly dates match on month and day; 29 Feb → 28 Feb. */
export function dateMatches(date: string, target: string, yearly: boolean): boolean {
  if (!yearly) return date === target;
  const md = date.slice(5);
  if (md === target.slice(5)) return true;
  return md === '02-29' && target.slice(5) === '02-28' && lastDayOfMonth(target) === 28;
}

export const offsetLabel = (o: number) => (o === 0 ? 'on the day' : o < 0 ? `${-o} day${o === -1 ? '' : 's'} before` : `${o} day${o === 1 ? '' : 's'} after`);

/** Message versions separated by a line containing only "===". */
export function variants(body: string): string[] {
  const v = body.split(/^\s*===\s*$/m).map((x) => x.trim()).filter(Boolean);
  return v.length ? v : [body];
}
