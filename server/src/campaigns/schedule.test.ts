import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atLocal, cleanSchedule, dateMatches, localDay, nextRunAt, parseDate, RepeatSchedule, spreadBlock, spreadPlan, SpreadSchedule, upcoming, variants } from './schedule';

process.env.APP_TIMEZONE = 'Asia/Kolkata';
const none = new Set<string>();
const ist = (day: string, hhmm: string) => atLocal(day, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));

test('atLocal converts IST wall-clock to UTC', () => {
  assert.equal(ist('2026-10-05', '09:06').toISOString(), '2026-10-05T03:36:00.000Z');
  assert.equal(localDay(ist('2026-10-05', '00:10')), '2026-10-05');
});

test('weekdays at 09:06: skips the weekend and holidays', () => {
  const s = cleanSchedule({ mode: 'repeat', freq: 'weekdays', startDate: '2026-10-02', time: { type: 'exact', at: '09:06' }, skipHolidays: true }, '2026-10-02') as RepeatSchedule;
  // Fri 2 Oct 2026, after 09:06 → next is Mon 5 Oct… but 5 Oct is a holiday here → Tue 6 Oct
  const runs = upcoming(s, ist('2026-10-02', '10:00'), 3, new Set(['2026-10-05']));
  assert.deepEqual(runs.map((r) => r.day), ['2026-10-06', '2026-10-07', '2026-10-08']);
  assert.equal(runs[0].at!.toISOString(), '2026-10-06T03:36:00.000Z');
});

test('random window: next run lies inside 9–10 IST', () => {
  const s = cleanSchedule({ mode: 'repeat', freq: 'daily', time: { type: 'random', from: '09:00', to: '10:00' } }, '2026-10-04') as RepeatSchedule;
  for (const r of [0, 0.5, 0.999]) {
    const at = nextRunAt(s, ist('2026-10-04', '08:00'), none, 0, () => r)!;
    assert.ok(at >= ist('2026-10-04', '09:00') && at < ist('2026-10-04', '10:00'), at.toISOString());
  }
  // already inside today's window → still today, but never in the past
  const late = nextRunAt(s, ist('2026-10-04', '09:59'), none, 0, () => 0)!;
  assert.ok(late > ist('2026-10-04', '09:59'));
});

test('monthly on the last day, every N days, and end after N runs', () => {
  const m = cleanSchedule({ mode: 'repeat', freq: 'monthly', monthDay: 'last', time: { type: 'exact', at: '18:00' } }, '2026-01-01') as RepeatSchedule;
  assert.deepEqual(upcoming(m, ist('2026-01-01', '00:00'), 3, none).map((r) => r.day), ['2026-01-31', '2026-02-28', '2026-03-31']);
  const e = cleanSchedule({ mode: 'repeat', freq: 'every', every: 3, startDate: '2026-10-01', time: { type: 'exact', at: '08:00' }, end: { type: 'count', count: 5 } }, '2026-10-01') as RepeatSchedule;
  assert.deepEqual(upcoming(e, ist('2026-10-01', '00:00'), 10, none, 3).map((r) => r.day), ['2026-10-01', '2026-10-04']);
  const d31 = cleanSchedule({ mode: 'repeat', freq: 'monthly', monthDay: 31, time: { type: 'exact', at: '08:00' } }, '2026-04-01') as RepeatSchedule;
  assert.equal(upcoming(d31, ist('2026-04-01', '00:00'), 1, none)[0].day, '2026-04-30');
});

test('cleanSchedule rejects bad input with readable messages', () => {
  assert.throws(() => cleanSchedule({ mode: 'repeat', freq: 'daily', time: { type: 'random', from: '10:00', to: '09:00' } }, '2026-10-04'), /end after/);
  assert.throws(() => cleanSchedule({ mode: 'spread', window: { start: '10:00', end: '16:00' }, days: [], dailyLimit: 400 }, '2026-10-04'), /sending day/);
  assert.equal(cleanSchedule({ mode: 'now' }, '2026-10-04'), null);
});

test('spread: window, weekdays, daily limit and the finishing day', () => {
  const s = cleanSchedule({ mode: 'spread', startAt: ist('2026-10-05', '00:00').toISOString(), window: { start: '10:00', end: '16:00' }, days: [1, 2, 3, 4, 5], dailyLimit: 400, skipHolidays: true }, '2026-10-05') as SpreadSchedule;
  assert.equal(spreadBlock(s, ist('2026-10-05', '09:59'), 0, none), 'outside the sending window');
  assert.equal(spreadBlock(s, ist('2026-10-05', '10:00'), 0, none), null);
  assert.equal(spreadBlock(s, ist('2026-10-05', '12:00'), 400, none), 'daily limit reached');
  assert.equal(spreadBlock(s, ist('2026-10-10', '12:00'), 0, none), 'not a sending day'); // Saturday
  assert.equal(spreadBlock(s, ist('2026-10-04', '12:00'), 0, none), 'not started yet');
  assert.deepEqual(spreadPlan(s, 1565, new Set(['2026-10-07'])), { days: 4, lastDay: '2026-10-09' });
});

test('dates: Indian formats, yearly matching and leap birthdays', () => {
  assert.equal(parseDate('04/10/2026'), '2026-10-04');
  assert.equal(parseDate('4 Oct 2026'), '2026-10-04');
  assert.equal(parseDate('2015-02-29'), null);
  assert.equal(parseDate('31-02-2026'), null);
  assert.equal(parseDate('4-Oct'), '2000-10-04');
  assert.ok(dateMatches('2012-10-04', '2026-10-04', true));
  assert.ok(!dateMatches('2012-10-04', '2026-10-04', false));
  assert.ok(dateMatches('2012-02-29', '2026-02-28', true));
  assert.ok(!dateMatches('2012-02-29', '2028-02-28', true)); // 2028 has a 29th
});

test('variants split on === lines', () => {
  assert.deepEqual(variants('Good morning!\n===\nNamaste!\n=== \nHello'), ['Good morning!', 'Namaste!', 'Hello']);
  assert.deepEqual(variants('Just one'), ['Just one']);
});
