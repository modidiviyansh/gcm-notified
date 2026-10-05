import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readSheet } from './sheet';

test('xlsx: shared + inline strings, dates, formulas, long numbers; blank unnamed column dropped', () => {
  const rows = readSheet(readFileSync(join(__dirname, '__fixtures__', 'sample.xlsx')), 'sample.xlsx');
  assert.deepEqual(Object.keys(rows[0]), ['Admission No', 'Name', 'Test Date', 'Marks', 'Mobile']);
  assert.deepEqual(rows[0], { 'Admission No': '10001', Name: 'Asha & Co', 'Test Date': '05-10-2026', Marks: '42.5', Mobile: '919800000001' });
  assert.equal(rows[1]['Admission No'], '00102');
  assert.equal(rows[1].Marks, '0.3');
  assert.equal(rows.length, 2); // empty row skipped
});

test('csv: comma, semicolon, BOM, duplicate headers', () => {
  assert.deepEqual(readSheet(Buffer.from('﻿Name;Phone\nA;98000\n')), [{ Name: 'A', Phone: '98000' }]);
  assert.deepEqual(readSheet(Buffer.from('Marks,Marks,\n1,2,\n\n')), [{ Marks: '1', 'Marks 2': '2' }]);
});

test('old .xls gives a readable error', () => {
  assert.throws(() => readSheet(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(64)]), 'a.xls'), /old Excel file/);
});
