import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Db } from '../db/db.service';
import { WahaClient, WahaError, WahaSession, WaTarget } from '../waha/waha.client';
import { AlertsService } from '../alerts/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { effectiveCap, levelFor, nextCap, warmupScore, WarmupInput } from './warmup';
import { localDate } from '../common/time';
import { maskPhone, phoneFromChatId } from '../common/phone';
import { analyseChats, Detection, limitBlockReason, parseLimits, WaLimits } from './detect';

export interface NumberRow extends WarmupInput {
  id: number; label: string; session: string; phone: string | null; push_name: string | null;
  status: string; status_at: Date; paused: boolean; pause_reason: string | null;
  daily_cap: number; max_cap: number; cap_override: number | null; ramp_enabled: boolean;
  sent_today: number; failed_today: number; counter_date: string | null; disconnects_today: number;
  warmup_source: 'manual' | 'auto' | 'pending'; detected: Detection | null; detected_at: Date | null; wa_limits: WaLimits | null;
}

const WARMUP_FIELDS = ['age_months', 'avg_chats_day', 'is_business', 'saved_by_contacts', 'past_ban'] as const;

@Injectable()
export class NumbersService implements OnApplicationBootstrap {
  private readonly log = new Logger('Numbers');
  private pendingDisconnect = new Map<number, NodeJS.Timeout>();
  /** Group refreshes are heavy for WAHA: never run two at once, for any number. */
  private refreshing: number | null = null;
  private detecting = new Set<number>();

  constructor(private readonly db: Db, private readonly waha: WahaClient, private readonly alerts: AlertsService, private readonly settings: SettingsService) {}

  async onApplicationBootstrap() {
    await this.rollover().catch((e) => this.log.error(e));
    this.syncStatuses().catch((e) => this.log.warn(`Initial status sync failed: ${e.message}`));
  }

  decorate(n: NumberRow) {
    const score = warmupScore(n);
    const lvl = levelFor(score);
    return { ...n, score, level: lvl.level, ramp_pct: lvl.rampPct, effective_cap: effectiveCap(n), remaining_today: Math.max(0, effectiveCap(n) - n.sent_today) };
  }

  async list() {
    const rows = await this.db.query<NumberRow>('select * from wa_numbers order by id');
    return rows.map((r) => this.decorate(r));
  }

  async get(id: number): Promise<NumberRow> {
    const n = await this.db.one<NumberRow>('select * from wa_numbers where id = $1', [id]);
    if (!n) throw new NotFoundException('Number not found');
    return n;
  }

  async create(body: { label: string; details?: boolean } & Partial<WarmupInput> & { max_cap?: number }) {
    const label = (body.label ?? '').trim();
    if (!label) throw new BadRequestException('Label is required');
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'number';
    let session = base;
    for (let i = 2; await this.db.one('select 1 from wa_numbers where session = $1', [session]); i++) session = `${base}-${i}`;
    const w = pickWarmup(body);
    // Unknown age/activity → start Cold; detected and raised once the number connects
    if (!body.details) { w.age_months = 0; w.avg_chats_day = 0; }
    const lvl = levelFor(warmupScore(w));
    const max = body.max_cap ?? (await this.settings.get()).defaultMaxCap;
    const row = await this.db.one<NumberRow>(
      `insert into wa_numbers(label, session, age_months, avg_chats_day, is_business, saved_by_contacts, past_ban, daily_cap, max_cap, counter_date, warmup_source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [label, session, w.age_months, w.avg_chats_day, w.is_business, w.saved_by_contacts, w.past_ban, Math.min(lvl.startCap, max), max, localDate(),
       body.details ? 'manual' : 'pending'],
    );
    try {
      await this.waha.createSession(session, { app: 'gcm-notified', numberId: String(row!.id) });
    } catch (e) {
      // Session may already exist in WAHA (e.g. re-created number) → just update + start it
      if (e instanceof WahaError && (e.status === 409 || e.status === 422)) {
        await this.waha.updateSession(session, { app: 'gcm-notified', numberId: String(row!.id) });
        await this.waha.start(session).catch(() => undefined);
      } else {
        await this.db.query('delete from wa_numbers where id = $1', [row!.id]);
        throw new BadRequestException(`Could not create WhatsApp session: ${(e as Error).message}`);
      }
    }
    await this.db.event('number', `Number "${label}" added (session ${session})`);
    return this.decorate((await this.get(row!.id)));
  }

  async update(id: number, body: Partial<WarmupInput> & { label?: string; max_cap?: number; cap_override?: number | null; ramp_enabled?: boolean }) {
    const n = await this.get(id);
    const w = { ...pick(n), ...pickWarmup(body, true) };
    const oldLevel = levelFor(warmupScore(n)).level;
    const lvl = levelFor(warmupScore(w));
    const max = body.max_cap ?? n.max_cap;
    // Level changed → restart from that level's starting cap (never above the max)
    const daily = lvl.level !== oldLevel ? Math.min(lvl.startCap, max) : Math.min(n.daily_cap, max);
    const override = body.cap_override === undefined ? n.cap_override : body.cap_override === null || (body.cap_override as any) === '' ? null : Math.max(0, Number(body.cap_override));
    await this.db.query(
      `update wa_numbers set label=$2, age_months=$3, avg_chats_day=$4, is_business=$5, saved_by_contacts=$6, past_ban=$7,
         daily_cap=$8, max_cap=$9, cap_override=$10, ramp_enabled=$11,
         warmup_source = case when $12 then 'manual' else warmup_source end where id=$1`,
      [id, body.label?.trim() || n.label, w.age_months, w.avg_chats_day, w.is_business, w.saved_by_contacts, w.past_ban,
       daily, max, override, body.ramp_enabled ?? n.ramp_enabled, (['age_months', 'avg_chats_day'] as const).some((k) => body[k] !== undefined && Number(body[k]) !== n[k])],
    );
    return this.decorate(await this.get(id));
  }

  async setPaused(id: number, paused: boolean, reason: string | null = null) {
    await this.db.query('update wa_numbers set paused=$2, pause_reason=$3 where id=$1', [id, paused, paused ? reason ?? 'Paused by admin' : null]);
    return this.decorate(await this.get(id));
  }

  async action(id: number, action: 'start' | 'stop' | 'restart' | 'logout') {
    const n = await this.get(id);
    await this.waha[action](n.session);
    await this.db.event('number', `${action} requested for "${n.label}"`);
    setTimeout(() => this.refreshOne(n).catch(() => undefined), 3000);
    return { ok: true };
  }

  async remove(id: number) {
    const n = await this.get(id);
    await this.waha.logout(n.session).catch(() => undefined);
    await this.waha.deleteSession(n.session).catch(() => undefined);
    await this.db.query(`update messages set status='queued', number_id=null where number_id=$1 and status='sending'`, [id]);
    await this.db.query('delete from wa_numbers where id=$1', [id]);
    await this.db.event('number', `Number "${n.label}" removed`, 'warn');
    return { ok: true };
  }

  qr(id: number) { return this.get(id).then((n) => this.waha.qrImage(n.session)); }

  async pairingCode(id: number, phone: string) {
    const n = await this.get(id);
    return this.waha.requestCode(n.session, phone.replace(/\D/g, ''));
  }

  /**
   * Reloads the groups & channels a number can post to, and stores them (campaign pickers read the stored copy).
   * Full group list first; if WAHA can't produce it (too many groups for its memory) fall back to the groups
   * in the recent chat list so the admin still gets something usable.
   */
  async refreshGroups(id: number) {
    const n = await this.get(id);
    if (n.status !== 'WORKING') throw new BadRequestException('Number is not connected');
    if (this.refreshing !== null) throw new BadRequestException('Another number is loading its groups right now — try again in a minute');
    this.refreshing = id;
    let warning: string | null = null;
    let source: 'full' | 'chats' = 'full';
    try {
      let groups: WaTarget[];
      try {
        groups = await this.waha.listGroups(n.session);
      } catch (e) {
        this.log.warn(`Full group list failed for "${n.label}": ${(e as Error).message}`);
        await this.waitForWaha(n.session);
        groups = await this.waha.groupsFromChats(n.session).catch(() => []);
        source = 'chats';
        warning = `The full group list could not be loaded (WhatsApp engine ran out of memory or timed out). Showing ${groups.length} groups from recent chats instead.`;
      }
      let channels: WaTarget[] = [];
      try { channels = await this.waha.listChannels(n.session); } catch (e) { this.log.warn(`Channels failed for "${n.label}": ${(e as Error).message}`); }
      // Keep admin checks already done (they cost one WhatsApp request per group)
      const roles = new Map((await this.db.query<{ chat_id: string; my_role: string | null; role_checked_at: Date | null }>(
        'select chat_id, my_role, role_checked_at from wa_groups where number_id=$1 and role_checked_at is not null', [id])).map((r) => [r.chat_id, r]));
      await this.db.tx(async (c) => {
        await c.query('delete from wa_groups where number_id=$1', [id]);
        for (const g of [...channels, ...groups]) {
          await c.query(
            `insert into wa_groups(number_id, chat_id, subject, participants, kind, announce, role, source, community, my_role, role_checked_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing`,
            [id, g.chatId, g.subject, g.participants, g.kind, g.announce, g.role, g.kind === 'channel' ? 'full' : source, g.community ?? null,
             roles.get(g.chatId)?.my_role ?? null, roles.get(g.chatId)?.role_checked_at ?? null]);
        }
      });
      const communities = groups.filter((g) => g.kind === 'community').length;
      await this.db.event('number', `"${n.label}": ${groups.length - communities} groups, ${communities} communities${source === 'chats' ? ' (from recent chats)' : ''} and ${channels.length} channels loaded`, warning ? 'warn' : 'info');
    } finally {
      this.refreshing = null;
    }
    return { items: await this.groups(id), source, warning };
  }

  groups(id: number) {
    return this.db.query(
      `select chat_id, subject, participants, kind, announce, role, source, community, my_role, refreshed_at from wa_groups where number_id=$1
       order by case kind when 'channel' then 0 when 'community' then 1 else 2 end, lower(subject)`, [id]);
  }

  /**
   * For admins-only groups and community announcements: is this number allowed to post?
   * Checks only the given groups (one request each) and caches the answer for a day.
   */
  async checkPostRights(numberId: number, chatIds: string[]): Promise<Map<string, boolean>> {
    const n = await this.get(numberId);
    const rows = await this.db.query<{ chat_id: string; announce: boolean; my_role: string | null; role_checked_at: Date | null }>(
      'select chat_id, announce, my_role, role_checked_at from wa_groups where number_id=$1 and chat_id = any($2)', [numberId, chatIds]);
    const out = new Map<string, boolean>();
    for (const r of rows) {
      if (!r.announce || r.chat_id.endsWith('@newsletter')) { out.set(r.chat_id, true); continue; }
      let role = r.my_role;
      let known = !!r.role_checked_at;
      const fresh = known && Date.now() - r.role_checked_at!.getTime() < 86_400_000;
      if (!fresh && n.status === 'WORKING') {
        try {
          role = await this.waha.myRole(n.session, r.chat_id);
          known = true;
          await this.db.query('update wa_groups set my_role=$3, role_checked_at=now() where number_id=$1 and chat_id=$2', [numberId, r.chat_id, role]);
        } catch (e) { this.log.warn(`Role check failed for ${r.chat_id}: ${(e as Error).message}`); }
      }
      // Unknown (WhatsApp couldn't be asked) → let it try; known → only admins may post
      out.set(r.chat_id, !known || role === 'admin' || role === 'superadmin');
    }
    return out;
  }

  /** After a WAHA crash the session needs a few seconds to come back. */
  private async waitForWaha(session: string, maxMs = 90_000) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const s = await this.waha.getSession(session).catch(() => null);
      if (s?.status === 'WORKING') return;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // ---- warm-up auto-detection ----

  /** Reads account age / activity from WhatsApp. With apply=true the results replace the warm-up inputs. */
  async detect(id: number, apply: boolean) {
    const n = await this.get(id);
    if (n.status !== 'WORKING') throw new BadRequestException('Connect the number first — details are read from WhatsApp');
    if (this.detecting.has(id)) throw new BadRequestException('Detection is already running for this number');
    this.detecting.add(id);
    try {
      const [recent, oldest] = await Promise.all([this.waha.chats(n.session, 500, 'desc'), this.waha.chats(n.session, 1, 'asc')]);
      const counts = await this.db.one<{ groups: number; channels: number }>(
        `select count(*) filter (where kind='group')::int groups, count(*) filter (where kind='channel')::int channels from wa_groups where number_id=$1`, [id]);
      const known = await this.db.one('select 1 from wa_groups where number_id=$1 limit 1', [id]);
      const detection: Detection = {
        at: new Date().toISOString(),
        ...analyseChats(recent, oldest[0]?.ts ?? null),
        groups: known ? counts!.groups : null,
        channelsAdmin: known ? counts!.channels : null,
      };
      await this.db.query('update wa_numbers set detected=$2, detected_at=now() where id=$1', [id, detection]);
      if (apply) {
        const w = { ...pick(n), avg_chats_day: detection.chatsPerDay, ...(detection.ageMonths !== null ? { age_months: detection.ageMonths } : {}) };
        const oldLevel = levelFor(warmupScore(n)).level;
        const lvl = levelFor(warmupScore(w));
        const daily = lvl.level !== oldLevel ? Math.min(lvl.startCap, n.max_cap) : n.daily_cap;
        await this.db.query(`update wa_numbers set age_months=$2, avg_chats_day=$3, daily_cap=$4, warmup_source='auto' where id=$1`,
          [id, w.age_months, w.avg_chats_day, daily]);
        await this.db.event('warmup', `"${n.label}" details detected: ~${w.age_months} months, ~${w.avg_chats_day} chats/day → ${lvl.level}`);
      }
      return { detection, number: this.decorate(await this.get(id)) };
    } finally {
      this.detecting.delete(id);
    }
  }

  // ---- WhatsApp's own limits ----

  /** Stores messageCapping / reachoutTimelock and pauses the number while WhatsApp restricts it. */
  private async applyLimits(n: NumberRow, me: WahaSession['me']) {
    if (!me || (me.messageCapping === undefined && me.reachoutTimelock === undefined)) return;
    const limits = parseLimits(me);
    await this.db.query('update wa_numbers set wa_limits=$2 where id=$1', [n.id, limits]);
    const reason = limitBlockReason(limits);
    const autoPaused = n.paused && (n.pause_reason ?? '').startsWith('WhatsApp limit:');
    if (reason && !n.paused) {
      await this.setPaused(n.id, true, reason);
      await this.db.event('number', `"${n.label}" paused: ${reason}`, 'warn');
      await this.alerts.send(`limit:${n.id}`, `WhatsApp restricted: ${n.label}`, `${reason} Sending from "${n.label}" is paused and resumes automatically when the limit is lifted.`, n.id);
    } else if (!reason && autoPaused) {
      await this.setPaused(n.id, false);
      await this.db.event('number', `"${n.label}" resumed: WhatsApp limit lifted`);
    }
  }

  // ---- status handling (webhook + polling) ----

  async onStatus(session: string, status: string, me?: { id?: string; pushName?: string } | null) {
    const n = await this.db.one<NumberRow>('select * from wa_numbers where session=$1', [session]);
    if (!n) return;
    const phone = phoneFromChatId(me?.id ?? null) ?? n.phone;
    if (n.status === status && phone === n.phone) return;
    await this.db.query('update wa_numbers set status=$2, status_at=now(), phone=$3, push_name=coalesce($4, push_name) where id=$1', [n.id, status, phone, me?.pushName ?? null]);
    await this.db.event('status', `"${n.label}" ${n.status} → ${status}`, status === 'WORKING' ? 'info' : 'warn');

    if (status === 'WORKING') {
      const t = this.pendingDisconnect.get(n.id);
      if (t) { clearTimeout(t); this.pendingDisconnect.delete(n.id); }
      // Freshly linked: give WhatsApp a moment to sync chat history, then read the warm-up details
      if (n.warmup_source === 'pending') {
        setTimeout(() => this.detect(n.id, true).catch((e) => this.log.warn(`Auto-detect for "${n.label}" failed: ${e.message}`)), 45_000);
      }
      return;
    }
    if (n.status === 'WORKING') {
      await this.db.query('update wa_numbers set disconnects_today = disconnects_today + 1 where id=$1', [n.id]);
      // Debounce short reconnect blips: alert only if still not WORKING after 2 minutes
      if (!this.pendingDisconnect.has(n.id)) {
        this.pendingDisconnect.set(n.id, setTimeout(async () => {
          this.pendingDisconnect.delete(n.id);
          const cur = await this.db.one<NumberRow>('select * from wa_numbers where id=$1', [n.id]);
          if (cur && cur.status !== 'WORKING') {
            await this.alerts.send(`disconnect:${n.id}`, `Number disconnected: ${n.label}`,
              `WhatsApp number "${n.label}" (${maskPhone(cur.phone)}) is ${cur.status} since ${cur.status_at.toISOString()}. Sending from this number is on hold. Open GCM Notified → Numbers to reconnect.`, n.id);
          }
        }, 120_000));
      }
    }
  }

  private async refreshOne(n: { session: string }) {
    const s = await this.waha.getSession(n.session);
    await this.onStatus(n.session, s.status, s.me);
  }

  @Interval(60_000)
  async syncStatuses() {
    const rows = await this.db.query<NumberRow>('select * from wa_numbers');
    if (!rows.length) return;
    let sessions: { name: string; status: string; me?: any }[] = [];
    try {
      sessions = await this.waha.listSessions();
    } catch (e) {
      this.log.warn(`WAHA unreachable: ${(e as Error).message}`);
      await this.alerts.send('waha-down', 'WhatsApp engine unreachable', `GCM Notified cannot reach WAHA: ${(e as Error).message}`);
      return;
    }
    const byName = new Map(sessions.map((s) => [s.name, s]));
    for (const n of rows) {
      const s = byName.get(n.session);
      await this.onStatus(n.session, s?.status ?? 'STOPPED', s?.me);
      if (s?.status === 'WORKING') await this.applyLimits(n, s.me).catch((e) => this.log.warn(`Limits for "${n.label}": ${e.message}`));
    }
  }

  /** Daily counters reset + warm-up ramp, at local (IST) midnight. Runs every 5 min; idempotent. */
  @Interval(5 * 60_000)
  async rollover() {
    const today = localDate();
    const s = await this.settings.get();
    const rows = await this.db.query<NumberRow>(`select * from wa_numbers where counter_date is distinct from $1::date`, [today]);
    for (const n of rows) {
      const lvl = levelFor(warmupScore(n));
      const samples = n.sent_today + n.failed_today;
      const failRate = samples ? (n.failed_today / samples) * 100 : 0;
      const healthy = failRate < s.autoPause.failureRatePct && n.disconnects_today === 0;
      const cap = n.ramp_enabled ? nextCap(n.daily_cap, n.max_cap, lvl.rampPct, n.sent_today, healthy) : n.daily_cap;
      await this.db.query(
        `update wa_numbers set daily_cap=$2, sent_today=0, failed_today=0, disconnects_today=0, counter_date=$3 where id=$1`,
        [n.id, cap, today],
      );
      if (cap !== n.daily_cap) await this.db.event('warmup', `"${n.label}" daily cap ${n.daily_cap} → ${cap}`);
    }
  }
}

function pick(n: WarmupInput): WarmupInput {
  return { age_months: n.age_months, avg_chats_day: n.avg_chats_day, is_business: n.is_business, saved_by_contacts: n.saved_by_contacts, past_ban: n.past_ban };
}
function pickWarmup(b: Partial<WarmupInput>, partial = false): any {
  const out: any = {};
  for (const k of WARMUP_FIELDS) {
    const numeric = k === 'age_months' || k === 'avg_chats_day';
    if (b[k] === undefined) {
      if (!partial) out[k] = numeric ? 0 : false;
      continue;
    }
    out[k] = numeric ? Math.max(0, Number(b[k]) || 0) : !!b[k];
  }
  return out;
}
