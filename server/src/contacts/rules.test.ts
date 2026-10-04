import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanRule, labelForColumn, PersonPhone, pickPhones, resolveRule } from './rules';
import { detectPhoneColumns, parsePaste } from './people.service';
import { phonesFor, StudentRow } from '../campaigns/render';

const staff: PersonPhone[] = [
  { phone: '919800000001', label: 'Personal', is_primary: true },
  { phone: '919800000002', label: 'Work', is_primary: false },
];

test('pickPhones: primary, all, labels in order with fallback', () => {
  assert.deepEqual(pickPhones(staff, { use: 'primary' }).picked.map((p) => p.label), ['Personal']);
  assert.equal(pickPhones(staff, { use: 'all' }).picked.length, 2);
  assert.deepEqual(pickPhones(staff, { use: 'labels', labels: ['work', 'Personal'], mode: 'first' }).picked.map((p) => p.label), ['Work']);
  const fb = pickPhones(staff, { use: 'labels', labels: ['Home'], mode: 'first' });
  assert.equal(fb.fallback, true);
  assert.equal(fb.picked[0].label, 'Personal');
  assert.equal(pickPhones(staff, { use: 'labels', labels: ['Work', 'Personal'], mode: 'all' }).picked.length, 2);
  assert.equal(pickPhones([], { use: 'all' }).picked.length, 0);
});

test('resolveRule: campaign → person → list → parent list → type', () => {
  const work = { use: 'labels' as const, labels: ['Work'], mode: 'first' as const };
  const all = { use: 'all' as const };
  assert.equal(resolveRule('notice', { campaign: all, person: { notice: work } }).source, 'campaign');
  assert.equal(resolveRule('notice', { person: { '*': work }, list: { notice: all } }).source, 'person');
  assert.equal(resolveRule('notice', { list: { invitation: work }, parentList: { notice: all } }).rule.use, 'all');
  const r = resolveRule('notice', { list: {}, typeDefault: null });
  assert.equal(r.source, 'type');
  assert.equal(r.rule.use, 'primary');
});

test('cleanRule rejects junk and empty label lists', () => {
  assert.equal(cleanRule({ use: 'labels', labels: [] }), null);
  assert.equal(cleanRule({ use: 'nope' }), null);
  assert.deepEqual(cleanRule({ use: 'labels', labels: [' Work ', 'Work'] }), { use: 'labels', labels: ['Work'], mode: 'first' });
});

test('parsePaste: a named line with two numbers is one person; bare numbers are separate people', () => {
  const p = parsePaste('Ravi Kumar, 98765 43210, 98111 22233\n98000 01234, 98000 05678\n9800009999 Test Three');
  assert.equal(p.length, 4);
  assert.equal(p[0].name, 'Ravi Kumar');
  assert.deepEqual(p[0].phones.map((x) => x.label), ['Mobile', 'Mobile 2']);
  assert.equal(p[1].name, null);
  assert.equal(p[3].name, 'Test Three');
});

test('CSV phone columns are found by header or by their values, and labelled', () => {
  const rows = [
    { Name: 'A', 'Work Phone': '98000 00001', 'Mobile 2': '9800000002', Dept: 'Maths', 'Admission No': '20261234567' },
    { Name: 'B', 'Work Phone': '', 'Mobile 2': '9800000003', Dept: 'Science', 'Admission No': '20261234568' },
  ];
  assert.deepEqual(detectPhoneColumns(rows), [{ column: 'Work Phone', label: 'Work' }, { column: 'Mobile 2', label: 'Mobile 2' }]);
  assert.equal(labelForColumn('Phone'), 'Mobile');
  assert.equal(labelForColumn('Personal Mobile'), 'Personal');
  assert.equal(labelForColumn('Phone 2'), 'Mobile 2');
});

test('school "all" mode reaches father, mother and student once each', () => {
  const s = { id: 1, admission_no: '1', student_name: 'A', program: null, section: null, father_name: null, mother_name: null,
    father_phone: '919800000001', mother_phone: '919800000001', student_phone: '919800000003' } as StudentRow;
  assert.deepEqual(phonesFor(s, 'all', 'father').map((x) => x.relation), ['Father', 'Student']);
});
