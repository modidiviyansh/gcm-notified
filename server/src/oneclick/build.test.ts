import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFees, buildMarks } from './build';

test('marks: one entry per student, subjects sorted, totals and percent', () => {
  const m = buildMarks([
    { student: 'S1', course: 'Science', total_score: 45.5, maximum_score: 50, grade: 'A2' },
    { student: 'S1', course: 'English', total_score: 40, maximum_score: 50, grade: 'B1' },
    { student: 'S2', course: 'English', total_score: 20, maximum_score: 50, grade: '' },
  ], 'Half Yearly');
  const s1 = m.get('S1')!;
  assert.equal(s1.vars.marks, '• English: 40/50 (B1)\n• Science: 45.5/50 (A2)');
  assert.equal(s1.vars.total, '85.5');
  assert.equal(s1.vars.max, '100');
  assert.equal(s1.vars.percent, '85.5');
  assert.equal(s1.summary, '85.5/100 · 85.5%');
  assert.equal(m.get('S2')!.vars.marks, '• English: 20/50');
});

test('fees: sums outstanding, lists by due date, due-by and minimum filters', () => {
  const rows = [
    { name: 'F1', student: 'S1', outstanding_amount: 6000, due_date: '2026-10-15', academic_term: 'Term 2' },
    { name: 'F2', student: 'S1', outstanding_amount: 2500.5, due_date: '2026-07-15', academic_term: 'Term 1' },
    { name: 'F3', student: 'S2', outstanding_amount: 0, due_date: '2026-07-15' },
    { name: 'F4', student: 'S3', outstanding_amount: 300, due_date: '2026-12-01' },
  ];
  const all = buildFees(rows);
  assert.equal(all.get('S1')!.vars.amount, '₹8,500.5');
  assert.equal(all.get('S1')!.vars.fee_list, '• Term 1 — ₹2,500.5 (due 15 Jul 2026)\n• Term 2 — ₹6,000 (due 15 Oct 2026)');
  assert.equal(all.get('S1')!.vars.due_date, '15 Jul 2026');
  assert.ok(!all.has('S2'));
  const due = buildFees(rows, { dueBy: '2026-10-04' });
  assert.equal(due.get('S1')!.vars.amount, '₹2,500.5');
  assert.ok(!due.has('S3'));
  assert.ok(!buildFees(rows, { minAmount: 500 }).has('S3'));
});
