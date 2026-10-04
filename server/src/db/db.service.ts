import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../config';

export const SCHEMA = 'whatsapp';

@Injectable()
export class Db implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Db');
  readonly pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    options: `-c search_path=${SCHEMA}`,
  });

  async onModuleInit() {
    await this.migrate();
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async query<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query<T>(sql, params);
    return r.rows;
  }

  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.query<T>(sql, params))[0];
  }

  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback');
      throw e;
    } finally {
      c.release();
    }
  }

  async event(kind: string, message: string, level: 'info' | 'warn' | 'error' = 'info', data?: unknown) {
    await this.query('insert into events(level, kind, message, data) values ($1,$2,$3,$4)', [level, kind, message, data ?? null]);
  }

  // Applies src/db/migrations/*.sql in order, once each.
  private async migrate() {
    await this.query(`create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`);
    const dir = join(__dirname, 'migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await this.query<{ name: string }>('select name from _migrations')).map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      this.log.log(`Applying migration ${f}`);
      await this.tx(async (c) => {
        await c.query(readFileSync(join(dir, f), 'utf8'));
        await c.query('insert into _migrations(name) values ($1)', [f]);
      });
    }
  }
}
