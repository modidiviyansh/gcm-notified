import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinNames, phonesFor, renderMessage, studentRecipients, contactRecipients, templateVars, StudentRow } from './render';
import { spin } from '../common/random';
import { normalizePhone } from '../common/phone';
import { inQuietHours } from '../common/time';
import { levelFor, nextCap, warmupScore } from '../numbers/warmup';
import { estimate } from './estimate';

const st = (id: number, name: string, f: string | null, m: string | null, extra: Partial<StudentRow> = {}): StudentRow => ({
  id, admission_no: String(10000 + id), student_name: name, program: '5TH', section: '5TH A',
  father_name: 'Mr X', mother_name: 'Mrs X', father_phone: f, mother_phone: m, student_phone: null, ...extra,
});

test('siblings sharing a number get one merged message', () => {
  const kids = [st(1, 'Aarav Sharma', '919876543210', '919811111111', { section: '5TH A' }), st(2, 'Diya Sharma', '919876543210', '919811111111', { program: '2ND', section: '2ND BLOSSOM' })];
  const { recipients } = studentRecipients(kids, 'father', 'father', false);
  assert.equal(recipients.length, 1);
  assert.equal(recipients[0].display, 'Parent of Aarav Sharma & Diya Sharma');
  assert.equal(recipients[0].vars.child_count, 2);
  assert.equal(recipients[0].vars.section, '5TH A & 2ND BLOSSOM');
});

test('per-child mode sends one message per child, spaced by childIndex', () => {
  const kids = [st(1, 'Aarav', '919876543210', null), st(2, 'Diya', '919876543210', null)];
  const { recipients } = studentRecipients(kids, 'father', 'father', true);
  assert.equal(recipients.length, 2);
  assert.deepEqual(recipients.map((r) => r.childIndex), [0, 1]);
});

test('both parents: deduped when father and mother share a number', () => {
  assert.equal(phonesFor(st(1, 'A', '919876543210', '919876543210'), 'both', 'father').length, 1);
  assert.equal(phonesFor(st(1, 'A', '919876543210', '919811111111'), 'both', 'father').length, 2);
});

test('primary falls back to the other parent', () => {
  assert.equal(phonesFor(st(1, 'A', null, '919811111111'), 'primary', 'father')[0].relation, 'Mother');
  assert.equal(phonesFor(st(1, 'A', '919876543210', '919811111111'), 'primary', 'mother')[0].relation, 'Mother');
  assert.equal(phonesFor(st(1, 'A', null, null), 'primary', 'father').length, 0);
});

test('students without numbers are reported', () => {
  const r = studentRecipients([st(1, 'A', null, null), st(2, 'B', '919876543210', null)], 'primary', 'father', false);
  assert.equal(r.noNumber.length, 1);
  assert.equal(r.recipients.length, 1);
});

test('marks template with #each children and CSV variables', () => {
  const kids = [
    st(1, 'Aarav', '919876543210', null, { csv: { 'Admission No': '10001', Subject: 'Maths', Marks: '42', 'Max Marks': '50' } }),
    st(2, 'Diya', '919876543210', null, { section: '2ND BLOSSOM', csv: { 'Admission No': '10002', Subject: 'Maths', Marks: '47', 'Max Marks': '50' } }),
  ];
  const { recipients } = studentRecipients(kids, 'father', 'father', false);
  const out = renderMessage('Dear Parent,\n{{#each children}}• {{student_name}} ({{section}}): {{subject}} {{marks}}/{{max_marks}}\n{{/each}}', recipients[0].vars);
  assert.equal(out, 'Dear Parent,\n• Aarav (5TH A): Maths 42/50\n• Diya (2ND BLOSSOM): Maths 47/50');
});

test('spintax picks one option and leaves {{vars}} alone', () => {
  for (let i = 0; i < 20; i++) {
    const s = spin('{Hello|Hi|Namaste} {{student_name}}');
    assert.match(s, /^(Hello|Hi|Namaste) \{\{student_name\}\}$/);
  }
  assert.equal(renderMessage('{Dear|Respected} Parent of {{student_name}}', { student_name: 'Aarav' }).endsWith('Parent of Aarav'), true);
});

test('templateVars lists used variables', () => {
  assert.deepEqual(templateVars('Hi {{parent_name}} {{#each children}}{{student_name}} {{marks}}{{/each}}').sort(), ['marks', 'parent_name', 'student_name']);
});

test('joinNames', () => {
  assert.equal(joinNames(['A']), 'A');
  assert.equal(joinNames(['A', 'B', 'C']), 'A, B & C');
  assert.equal(joinNames(['A', 'A']), 'A');
});

test('contact recipients are deduped by phone', () => {
  const r = contactRecipients([{ id: 1, name: 'X', phone: '919876543210' }, { id: 2, name: 'Y', phone: '919876543210' }]);
  assert.equal(r.length, 1);
});

test('phone normalisation (India)', () => {
  assert.equal(normalizePhone('98765 43210'), '919876543210');
  assert.equal(normalizePhone('+91-98765-43210'), '919876543210');
  assert.equal(normalizePhone('09876543210'), '919876543210');
  assert.equal(normalizePhone('919876543210'), '919876543210');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone(''), null);
});

test('quiet hours wrap midnight (IST)', () => {
  // 23:30 IST = 18:00 UTC ; 07:00 IST = 01:30 UTC ; 05:59 IST = 00:29 UTC
  assert.equal(inQuietHours('22:00', '06:00', new Date('2026-10-04T18:00:00Z')), true);
  assert.equal(inQuietHours('22:00', '06:00', new Date('2026-10-04T00:29:00Z')), true);
  assert.equal(inQuietHours('22:00', '06:00', new Date('2026-10-04T01:30:00Z')), false);
});

test('warm-up scoring for a 6-month, busy, business number', () => {
  const score = warmupScore({ age_months: 6, avg_chats_day: 30, is_business: true, saved_by_contacts: true, past_ban: false });
  assert.equal(score, 70);
  assert.equal(levelFor(score).level, 'Trusted');
  assert.equal(levelFor(0).level, 'Cold');
  assert.equal(nextCap(400, 1000, 10, 350, true), 440);
  assert.equal(nextCap(400, 1000, 10, 100, true), 400); // under-used → no ramp
  assert.equal(nextCap(400, 1000, 10, 400, false), 400); // unhealthy → no ramp
  assert.equal(nextCap(990, 1000, 10, 990, true), 1000);
});

test('estimate: normal preset, 1000 messages, 3 numbers', () => {
  const e = estimate(1000, [{ remaining: 400 }, { remaining: 400 }, { remaining: 400 }],
    { delay_min_ms: 3000, delay_max_ms: 8000, burst_min: 25, burst_max: 40, burst_pause_min_ms: 60000, burst_pause_max_ms: 180000, typing: true });
  assert.equal(e.overflow, 0);
  assert.ok(e.minutesToday > 30 && e.minutesToday < 90, `minutes ${e.minutesToday}`);
  assert.equal(e.risk, 'medium');
});
