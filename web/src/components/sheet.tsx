import { useRef, useState } from 'react';
import { api } from '../api';
import { Badge, useToast } from './ui';

export type Source = 'lists' | 'admission' | 'phone';

export const SOURCES: { key: Source; icon: string; title: string; text: string }[] = [
  { key: 'lists', icon: '🏫', title: 'Classes & my lists', text: 'Pick school classes, sections or your saved contact lists.' },
  { key: 'admission', icon: '🎓', title: 'Sheet with admission numbers', text: 'Marks, dues, PTM slots… matched to students. Parents’ numbers come from school records.' },
  { key: 'phone', icon: '📇', title: 'Sheet with phone numbers', text: 'Your own list — staff, guests, alumni, anyone. Each row has its own number.' },
];

/** Ready-made sheets to start from (fake sample data). */
const SAMPLES: Record<'admission' | 'phone', { name: string; rows: string[][] }[]> = {
  admission: [
    { name: 'Marks', rows: [['Admission No', 'Test', 'Maths', 'Science', 'English', 'Total', 'Out Of', 'Remarks'], ['10001', 'Unit Test 2', '42', '38', '45', '125', '150', 'Good progress']] },
    { name: 'Fee dues', rows: [['Admission No', 'Fee Head', 'Amount Due', 'Due Date'], ['10001', 'Term 2 tuition', '6000', '15-10-2026']] },
    { name: 'PTM slots', rows: [['Admission No', 'PTM Date', 'Time Slot', 'Teacher'], ['10001', '12-10-2026', '10:30 AM', 'Mrs Sharma']] },
    { name: 'Blank', rows: [['Admission No', 'Detail 1', 'Detail 2'], ['10001', '', '']] },
  ],
  phone: [
    { name: 'Event invite', rows: [['Name', 'Phone', 'Event', 'Date', 'Venue'], ['Asha Verma', '98000 00001', 'Annual Day', '20-12-2026', 'School Auditorium']] },
    { name: 'Staff notice', rows: [['Name', 'Mobile', 'Department'], ['R. K. Gupta', '98000 00002', 'Accounts']] },
    { name: 'Simple list', rows: [['Name', 'Phone'], ['Asha Verma', '98000 00001']] },
  ],
};

function download(name: string, rows: string[][]) {
  const csv = '﻿' + rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\n') + '\n';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${name.toLowerCase().replace(/\s+/g, '-')}-sample.csv`;
  a.click();
}

export function SourcePicker({ value, onChange }: { value: Source; onChange: (s: Source) => void }) {
  return (
    <div className="grid gap-3 md:grid-cols-3">
      {SOURCES.map((s) => (
        <button key={s.key} type="button" onClick={() => onChange(s.key)}
          className={`rounded-lg border p-3 text-left transition ${value === s.key ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-100' : 'border-slate-200 hover:bg-slate-50'}`}>
          <div className="text-sm font-medium"><span className="mr-1.5">{s.icon}</span>{s.title}</div>
          <div className="mt-1 text-xs text-slate-500">{s.text}</div>
        </button>
      ))}
    </div>
  );
}

const ACCEPT = '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Upload a sheet, pick which column is what, see every column as a message variable. */
export function SheetPanel({ mode, campaignId, csv, onCsv }: { mode: 'admission' | 'phone'; campaignId: number; csv: any; onCsv: (info: any) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [showBad, setShowBad] = useState(false);
  const mine = csv && csv.keyType === mode ? csv : null;

  const upload = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await api.upload(`/campaigns/${campaignId}/csv`, f, { mode });
      onCsv(r);
      toast(`${r.matched} of ${r.rows} rows ready${r.unmatched ? ` · ${r.unmatched} need a look` : ''}`, r.matched ? undefined : 'error');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const remap = async (patch: { keyColumn?: string; nameColumn?: string | null }) => {
    try { onCsv(await api.put(`/campaigns/${campaignId}/csv`, { mode, ...patch })); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const remove = async () => { await api.del(`/campaigns/${campaignId}/csv`); onCsv(null); };
  const copyVar = (v: string) => navigator.clipboard.writeText(`{{${v}}}`).then(() => toast(`Copied {{${v}}} — paste it into the message`), () => undefined);
  const varOf = (col: string) => col.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        {mode === 'admission' ? (
          <>Your sheet needs an <b>admission number</b> column; every other column (marks, amount, date, remarks…) can be used in the message.
            Phone numbers and parent names come from the school records, so leave them out. <span className="text-slate-500">One row per student.</span></>
        ) : (
          <>Your sheet needs a <b>mobile number</b> column, ideally a <b>name</b> column, and any other columns you want to use in the message.
            Use this for people who aren't students.</>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500">Start from a sample:</span>
          {SAMPLES[mode].map((s) => (
            <button key={s.name} type="button" className="rounded-md bg-white px-2 py-1 ring-1 ring-slate-200 hover:bg-brand-50 hover:ring-brand-200" onClick={() => download(s.name, s.rows)}>⬇ {s.name}</button>
          ))}
        </div>
      </div>

      <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
      {!mine ? (
        <button type="button" disabled={busy}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files?.[0]); }}
          className={`flex w-full flex-col items-center rounded-lg border-2 border-dashed px-4 py-8 text-center transition ${drag ? 'border-brand-600 bg-brand-50' : 'border-slate-300 hover:border-brand-400 hover:bg-slate-50'}`}>
          <span className="text-2xl">{busy ? '⏳' : '📄'}</span>
          <span className="mt-1 text-sm font-medium text-slate-700">{busy ? 'Reading the sheet…' : 'Drop your Excel or CSV file here, or click to choose'}</span>
          <span className="mt-0.5 text-xs text-slate-500">.xlsx or .csv · first row = column names · up to 20,000 rows</span>
        </button>
      ) : (
        <div className="rounded-lg border border-slate-200">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-100 px-3 py-2 text-sm">
            <b className="truncate">📄 {mine.filename}</b>
            <span className="text-slate-500">{mine.rows} rows</span>
            <span className="text-emerald-700">✓ {mine.matched} ready</span>
            {mine.unmatched > 0 && <button type="button" className="text-red-600 hover:underline" onClick={() => setShowBad((x) => !x)}>⚠ {mine.unmatched} not matched {showBad ? '▴' : '▾'}</button>}
            {mine.duplicates > 0 && <span className="text-amber-700" title={mode === 'phone' ? 'The same number appears more than once — it gets the message once' : 'The same student appears more than once — the first row is used'}>{mine.duplicates} repeated</span>}
            <span className="flex-1" />
            <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => input.current?.click()}>{busy ? 'Uploading…' : 'Replace file'}</button>
            <button type="button" className="text-xs text-red-600 hover:underline" onClick={remove}>Remove</button>
          </div>
          {showBad && mine.unmatchedSamples?.length > 0 && (
            <ul className="border-b border-slate-100 bg-red-50/50 px-3 py-2 text-xs text-red-700">
              {mine.unmatchedSamples.map((x: string) => <li key={x}>{x}</li>)}
              {mine.unmatched > mine.unmatchedSamples.length && <li>…and {mine.unmatched - mine.unmatchedSamples.length} more</li>}
              {mode === 'admission' && <li className="mt-1 text-slate-600">Admission numbers are matched to students synced from the school system (leading zeros don't matter).</li>}
            </ul>
          )}
          <div className="grid gap-3 border-b border-slate-100 px-3 py-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="label">{mode === 'admission' ? 'Admission number is in' : 'Mobile number is in'}</span>
              <select className="input" value={mine.keyColumn} onChange={(e) => remap({ keyColumn: e.target.value })}>
                {mine.columns.map((col: string) => <option key={col} value={col}>{col}</option>)}
              </select>
            </label>
            {mode === 'phone' && (
              <label className="block text-sm">
                <span className="label">Name is in</span>
                <select className="input" value={mine.nameColumn ?? ''} onChange={(e) => remap({ nameColumn: e.target.value || null })}>
                  <option value="">— no name column —</option>
                  {mine.columns.filter((col: string) => col !== mine.keyColumn).map((col: string) => <option key={col} value={col}>{col}</option>)}
                </select>
              </label>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Column</th><th>Use in the message as</th><th>Example</th></tr></thead>
              <tbody>{mine.columns.map((col: string) => {
                const isKey = col === mine.keyColumn, isName = col === mine.nameColumn;
                const ex = mine.examples?.[col] ?? '';
                return (
                  <tr key={col}>
                    <td className="font-medium">{col} {isKey && <Badge tone="blue">{mode === 'admission' ? 'admission no.' : 'mobile'}</Badge>} {isName && <Badge tone="blue">name</Badge>}</td>
                    <td>{varOf(col) && <button type="button" onClick={() => copyVar(isName ? 'name' : varOf(col))} title="Copy" className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs hover:bg-brand-50">{`{{${isName ? 'name' : varOf(col)}}}`}</button>}</td>
                    <td className="max-w-[16rem] truncate text-xs text-slate-500">{isKey && mode === 'phone' && ex ? `•••••• ${ex.replace(/\D/g, '').slice(-4)}` : ex || '—'}</td>
                  </tr>);
              })}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
