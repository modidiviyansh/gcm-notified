import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Db } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { WahaClient } from '../waha/waha.client';
import { between, sleep } from '../common/random';
import { inQuietHours } from '../common/time';

/** Every phone the app may message: own lists + parents/students from Frappe. */
const ALL_PHONES = `
  select phone from person_phones
  union select father_phone from students where active and father_phone is not null
  union select mother_phone from students where active and mother_phone is not null
  union select student_phone from students where active and student_phone is not null`;

/**
 * Marks every known number as on / not on WhatsApp, and re-checks each one every N days (default 7).
 * Slow on purpose: a few checks a minute, daytime only, from a number the app may use automatically —
 * a burst of thousands of lookups is the kind of thing WhatsApp notices.
 */
@Injectable()
export class WaCheckService {
  private readonly log = new Logger('WaCheck');
  private running = false;
  private backoffUntil = 0;
  lastError: string | null = null;

  constructor(private readonly db: Db, private readonly settings: SettingsService, private readonly waha: WahaClient) {}

  @Interval(60_000)
  async tick() {
    if (this.running || Date.now() < this.backoffUntil) return;
    const s = await this.settings.get();
    if (!s.waCheck.enabled) return;
    if (s.quietHours.enabled && inQuietHours(s.quietHours.start, s.quietHours.end)) return;
    const n = await this.checker();
    if (!n) return;
    const due = await this.db.query<{ phone: string }>(
      `select a.phone from (${ALL_PHONES}) a left join phone_checks c on c.phone = a.phone
       where c.phone is null or c.checked_at < now() - ($1 || ' days')::interval
       order by c.checked_at nulls first limit $2`, [s.waCheck.everyDays, Math.max(1, Math.ceil(s.waCheck.perHour / 60))]);
    if (!due.length) return;
    this.running = true;
    try {
      for (const { phone } of due) {
        const r = await this.waha.checkExists(n.session, phone);
        await this.db.query(
          `insert into phone_checks(phone, on_whatsapp, chat_id, checked_at) values ($1,$2,$3,now())
           on conflict (phone) do update set on_whatsapp=excluded.on_whatsapp, chat_id=excluded.chat_id, checked_at=now()`,
          [phone, !!r.numberExists, r.chatId ?? null]);
        await sleep(between(2000, 6000));
      }
      this.lastError = null;
    } catch (e) {
      // WhatsApp/WAHA trouble: stop for 15 minutes rather than hammering
      this.lastError = (e as Error).message.slice(0, 200);
      this.backoffUntil = Date.now() + 15 * 60_000;
      this.log.warn(`Paused for 15 min: ${this.lastError}`);
    } finally {
      this.running = false;
    }
  }

  /** The most recently connected number that the app may use on its own. */
  private checker() {
    return this.db.one<{ id: number; label: string; session: string }>(
      `select id, label, session from wa_numbers where status='WORKING' and not paused and auto_use order by status_at desc, id desc limit 1`);
  }

  async status() {
    const s = (await this.settings.get()).waCheck;
    const c = await this.db.one<{ total: number; on: number; off: number; fresh: number; last: Date | null }>(
      `select count(*)::int total,
              count(*) filter (where c.on_whatsapp)::int "on",
              count(*) filter (where c.on_whatsapp = false)::int off,
              count(*) filter (where c.checked_at >= now() - ($1 || ' days')::interval)::int fresh,
              max(c.checked_at) last
       from (${ALL_PHONES}) a left join phone_checks c on c.phone = a.phone`, [s.everyDays]);
    const n = await this.checker();
    const due = (c?.total ?? 0) - (c?.fresh ?? 0);
    return {
      ...s, total: c?.total ?? 0, onWhatsapp: c?.on ?? 0, notOnWhatsapp: c?.off ?? 0, unchecked: (c?.total ?? 0) - (c?.on ?? 0) - (c?.off ?? 0),
      due, lastCheckAt: c?.last ?? null, checker: n?.label ?? null, error: this.lastError,
      hoursToFinish: due ? Math.ceil(due / s.perHour) : 0,
    };
  }
}
