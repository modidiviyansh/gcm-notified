import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptRef, encryptRef, maskDeep } from './privacy';

process.env.SESSION_SECRET ??= 'test-secret-test-secret-test-secret';

test('maskDeep: masks phone keys and personal chat ids, adds refs, keeps the rest', () => {
  const when = new Date('2026-10-04T10:00:00Z');
  const out = maskDeep({
    rows: [{ id: 1, name: 'A', phone: '919876543210', father_phone: '919811122233', mother_phone: null, created_at: when }],
    m: { chat_id: '919876543210@c.us', group: { chat_id: '1203634@g.us' }, extra: { 'Phone 2': '98111 22233', Route: '7' } },
    admission_no: '20261234567', keyType: 'phone',
  }) as any;
  const r = out.rows[0];
  assert.equal(r.phone, '•••••• 3210');
  assert.equal(decryptRef(r.phone_ref), '919876543210');
  assert.equal(r.father_phone, '•••••• 2233');
  assert.equal(r.mother_phone, null);
  assert.equal(r.created_at, when);                     // Dates untouched
  assert.equal(out.m.chat_id, '•••••• 3210');
  assert.equal(decryptRef(out.m.chat_id_ref), '919876543210');
  assert.equal(out.m.group.chat_id, '1203634@g.us');    // groups are not people
  assert.equal(out.m.extra['Phone 2'], '•••••• 2233');
  assert.equal(out.m.extra.Route, '7');
  assert.equal(out.admission_no, '20261234567');
  assert.equal(out.keyType, 'phone');
});

test('refs: tampered or expired refs do not decrypt', () => {
  const ref = encryptRef('919876543210');
  assert.equal(decryptRef(ref), '919876543210');
  assert.equal(decryptRef(ref.slice(0, -2) + (ref.endsWith('A') ? 'BB' : 'AA')), null);
  assert.equal(encryptRef('919876543210'), ref);                 // stable → reveals survive reloads
  assert.notEqual(encryptRef('919876543211'), ref);
  assert.equal(decryptRef(ref, Date.now() + 19 * 3600_000), null);
  assert.equal(decryptRef('garbage'), null);
});
