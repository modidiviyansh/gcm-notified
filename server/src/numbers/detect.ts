// Works out warm-up details from what WhatsApp itself reports, so nobody has to guess them.
// Only counts and dates are kept — never names or message content.

const DAY = 86_400_000;
const isDirect = (id: string) => /@(c\.us|s\.whatsapp\.net|lid)$/.test(id);

export interface Detection {
  at: string;
  oldestChat: string | null;   // date of the oldest chat WhatsApp synced (lower bound for the account age)
  ageMonths: number | null;
  activeChats7d: number;       // different people chatted with in the last 7 days
  activeChats30d: number;
  chatsPerDay: number;
  chatsScanned: number;
  groups: number | null;
  channelsAdmin: number | null;
}

/** chats: recent chats (newest first); oldestTs: last-activity time (seconds) of the oldest chat in the store. */
export function analyseChats(chats: { id: string; ts: number }[], oldestTs: number | null, now = Date.now()): Omit<Detection, 'at' | 'groups' | 'channelsAdmin'> {
  const direct = chats.filter((c) => isDirect(c.id) && c.ts > 0);
  const since = (days: number) => direct.filter((c) => now - c.ts * 1000 < days * DAY).length;
  const a7 = since(7), a30 = since(30);
  const oldestMs = oldestTs && oldestTs > 0 ? oldestTs * 1000 : null;
  return {
    oldestChat: oldestMs ? new Date(oldestMs).toISOString().slice(0, 10) : null,
    ageMonths: oldestMs ? Math.max(0, Math.floor((now - oldestMs) / (30.44 * DAY))) : null,
    activeChats7d: a7,
    activeChats30d: a30,
    chatsPerDay: Math.round(Math.max(a7 / 7, a30 / 30)),
    chatsScanned: chats.length,
  };
}

// ---- WhatsApp's own limits (reported on the session's "me") ----

export interface WaLimits {
  capping: { status: string; total: number; used: number; remaining: number | null; cycleEnd: string | null } | null;
  timelock: { active: boolean; until: string | null } | null;
  at: string;
}

const toIso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function parseLimits(me: { messageCapping?: any; reachoutTimelock?: any } | null | undefined, now = Date.now()): WaLimits {
  const mc = me?.messageCapping;
  const capping = mc && typeof mc === 'object' ? {
    status: String(mc.cappingStatus ?? mc.status ?? 'NONE').toUpperCase(),
    total: Number(mc.totalQuota ?? -1),
    used: Number(mc.usedQuota ?? 0),
    remaining: Number(mc.totalQuota ?? -1) >= 0 ? Math.max(0, Number(mc.totalQuota) - Number(mc.usedQuota ?? 0)) : null,
    cycleEnd: toIso(mc.cycleEnd),
  } : null;

  const tl = me?.reachoutTimelock;
  let timelock: WaLimits['timelock'] = null;
  if (tl && typeof tl === 'object') {
    const endKey = Object.keys(tl).find((k) => /end|until|expir/i.test(k));
    const until = endKey ? toIso(tl[endKey]) : null;
    const flag = tl.isActive ?? tl.IsActive ?? tl.active;
    const active = (flag === undefined ? true : !!flag) && !(until && new Date(until).getTime() <= now);
    timelock = { active, until };
  }
  return { capping, timelock, at: new Date(now).toISOString() };
}

/** Why WhatsApp itself currently blocks sending to new people, or null when it doesn't. */
export function limitBlockReason(l: WaLimits | null | undefined): string | null {
  if (!l) return null;
  if (l.timelock?.active) {
    return `WhatsApp limit: this number is temporarily restricted from messaging new people${l.timelock.until ? ` until ${l.timelock.until}` : ''}.`;
  }
  if (l.capping && l.capping.status !== 'NONE' && l.capping.remaining === 0) {
    return `WhatsApp limit: the new-chat quota for this period is used up${l.capping.cycleEnd ? ` (resets ${l.capping.cycleEnd})` : ''}.`;
  }
  return null;
}
