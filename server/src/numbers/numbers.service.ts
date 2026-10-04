import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Db } from '../db/db.service';
import { WahaClient, WahaError } from '../waha/waha.client';
import { AlertsService } from '../alerts/alerts.service';
import { SettingsService } from '../settings/settings.service';
import { effectiveCap, levelFor, nextCap, warmupScore, WarmupInput } from './warmup';
import { localDate } from '../common/time';
import { maskPhone, phoneFromChatId } from '../common/phone';

export interface NumberRow extends WarmupInput {
  id: number; label: string; session: string; phone: string | null; push_name: string | null;
  status: string; status_at: Date; paused: boolean; pause_reason: string | null;
  daily_cap: number; max_cap: number; cap_override: number | null; ramp_enabled: boolean;
  sent_today: number; failed_today: number; counter_date: string | null; disconnects_today: number;
}

const WARMUP_FIELDS = ['age_months', 'avg_chats_day', 'is_business', 'saved_by_contacts', 'past_ban'] as const;

@Injectable()
export class NumbersService implements OnApplicationBootstrap {
  private readonly log = new Logger('Numbers');
  private pendingDisconnect = new Map<number, NodeJS.Timeout>();

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

  async create(body: { label: string } & Partial<WarmupInput> & { max_cap?: number }) {
    const label = (body.label ?? '').trim();
    if (!label) throw new BadRequestException('Label is required');
    const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'number';
    let session = base;
    for (let i = 2; await this.db.one('select 1 from wa_numbers where session = $1', [session]); i++) session = `${base}-${i}`;
    const w = pickWarmup(body);
    const lvl = levelFor(warmupScore(w));
    const max = body.max_cap ?? (await this.settings.get()).defaultMaxCap;
    const row = await this.db.one<NumberRow>(
      `insert into wa_numbers(label, session, age_months, avg_chats_day, is_business, saved_by_contacts, past_ban, daily_cap, max_cap, counter_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [label, session, w.age_months, w.avg_chats_day, w.is_business, w.saved_by_contacts, w.past_ban, Math.min(lvl.startCap, max), max, localDate()],
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
         daily_cap=$8, max_cap=$9, cap_override=$10, ramp_enabled=$11 where id=$1`,
      [id, body.label?.trim() || n.label, w.age_months, w.avg_chats_day, w.is_business, w.saved_by_contacts, w.past_ban,
       daily, max, override, body.ramp_enabled ?? n.ramp_enabled],
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

  async refreshGroups(id: number) {
    const n = await this.get(id);
    if (n.status !== 'WORKING') throw new BadRequestException('Number is not connected');
    const groups = await this.waha.listGroups(n.session);
    await this.db.tx(async (c) => {
      await c.query('delete from wa_groups where number_id=$1', [id]);
      for (const g of groups) {
        await c.query('insert into wa_groups(number_id, chat_id, subject, participants) values ($1,$2,$3,$4) on conflict do nothing', [id, g.chatId, g.subject, g.participants]);
      }
    });
    return this.groups(id);
  }

  groups(id: number) {
    return this.db.query('select chat_id, subject, participants, refreshed_at from wa_groups where number_id=$1 order by subject', [id]);
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
