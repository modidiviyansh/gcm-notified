import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { config } from '../config';
import { Db } from '../db/db.service';
import { WahaClient, WahaError, messageIdOf } from '../waha/waha.client';
import { SettingsService } from '../settings/settings.service';
import { NumbersService, NumberRow } from '../numbers/numbers.service';
import { CampaignsService } from '../campaigns/campaigns.service';
import { AlertsService } from '../alerts/alerts.service';
import { effectiveCap } from '../numbers/warmup';
import { between, sleep } from '../common/random';
import { inQuietHours, localDate } from '../common/time';
import { typingMs } from '../campaigns/estimate';
import { readMedia, MediaRow } from '../media/media.controller';
import { maskPhone } from '../common/phone';
import { addDays, atLocal, localDay, spreadBlock, SpreadSchedule } from '../campaigns/schedule';

interface MessageRow {
  id: number; campaign_id: number | null; number_id: number; chat_id: string; phone: string | null; body: string;
  media_id: number | null; attempts: number; recipient: string | null; ignore_opt_out: boolean;
}
interface Speed {
  delay_min_ms: number; delay_max_ms: number; burst_min: number; burst_max: number;
  burst_pause_min_ms: number; burst_pause_max_ms: number; typing: boolean;
}
interface LoopState { running: boolean; burstCount: number; burstTarget: number; timer?: NodeJS.Timeout }

const PHONE_CHECK_TTL_DAYS = 30;
const MAX_ATTEMPTS = 3;

@Injectable()
export class SenderService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('Sender');
  private loops = new Map<number, LoopState>();
  private stopping = false;
  readonly dirtyCampaigns = new Set<number>();
  private spreadCache = { at: 0, blocked: [] as number[] };

  constructor(
    private readonly db: Db, private readonly waha: WahaClient, private readonly settings: SettingsService,
    private readonly numbers: NumbersService, private readonly campaigns: CampaignsService, private readonly alerts: AlertsService,
  ) {}

  async onApplicationBootstrap() {
    // Anything that was mid-send when the app stopped goes back to the queue
    await this.db.query(`update messages set status='queued' where status='sending'`);
    await this.supervise();
  }

  onModuleDestroy() {
    this.stopping = true;
    for (const s of this.loops.values()) { s.running = false; if (s.timer) clearTimeout(s.timer); }
  }

  /** Keeps exactly one send loop per number; flushes campaign counters; completes finished campaigns. */
  @Interval(10_000)
  async supervise() {
    if (this.stopping) return;
    const ids = (await this.db.query<{ id: number }>('select id from wa_numbers')).map((r) => r.id);
    for (const id of ids) if (!this.loops.has(id)) this.startLoop(id);
    for (const [id, s] of this.loops) if (!ids.includes(id)) { s.running = false; this.loops.delete(id); }

    for (const id of this.dirtyCampaigns) await this.campaigns.refreshCounters(id);
    this.dirtyCampaigns.clear();

    const done = await this.db.query<{ id: number; name: string }>(`
      update campaigns c set status='completed', finished_at=now()
      where c.status='running' and not exists (select 1 from messages m where m.campaign_id=c.id and m.status in ('queued','sending'))
      returning id, name`);
    for (const c of done) {
      await this.campaigns.refreshCounters(c.id);
      await this.db.event('campaign', `Campaign "${c.name}" completed`);
    }
  }

  private startLoop(numberId: number) {
    const state: LoopState = { running: true, burstCount: 0, burstTarget: 0 };
    this.loops.set(numberId, state);
    const run = async () => {
      if (!state.running || this.stopping) return;
      let wait = 5000;
      try {
        wait = await this.tick(numberId, state);
      } catch (e) {
        this.log.error(`Loop ${numberId}: ${(e as Error).message}`);
        wait = 15_000;
      }
      if (state.running && !this.stopping) state.timer = setTimeout(run, wait);
    };
    state.timer = setTimeout(run, between(500, 3000));
  }

  /** One send attempt for a number. Returns how long to wait before the next one. */
  private async tick(numberId: number, state: LoopState): Promise<number> {
    const n = await this.db.one<NumberRow>('select * from wa_numbers where id=$1', [numberId]);
    if (!n) { state.running = false; return 0; }
    if (n.status !== 'WORKING' || n.paused) return 15_000;
    if (String(n.counter_date ?? '') !== localDate()) await this.numbers.rollover();
    if (n.sent_today >= effectiveCap(n)) return 60_000;

    const s = await this.settings.get();
    const quiet = s.quietHours.enabled && inQuietHours(s.quietHours.start, s.quietHours.end);

    const held = await this.spreadHeld();
    const msg = await this.db.one<MessageRow>(`
      with next as (
        select m.id from messages m left join campaigns c on c.id = m.campaign_id
        where m.status = 'queued'
          and (m.not_before is null or m.not_before <= now())
          and (m.campaign_id is null or c.status = 'running')
          and ((m.fixed_number and m.number_id = $1) or (not m.fixed_number and $1 = any(c.number_ids)))
          and (not $2 or m.campaign_id is null or not c.respect_quiet_hours)
          and (m.campaign_id is null or not (m.campaign_id = any($3::int[])))
        order by m.priority desc, m.id
        limit 1
        for update of m skip locked
      )
      update messages m set status = 'sending', number_id = $1, attempts = m.attempts + 1
      from next where m.id = next.id
      returning m.*`, [numberId, quiet, held]);
    if (!msg) return quiet ? 60_000 : 5_000;

    const speed = msg.campaign_id ? await this.db.one<Speed>('select * from campaigns where id=$1', [msg.campaign_id]) : null;
    if (msg.campaign_id) this.dirtyCampaigns.add(msg.campaign_id);

    // Spread-out campaign: re-check its window and daily limit now (the held list above is cached for a few seconds)
    const sched = (speed as any)?.schedule as SpreadSchedule | null;
    if (sched?.mode === 'spread') {
      const today = await this.db.one<{ n: number }>(
        `select count(*)::int n from messages where campaign_id=$1 and id<>$2 and (sent_at >= $3 or status='sending')`, [msg.campaign_id, msg.id, atLocal(localDay(new Date()), 0)]);
      if (spreadBlock(sched, new Date(), today?.n ?? 0, await this.campaigns.holidays())) {
        await this.db.query(`update messages set status='queued', attempts=greatest(attempts-1,0) where id=$1`, [msg.id]);
        this.spreadCache = { at: Date.now(), blocked: [...new Set([...this.spreadCache.blocked, msg.campaign_id!])] };
        return 1000;
      }
    }

    // Per-person daily cap across all campaigns (emergencies exempt): wait until tomorrow morning
    const cap = s.frequencyCap?.perDay ?? 0;
    if (cap > 0 && msg.campaign_id && msg.phone && !msg.ignore_opt_out) {
      const today = atLocal(localDay(new Date()), 0);
      const got = await this.db.one<{ n: number }>(
        `select count(*)::int n from messages where phone=$1 and id<>$2 and campaign_id is not null and status in ('sent','delivered','read') and sent_at >= $3`,
        [msg.phone, msg.id, today]);
      if ((got?.n ?? 0) >= cap) {
        const [h, m] = (s.quietHours.enabled ? s.quietHours.end : '08:00').split(':').map(Number);
        const resume = atLocal(addDays(localDay(new Date()), 1), Math.max(h * 60 + m, 8 * 60));
        await this.db.query(`update messages set status='queued', attempts=greatest(attempts-1,0), not_before=$2, error=$3 where id=$1`,
          [msg.id, resume, `Waiting until tomorrow — already got ${got!.n} message${got!.n === 1 ? '' : 's'} today (limit ${cap})`]);
        return 200;
      }
    }

    // Opt-out (checked again at send time — someone may have replied STOP since launch)
    if (msg.phone && !msg.ignore_opt_out && (await this.db.one('select 1 from opt_outs where phone=$1', [msg.phone]))) {
      await this.finish(msg.id, 'skipped', 'Opted out');
      return 200;
    }

    // Not on WhatsApp → skip without counting as a failure
    if (msg.phone && !msg.chat_id.endsWith('@g.us')) {
      const ok = await this.onWhatsApp(n.session, msg.phone);
      if (ok === false) { await this.finish(msg.id, 'skipped', 'Not on WhatsApp'); return between(300, 900); }
    }

    try {
      if (!config.sendingEnabled) {
        this.log.log(`[dry-run] ${n.label} → ${maskPhone(msg.phone) || msg.chat_id}: ${msg.body.slice(0, 60)}`);
        await this.finish(msg.id, 'sent', null, `dry-run-${msg.id}`);
      } else {
        // Channels have no typing indicator
        if (speed?.typing && !msg.chat_id.endsWith('@newsletter')) {
          await this.waha.startTyping(n.session, msg.chat_id).catch(() => undefined);
          await sleep(typingMs(msg.body) + between(0, 600));
          await this.waha.stopTyping(n.session, msg.chat_id).catch(() => undefined);
        }
        const res = await this.deliver(n.session, msg);
        await this.finish(msg.id, 'sent', null, messageIdOf(res));
      }
      await this.db.query('update wa_numbers set sent_today = sent_today + 1 where id=$1', [numberId]);
    } catch (e) {
      return this.onSendError(n, msg, e as Error);
    }

    if (!speed) return 1500; // test message
    let wait = between(speed.delay_min_ms, speed.delay_max_ms);
    if (!state.burstTarget) state.burstTarget = between(speed.burst_min, speed.burst_max);
    if (++state.burstCount >= state.burstTarget && speed.burst_max > 0) {
      wait += between(speed.burst_pause_min_ms, speed.burst_pause_max_ms);
      state.burstCount = 0;
      state.burstTarget = between(speed.burst_min, speed.burst_max);
    }
    return wait;
  }

  private async deliver(session: string, msg: MessageRow) {
    if (!msg.media_id) return this.waha.sendText(session, msg.chat_id, msg.body);
    const m = await this.db.one<MediaRow>('select * from media where id=$1', [msg.media_id]);
    if (!m) return this.waha.sendText(session, msg.chat_id, msg.body);
    const file = readMedia(m);
    return m.mimetype.startsWith('image/')
      ? this.waha.sendImage(session, msg.chat_id, file, msg.body)
      : this.waha.sendFile(session, msg.chat_id, file, msg.body);
  }

  private async onWhatsApp(session: string, phone: string): Promise<boolean | null> {
    const c = await this.db.one<{ on_whatsapp: boolean }>(
      `select on_whatsapp from phone_checks where phone=$1 and checked_at > now() - ($2 || ' days')::interval`, [phone, PHONE_CHECK_TTL_DAYS]);
    if (c) return c.on_whatsapp;
    if (!config.sendingEnabled) return true;
    try {
      const r = await this.waha.checkExists(session, phone);
      await this.db.query(
        `insert into phone_checks(phone, on_whatsapp, chat_id, checked_at) values ($1,$2,$3,now())
         on conflict (phone) do update set on_whatsapp=excluded.on_whatsapp, chat_id=excluded.chat_id, checked_at=now()`,
        [phone, !!r.numberExists, r.chatId ?? null]);
      return !!r.numberExists;
    } catch {
      return null; // unknown → try sending anyway
    }
  }

  /** Spread-out campaigns that may not send right now (outside window / not a sending day / holiday / daily limit). */
  private async spreadHeld(): Promise<number[]> {
    if (Date.now() - this.spreadCache.at < 10_000) return this.spreadCache.blocked;
    const rows = await this.db.query<{ id: number; schedule: SpreadSchedule; sent_today: number }>(`
      select c.id, c.schedule,
        (select count(*)::int from messages m where m.campaign_id = c.id and (m.sent_at >= $1 or m.status = 'sending')) as sent_today
      from campaigns c where c.status = 'running' and c.schedule->>'mode' = 'spread'`, [atLocal(localDay(new Date()), 0)]);
    const holidays = rows.length ? await this.campaigns.holidays() : new Set<string>();
    const now = new Date();
    this.spreadCache = { at: Date.now(), blocked: rows.filter((r) => spreadBlock(r.schedule, now, r.sent_today, holidays)).map((r) => r.id) };
    return this.spreadCache.blocked;
  }

  private async finish(id: number, status: string, error: string | null, wahaId: string | null = null) {
    await this.db.query(
      `update messages set status=$2, error=$3, waha_id=coalesce($4, waha_id), sent_at = case when $2 = 'sent' then now() else sent_at end where id=$1`,
      [id, status, error, wahaId]);
  }

  private async onSendError(n: NumberRow, msg: MessageRow, e: Error): Promise<number> {
    const status = e instanceof WahaError ? e.status : 0;
    const text = e.message.slice(0, 500);
    // Timed out after the request reached WAHA: it may already be delivered — never auto-retry (avoids duplicates)
    if (e.name === 'AbortError' || /aborted|timeout/i.test(text)) {
      await this.finish(msg.id, 'failed', 'Timed out — may have been delivered. Not retried automatically to avoid a duplicate.');
      return 15_000;
    }
    // Session problem (disconnected / not ready): put back without burning an attempt
    if (/session.*(not|status)|STOPPED|SCAN_QR|FAILED|not.*working/i.test(text) || status === 503) {
      await this.db.query(`update messages set status='queued', attempts=greatest(0, attempts-1), number_id = case when fixed_number then number_id else null end where id=$1`, [msg.id]);
      this.numbers.syncStatuses().catch(() => undefined);
      return 30_000;
    }
    if (msg.attempts < MAX_ATTEMPTS && (status === 0 || status >= 500 || status === 429)) {
      await this.db.query(`update messages set status='queued', error=$2, not_before=now() + ($3 || ' seconds')::interval,
                           number_id = case when fixed_number then number_id else null end where id=$1`, [msg.id, text, 60 * msg.attempts]);
      return status === 429 ? 120_000 : 10_000;
    }
    await this.finish(msg.id, 'failed', text);
    await this.db.query('update wa_numbers set failed_today = failed_today + 1 where id=$1', [n.id]);
    await this.checkAutoPause(n.id);
    return 10_000;
  }

  /** Pauses a number whose failure rate today crosses the threshold, and alerts the admin. */
  private async checkAutoPause(numberId: number) {
    const s = (await this.settings.get()).autoPause;
    const n = await this.db.one<NumberRow>('select * from wa_numbers where id=$1', [numberId]);
    if (!n || n.paused) return;
    const samples = n.sent_today + n.failed_today;
    if (samples < s.minSamples) return;
    const rate = (n.failed_today / samples) * 100;
    if (rate < s.failureRatePct) return;
    const reason = `Auto-paused: ${rate.toFixed(1)}% of messages failed today (${n.failed_today}/${samples})`;
    await this.numbers.setPaused(n.id, true, reason);
    await this.alerts.send(`autopause:${n.id}`, `Number auto-paused: ${n.label}`,
      `${reason}. Sending from "${n.label}" has stopped to protect the number. Check the failed messages, then resume it from Numbers.`, n.id);
  }
}
