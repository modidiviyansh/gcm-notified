import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseChats, limitBlockReason, parseLimits } from './detect';

const now = Date.UTC(2026, 9, 4);
const ago = (days: number) => Math.floor((now - days * 86_400_000) / 1000);

test('analyseChats: age from oldest chat, chats/day from recent direct chats only', () => {
  const chats = [
    ...Array.from({ length: 14 }, (_, i) => ({ id: `9198${i}@c.us`, ts: ago(i % 7) })),        // 14 people in 7 days
    ...Array.from({ length: 16 }, (_, i) => ({ id: `${i}@lid`, ts: ago(10 + i) })),             // 16 more in 30 days
    { id: '120363@g.us', ts: ago(0) },                                                           // group — ignored
    { id: '1203@newsletter', ts: ago(0) },                                                       // channel — ignored
  ];
  const r = analyseChats(chats, ago(400), now);
  assert.equal(r.ageMonths, 13);
  assert.equal(r.oldestChat, new Date(ago(400) * 1000).toISOString().slice(0, 10));
  assert.equal(r.activeChats7d, 14);
  assert.equal(r.activeChats30d, 30);
  assert.equal(r.chatsPerDay, 2); // max(14/7, 30/30) = 2
});

test('analyseChats: nothing synced yet → unknown age', () => {
  const r = analyseChats([], null, now);
  assert.equal(r.ageMonths, null);
  assert.equal(r.chatsPerDay, 0);
});

test('parseLimits: no capping, no timelock (what a healthy number reports)', () => {
  const l = parseLimits({ messageCapping: { cappingStatus: 'NONE', totalQuota: -1, usedQuota: 0, cycleEnd: 1793471399 }, reachoutTimelock: null }, now);
  assert.equal(l.capping?.remaining, null);
  assert.equal(l.timelock, null);
  assert.equal(limitBlockReason(l), null);
});

test('parseLimits: active timelock blocks; expired one does not', () => {
  const active = parseLimits({ reachoutTimelock: { isActive: true, timeEnforcementEnds: ago(-2) } }, now);
  assert.equal(active.timelock?.active, true);
  assert.match(limitBlockReason(active)!, /restricted/);
  const expired = parseLimits({ reachoutTimelock: { isActive: true, timeEnforcementEnds: ago(1) } }, now);
  assert.equal(expired.timelock?.active, false);
  assert.equal(limitBlockReason(expired), null);
});

test('parseLimits: used-up quota blocks', () => {
  const l = parseLimits({ messageCapping: { cappingStatus: 'CAPPED', totalQuota: 50, usedQuota: 50, cycleEnd: ago(-5) } }, now);
  assert.equal(l.capping?.remaining, 0);
  assert.match(limitBlockReason(l)!, /quota/);
});
