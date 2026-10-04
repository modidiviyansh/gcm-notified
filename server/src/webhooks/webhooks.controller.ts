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
