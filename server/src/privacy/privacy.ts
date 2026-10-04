import { BadRequestException, Body, CallHandler, Controller, ExecutionContext, Injectable, NestInterceptor, Post } from '@nestjs/common';
import type { Request } from 'express';
import { from, Observable, switchMap } from 'rxjs';
import { Db } from '../db/db.service';
import { SettingsService } from '../settings/settings.service';
import { decryptRef, maskDeep } from '../common/privacy';

// Routes whose responses are never masked: settings (holds the admin's own alert number), auth, reveal itself
const SKIP = /^\/api\/(settings|auth|reveal|health|webhooks|media)(\/|$|\?)/;

@Injectable()
export class PhoneMaskInterceptor implements NestInterceptor {
  constructor(private readonly settings: SettingsService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request>();
    if (SKIP.test(req.originalUrl ?? req.url)) return next.handle();
    return next.handle().pipe(switchMap((data) => from(this.settings.get().then((s) => (s.privacy.maskPhones ? maskDeep(data) : data)))));
  }
}

@Controller()
export class PrivacyController {
  constructor(private readonly db: Db) {}

  /** Turns masked references back into numbers. One call = one Activity entry. */
  @Post('reveal')
  async reveal(@Body() b: { refs?: string[]; where?: string }) {
    const refs = [...new Set((b.refs ?? []).filter((r) => typeof r === 'string'))].slice(0, 2000);
    if (!refs.length) throw new BadRequestException('Nothing to reveal');
    const phones: Record<string, string> = {};
    for (const r of refs) { const p = decryptRef(r); if (p) phones[r] = p; }
    const list = Object.values(phones);
    if (!list.length) throw new BadRequestException('These numbers expired — reload the page');
    const where = String(b.where ?? '').replace(/[^\w\s/·-]/g, '').slice(0, 60) || 'the dashboard';
    const msg = list.length === 1 ? `Viewed number ending ${list[0].slice(-4)} on ${where}` : `Viewed ${list.length} numbers on ${where}`;
    await this.db.event('privacy.reveal', msg, 'info', list.length === 1 ? null : { endings: list.slice(0, 50).map((p) => p.slice(-4)) });
    return { phones };
  }
}
