import { Injectable } from '@nestjs/common';
import { Db } from '../db/db.service';

export interface SpeedPreset { delayMinMs: number; delayMaxMs: number; burstMin: number; burstMax: number; burstPauseMinMs: number; burstPauseMaxMs: number }

export interface AppSettings {
  quietHours: { enabled: boolean; start: string; end: string };
  speedPresets: Record<'urgent' | 'normal' | 'safe', SpeedPreset>;
  defaultMaxCap: number;
  primaryParent: 'father' | 'mother';
  optOutKeywords: string[];
  optOutReply: string;
  alerts: { adminPhone: string; email: string; whatsapp: boolean; emailEnabled: boolean };
  frappe: { academicYear: string; excludePrograms: string[]; syncEveryHours: number };
  autoPause: { failureRatePct: number; minSamples: number };
  privacy: { maskPhones: boolean; rehideSeconds: number };
}

export const DEFAULT_SETTINGS: AppSettings = {
  quietHours: { enabled: true, start: '22:00', end: '06:00' },
  speedPresets: {
    urgent: { delayMinMs: 1000, delayMaxMs: 3000, burstMin: 40, burstMax: 60, burstPauseMinMs: 30_000, burstPauseMaxMs: 60_000 },
    normal: { delayMinMs: 3000, delayMaxMs: 8000, burstMin: 25, burstMax: 40, burstPauseMinMs: 60_000, burstPauseMaxMs: 180_000 },
    safe: { delayMinMs: 8000, delayMaxMs: 20000, burstMin: 20, burstMax: 30, burstPauseMinMs: 120_000, burstPauseMaxMs: 300_000 },
  },
  defaultMaxCap: 1000,
  primaryParent: 'father',
  optOutKeywords: ['stop', 'unsubscribe'],
  optOutReply: 'You have been unsubscribed and will not receive further messages from this number.',
  alerts: { adminPhone: '', email: '', whatsapp: true, emailEnabled: true },
  frappe: { academicYear: '', excludePrograms: ['Dummy', 'Dummy class'], syncEveryHours: 6 },
  autoPause: { failureRatePct: 5, minSamples: 20 },
  privacy: { maskPhones: true, rehideSeconds: 30 },
};

@Injectable()
export class SettingsService {
  private cache: AppSettings | null = null;
  constructor(private readonly db: Db) {}

  async get(): Promise<AppSettings> {
    if (this.cache) return this.cache;
    const row = await this.db.one<{ value: Partial<AppSettings> }>(`select value from settings where key = 'app'`);
    this.cache = deepMerge(DEFAULT_SETTINGS, row?.value ?? {}) as AppSettings;
    return this.cache;
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = deepMerge(await this.get(), patch) as AppSettings;
    next.optOutKeywords = next.optOutKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
    await this.db.query(
      `insert into settings(key, value, updated_at) values ('app', $1, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [JSON.stringify(next)],
    );
    this.cache = next;
    return next;
  }
}

function deepMerge(base: any, patch: any): any {
  if (Array.isArray(base) || Array.isArray(patch) || typeof base !== 'object' || typeof patch !== 'object' || !base || !patch) {
    return patch === undefined ? base : patch;
  }
  const out: any = { ...base };
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
  return out;
}
