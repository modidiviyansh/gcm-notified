import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Db } from '../db/db.service';
import { Campaign, CampaignsService } from './campaigns.service';
import { addDays, atLocal, DatedSchedule, localDay, nextRunAt, RepeatSchedule } from './schedule';

const CATCH_UP_MS = 2 * 3600_000;   // if the app was down at run time, still run within 2 hours; later runs are skipped

/** Starts the runs of repeating and date-based campaigns when they are due. */
@Injectable()
export class SchedulerService {
  private readonly log = new Logger('Scheduler');
  private busy = false;
  private waitingLogged = new Set<string>();

  constructor(private readonly db: Db, private readonly campaigns: CampaignsService) {}

  @Interval(30_000)
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = await this.db.query<Campaign>(`select * from campaigns where status='scheduled' and next_run_at <= now() order by next_run_at limit 20`);
      for (const t of due) await this.runOne(t).catch((e) => this.log.error(`Schedule ${t.id}: ${(e as Error).message}`));
    } finally {
      this.busy = false;
    }
  }

  private async runOne(t: Campaign) {
    const s = t.schedule as RepeatSchedule | DatedSchedule;
    const due = t.next_run_at!;
    const day = localDay(due);
    const holidays = await this.campaigns.holidays();
    const advance = async (ran: boolean) => {
      const runs = t.runs + (ran ? 1 : 0);
      // One run per day at most: look for the next one from the following midnight
      const next = nextRunAt(s, new Date(Math.max(Date.now(), atLocal(addDays(day, 1), 0).getTime() - 1)), holidays, runs);
      await this.db.query(
        `update campaigns set next_run_at=$2, runs=$3, last_run_at=case when $4 then now() else last_run_at end,
           status=case when $2::timestamptz is null then 'completed' else status end,
           finished_at=case when $2::timestamptz is null then now() else finished_at end where id=$1`,
        [t.id, next, runs, ran]);
      if (!next) await this.db.event('campaign', `Schedule "${t.name}" finished after ${runs} runs`);
    };

    if (Date.now() - due.getTime() > CATCH_UP_MS) {
      await this.db.event('campaign', `Schedule "${t.name}": the ${day} run was missed (app was offline) and skipped`, 'warn');
      return advance(false);
    }
    // Never overlap: wait while the previous run is still sending
    const busy = await this.db.one(`select id from campaigns where parent_id=$1 and status in ('running','paused') limit 1`, [t.id]);
    if (busy) {
      const k = `${t.id}:${due.toISOString()}`;
      if (!this.waitingLogged.has(k)) {
        this.waitingLogged.add(k);
        await this.db.event('campaign', `Schedule "${t.name}": waiting — the previous run is still sending`, 'warn');
      }
      return;
    }
    const started = await this.campaigns.createRuns(t, day);
    if (started.length) {
      const n = started.reduce((a, r) => a + r.total, 0);
      await this.db.event('campaign', `Schedule "${t.name}": run for ${day} started (${n} messages)`);
    } else if (s.mode === 'repeat') {
      await this.db.event('campaign', `Schedule "${t.name}": nobody to message on ${day}`, 'warn');
    }
    // Date-based schedules count only days that had someone to message
    await advance(s.mode === 'repeat' || started.length > 0);
  }
}
