// Warm-up scoring: turns what the admin knows about a number into a trust level and a daily cap.

export interface WarmupInput {
  age_months: number;
  avg_chats_day: number;
  is_business: boolean;
  saved_by_contacts: boolean;
  past_ban: boolean;
}

export type Level = 'Cold' | 'Warm' | 'Trusted' | 'Established';

export const LEVELS: { level: Level; minScore: number; startCap: number; rampPct: number }[] = [
  { level: 'Cold', minScore: 0, startCap: 30, rampPct: 20 },
  { level: 'Warm', minScore: 30, startCap: 150, rampPct: 15 },
  { level: 'Trusted', minScore: 60, startCap: 400, rampPct: 10 },
  { level: 'Established', minScore: 80, startCap: 700, rampPct: 10 },
];

export function warmupScore(n: WarmupInput): number {
  const age = n.age_months >= 12 ? 30 : n.age_months >= 6 ? 20 : n.age_months >= 1 ? 10 : 0;
  const chats = n.avg_chats_day >= 50 ? 30 : n.avg_chats_day >= 20 ? 20 : n.avg_chats_day >= 5 ? 10 : 0;
  let s = age + chats + (n.is_business ? 15 : 0) + (n.saved_by_contacts ? 15 : 0) - (n.past_ban ? 40 : 0);
  return Math.max(0, Math.min(100, s));
}

export function levelFor(score: number) {
  return [...LEVELS].reverse().find((l) => score >= l.minScore)!;
}

/** Next day's cap after a healthy day. Only ramps when the number actually used most of its cap. */
export function nextCap(current: number, maxCap: number, rampPct: number, usedToday: number, healthy: boolean): number {
  if (!healthy) return current;
  if (usedToday < current * 0.5) return current;
  return Math.min(maxCap, Math.ceil((current * (100 + rampPct)) / 100)); // integer maths avoids 440.0000001 → 441
}

export const effectiveCap = (n: { daily_cap: number; cap_override: number | null; max_cap: number }) =>
  n.cap_override ?? Math.min(n.daily_cap, n.max_cap);
