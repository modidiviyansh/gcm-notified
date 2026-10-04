import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { AlertsService } from '../alerts/alerts.service';
import { Db } from '../db/db.service';
import { Public } from '../auth/auth';
import { config, frappeConfigured, smtpConfigured } from '../config';
import { WahaClient } from '../waha/waha.client';

@Controller()
export class SettingsController {
  constructor(private readonly settings: SettingsService, private readonly alerts: AlertsService, private readonly db: Db, private readonly waha: WahaClient) {}

  @Get('settings') get() { return this.settings.get(); }
  @Put('settings') update(@Body() b: any) { return this.settings.update(b); }
  @Post('settings/test-alert') async testAlert() { await this.alerts.test(); return { ok: true }; }

  @Get('dashboard')
  async dashboard() {
    const [numbers, today, running, recent, events, optOuts] = await Promise.all([
      this.db.query(`select id, label, status, paused, sent_today, failed_today from wa_numbers order by id`),
      this.db.one(`select count(*) filter (where status in ('sent','delivered','read'))::int sent,
                          count(*) filter (where status in ('delivered','read'))::int delivered,
                          count(*) filter (where status='read')::int read,
                          count(*) filter (where status='failed')::int failed
                   from messages where sent_at >= date_trunc('day', now() at time zone $1) at time zone $1 or (status='failed' and created_at > now() - interval '1 day')`, [config.timezone]),
      this.db.query(`select id, name, total, sent, failed, skipped, status from campaigns where status in ('running','paused') order by id desc`),
      this.db.query(`select id, name, status, total, sent, delivered, read, failed, finished_at from campaigns where status in ('completed','cancelled') order by id desc limit 5`),
      this.db.query(`select level, kind, message, created_at from events order by id desc limit 30`),
      this.db.one(`select count(*)::int n from opt_outs`),
    ]);
    return { numbers, today, running, recent, events, optOuts: optOuts?.n ?? 0 };
  }

  @Get('events') events() { return this.db.query('select * from events order by id desc limit 500'); }

  @Get('system')
  async system() {
    let waha: string;
    try { await this.waha.listSessions(); waha = 'ok'; } catch (e) { waha = (e as Error).message; }
    return { waha, frappe: frappeConfigured(), smtp: smtpConfigured(), sendingEnabled: config.sendingEnabled, publicUrl: config.publicUrl, timezone: config.timezone };
  }

  @Public()
  @Get('health')
  async health() {
    await this.db.query('select 1');
    return { ok: true };
  }
}
