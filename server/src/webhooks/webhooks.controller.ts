import { Controller, ForbiddenException, Headers, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { config } from '../config';
import { Public } from '../auth/auth';
import { Db } from '../db/db.service';
import { NumbersService } from '../numbers/numbers.service';
import { SettingsService } from '../settings/settings.service';
import { WahaClient } from '../waha/waha.client';
import { SenderService } from '../sender/sender.service';
import { phoneFromChatId, maskPhone } from '../common/phone';

// WAHA ack values: -1 ERROR, 0 PENDING, 1 SERVER, 2 DEVICE, 3 READ, 4 PLAYED
const ACK_STATUS: Record<number, 'delivered' | 'read' | undefined> = { 2: 'delivered', 3: 'read', 4: 'read' };
const RANK: Record<string, number> = { queued: 0, sending: 1, sent: 2, delivered: 3, read: 4 };

@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger('Webhook');
  constructor(
    private readonly db: Db, private readonly numbers: NumbersService, private readonly settings: SettingsService,
    private readonly waha: WahaClient, private readonly sender: SenderService,
  ) {}

  @Public()
  @Post('waha')
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }, @Headers('x-webhook-hmac') hmac?: string) {
    this.verify(req.rawBody, hmac);
    const ev = req.body as { event: string; session: string; payload: any; me?: any };
    try {
      if (ev.event === 'session.status') await this.numbers.onStatus(ev.session, ev.payload?.status, ev.me);
      else if (ev.event === 'message.ack') await this.onAck(ev.payload);
      else if (ev.event === 'message') await this.onMessage(ev.session, ev.payload);
      else if (ev.event === 'call.received') await this.onCall(ev.session, ev.payload);
    } catch (e) {
      this.log.error(`${ev.event}: ${(e as Error).message}`);
    }
    return { ok: true };
  }

  private verify(raw: Buffer | undefined, given?: string) {
    if (!raw || !given) throw new ForbiddenException();
    const expected = createHmac('sha512', config.webhookSecret).update(raw).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(given);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ForbiddenException();
  }

  private async onAck(p: any) {
    const status = ACK_STATUS[Number(p?.ack)];
    const id = String(p?.id ?? '');
    if (!status || !id) return;
    const short = id.split('_').pop() ?? id;
    const rows = await this.db.query<{ id: number; status: string; campaign_id: number | null }>(
      `select id, status, campaign_id from messages where waha_id = $1 or waha_id like '%' || $2 limit 5`, [id, `_${short}`]);
    for (const m of rows) {
      if ((RANK[m.status] ?? 9) >= RANK[status]) continue; // never downgrade
      await this.db.query('update messages set status=$2, ack_at=now() where id=$1', [m.id, status]);
      if (m.campaign_id) this.sender.dirtyCampaigns.add(m.campaign_id);
    }
  }

  /**
   * Incoming WhatsApp call. WAHA is a linked device, so the call always rings on the phone itself.
   * Per number: 'ignore' leaves it ringing; 'reject' declines it and (optionally) replies with a message —
   * at most once per caller every 6 hours, so repeated calls don't get repeated replies.
   */
  private async onCall(session: string, p: any) {
    const n = await this.db.one<{ id: number; label: string; call_policy: string; call_reply: string | null }>(
      'select id, label, call_policy, call_reply from wa_numbers where session=$1', [session]);
    if (!n || p?.isGroup) return;
    const from = String(p?.from ?? '');
    let phone = phoneFromChatId(from);
    if (!phone && from.endsWith('@lid')) phone = phoneFromChatId((await this.waha.lidToPhone(session, from).catch(() => null))?.pn ?? null);
    const video = !!p?.isVideo;
    let action = 'ignored';
    if (n.call_policy === 'reject' && from && p?.id) {
      try {
        await this.waha.rejectCall(session, from, String(p.id));
        action = 'rejected';
        const reply = n.call_reply?.trim();
        const recent = phone ? await this.db.one(
          `select 1 from calls where number_id=$1 and phone=$2 and action='rejected+replied' and created_at > now() - interval '6 hours'`, [n.id, phone]) : null;
        if (reply && !recent) {
          await this.waha.sendText(session, phone ? `${phone}@c.us` : from, reply);
          action = 'rejected+replied';
        }
      } catch (e) {
        action = 'failed';
        this.log.warn(`Call reject on ${session} failed: ${(e as Error).message}`);
      }
    }
    await this.db.query('insert into calls(number_id, phone, video, action) values ($1,$2,$3,$4)', [n.id, phone, video, action]);
    const what = { ignored: 'left ringing', rejected: 'declined', 'rejected+replied': 'declined, reply sent', failed: 'could not be declined' }[action];
    await this.db.event('call', `${video ? 'Video call' : 'Call'} from ${maskPhone(phone) || 'hidden number'} on "${n.label}" — ${what}`, action === 'failed' ? 'warn' : 'info');
  }

  /** Incoming message: handle STOP / UNSUBSCRIBE opt-outs. Nothing else is stored. */
  private async onMessage(session: string, p: any) {
    if (!p || p.fromMe) return;
    const from = String(p.from ?? '');
    if (from.endsWith('@g.us') || from === 'status@broadcast') return;
    const text = String(p.body ?? '').trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').trim();
    const s = await this.settings.get();
    if (!s.optOutKeywords.includes(text)) return;

    let phone = phoneFromChatId(from);
    if (!phone && from.endsWith('@lid')) {
      const r = await this.waha.lidToPhone(session, from).catch(() => null);
      phone = phoneFromChatId(r?.pn ?? null);
    }
    if (!phone) { this.log.warn(`Opt-out from unresolvable id ${from}`); return; }

    const res = await this.db.query(`insert into opt_outs(phone, reason) values ($1,'keyword') on conflict do nothing returning phone`, [phone]);
    await this.db.query(`update messages set status='skipped', error='Opted out' where phone=$1 and status='queued'`, [phone]);
    if (res.length) {
      await this.db.event('optout', `${maskPhone(phone)} opted out ("${text}") via ${session}`);
      if (s.optOutReply) await this.waha.sendText(session, from, s.optOutReply).catch(() => undefined);
    }
  }
}
