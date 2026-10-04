export interface Speed {
  delay_min_ms: number; delay_max_ms: number;
  burst_min: number; burst_max: number;
  burst_pause_min_ms: number; burst_pause_max_ms: number;
  typing: boolean;
}

export const typingMs = (text: string) => Math.max(1000, Math.min(4000, text.length * 35));

/** Average wall time per message on one number, including typing, send overhead and amortised burst pauses. */
export function avgMsPerMessage(s: Speed, avgLen = 160): number {
  const delay = (s.delay_min_ms + s.delay_max_ms) / 2;
  const typing = s.typing ? typingMs('x'.repeat(avgLen)) : 0;
  const overhead = 800;
  const burst = (s.burst_min + s.burst_max) / 2 || Infinity;
  const pause = (s.burst_pause_min_ms + s.burst_pause_max_ms) / 2;
  return delay + typing + overhead + (Number.isFinite(burst) ? pause / burst : 0);
}

export type Risk = 'low' | 'medium' | 'high';

export function estimate(messages: number, numbers: { remaining: number }[], s: Speed, avgLen = 160) {
  const per = avgMsPerMessage(s, avgLen);
  const perHour = Math.round(3600_000 / per);
  const k = Math.max(1, numbers.length);
  const capToday = numbers.reduce((a, n) => a + Math.max(0, n.remaining), 0);
  const sendableToday = Math.min(messages, capToday);
  const minutes = Math.ceil(((sendableToday / k) * per) / 60_000);
  const risk: Risk = s.delay_min_ms < 2000 || perHour > 600 ? 'high' : s.delay_min_ms < 5000 || perHour > 300 ? 'medium' : 'low';
  return {
    messages,
    numbers: k,
    perNumberPerHour: perHour,
    minutesToday: minutes,
    capToday,
    overflow: Math.max(0, messages - capToday), // will continue tomorrow when caps reset
    risk,
  };
}
