import { ReactNode, useEffect, useRef, useState } from 'react';
import { api, fmtDate } from '../api';
import { Field, useLoad } from './ui';

// Mirrors server/src/campaigns/schedule.ts
type TimeSpec = { type: 'exact'; at: string } | { type: 'random'; from: string; to: string };
export type Schedule =
  | { mode: 'now' }
  | { mode: 'spread'; startAt: string; window: { start: string; end: string }; days: number[]; dailyLimit: number; skipHolidays: boolean }
  | { mode: 'repeat'; freq: 'daily' | 'weekdays' | 'days' | 'every' | 'monthly'; days?: number[]; every?: number; monthDay?: number | 'last'; startDate: string; time: TimeSpec;
      end: { type: 'never' } | { type: 'date'; date: string } | { type: 'count'; count: number }; skipHolidays: boolean }
  | { mode: 'dated'; source: { type: 'birthday' } | { type: 'column'; column: string; yearly: boolean }; steps: { offset: number; body: string }[]; time: TimeSpec; startDate: string };

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const today = () => new Date().toLocaleDateString('en-CA');
const OFFSETS = [-30, -14, -7, -5, -3, -2, -1, 0, 1, 2, 3, 7];
export const offsetLabel = (o: number) => (o === 0 ? 'On the day' : o < 0 ? `${-o} day${o === -1 ? '' : 's'} before` : `${o} day${o === 1 ? '' : 's'} after`);
export const isTemplateSchedule = (s?: Schedule | null) => s?.mode === 'repeat' || s?.mode === 'dated';

const DEFAULTS: Record<Schedule['mode'], () => Schedule> = {
  now: () => ({ mode: 'now' }),
  spread: () => ({ mode: 'spread', startAt: new Date().toISOString(), window: { start: '10:00', end: '16:00' }, days: [1, 2, 3, 4, 5, 6], dailyLimit: 400, skipHolidays: true }),
  repeat: () => ({ mode: 'repeat', freq: 'weekdays', days: [1, 2, 3, 4, 5], startDate: today(), time: { type: 'exact', at: '09:00' }, end: { type: 'never' }, skipHolidays: true }),
  dated: () => ({ mode: 'dated', source: { type: 'birthday' }, steps: [{ offset: 0, body: '' }], time: { type: 'random', from: '08:00', to: '09:00' }, startDate: today() }),
};

const daysText = (d: number[]) => {
  const k = [...d].sort().join(',');
  if (k === '1,2,3,4,5') return 'Mon–Fri';
  if (k === '1,2,3,4,5,6') return 'Mon–Sat';
  if (k === '0,1,2,3,4,5,6') return 'every day';
  return WEEK.filter((x) => d.includes(x)).map((x) => DAY[x]).join(', ');
};
const timeText = (t: TimeSpec) => (t.type === 'exact' ? `at ${t.at}` : `at a random time ${t.from}–${t.to}`);

export function describeSchedule(s?: Schedule | null): string {
  if (!s || s.mode === 'now') return 'Send now';
  if (s.mode === 'spread') return `Spread out: ${s.window.start}–${s.window.end}, ${daysText(s.days)}, up to ${s.dailyLimit}/day${s.skipHolidays ? ', not on holidays' : ''}`;
  if (s.mode === 'repeat') {
    const f = s.freq === 'daily' ? 'Every day' : s.freq === 'weekdays' || s.freq === 'days' ? daysText(s.days ?? []) : s.freq === 'every' ? `Every ${s.every} days`
      : `Monthly on ${s.monthDay === 'last' ? 'the last day' : `day ${s.monthDay}`}`;
    const end = s.end.type === 'date' ? `, until ${s.end.date}` : s.end.type === 'count' ? `, ${s.end.count} times` : '';
    return `${f[0].toUpperCase()}${f.slice(1)} ${timeText(s.time)}${s.skipHolidays ? ', not on holidays' : ''}${end}`;
  }
  const src = s.source.type === 'birthday' ? 'student birthdays' : `“${s.source.column}”${s.source.yearly ? ' (every year)' : ''}`;
  return `Date-based on ${src}: ${s.steps.map((x) => offsetLabel(x.offset).toLowerCase()).join(', ')} — ${timeText(s.time)}`;
}

const localInput = (iso: string) => { const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const runText = (r: { day: string; at: string | null; from?: string; to?: string }) => {
  const d = new Date(`${r.day}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  return r.at ? `${d}, ${new Date(r.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : `${d}, between ${r.from}–${r.to}`;
};

/** Upcoming runs / spread-out plan, as returned by GET /campaigns/:id/schedule. */
export function SchedulePlan({ plan }: { plan: any }) {
  if (!plan || plan.mode === 'now') return null;
  if (plan.mode === 'spread') {
    return <p className="text-sm text-slate-600">{plan.total ? <>{plan.total} messages → <b>{plan.days}</b> sending day{plan.days === 1 ? '' : 's'}{plan.lastDay ? <>, finishing about <b>{new Date(`${plan.lastDay}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</b></> : ''}.</> : 'Choose who receives it to see how many days it takes.'}</p>;
  }
  if (plan.mode === 'repeat') {
    return plan.runs?.length
      ? <div className="text-sm"><span className="text-slate-500">Next runs: </span>{plan.runs.map((r: any) => <span key={r.day} className="mr-1.5 inline-block rounded-full bg-slate-100 px-2 py-0.5 text-xs">{runText(r)}</span>)}</div>
      : <p className="text-sm text-red-600">No upcoming runs — check the start and end dates.</p>;
  }
  return plan.days?.length
    ? <div className="space-y-1 text-sm"><span className="text-slate-500">Coming up in the next month:</span>
        {plan.days.map((d: any) => <div key={d.day} className="text-xs"><b>{runText(d)}</b> — {d.steps.map((s: any) => `${s.n} ${s.label.toLowerCase()}`).join(' · ')}</div>)}</div>
    : <p className="text-sm text-slate-500">Nobody to message in the next month (no matching dates yet).</p>;
}

function Chips<T extends string | number>({ options, value, onChange }: { options: [T, ReactNode][]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map(([k, l]) => {
        const on = value.includes(k);
        return <button key={String(k)} type="button" onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}
          className={`rounded-md px-2.5 py-1 text-xs ${on ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{l}</button>;
      })}
    </div>
  );
}

function TimePick({ value, onChange }: { value: TimeSpec; onChange: (t: TimeSpec) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-1.5"><input type="radio" checked={value.type === 'exact'} onChange={() => onChange({ type: 'exact', at: value.type === 'random' ? value.from : value.at })} />At</label>
      <input type="time" className="input w-28 py-1" disabled={value.type !== 'exact'} value={value.type === 'exact' ? value.at : ''} onChange={(e) => onChange({ type: 'exact', at: e.target.value })} />
      <label className="ml-2 flex items-center gap-1.5"><input type="radio" checked={value.type === 'random'} onChange={() => {
        const at = value.type === 'exact' ? value.at : '09:00'; const h = Number(at.slice(0, 2));
        onChange({ type: 'random', from: `${String(h).padStart(2, '0')}:00`, to: `${String(Math.min(h + 1, 23)).padStart(2, '0')}:00` });
      }} />Random time between</label>
      <input type="time" className="input w-28 py-1" disabled={value.type !== 'random'} value={value.type === 'random' ? value.from : ''} onChange={(e) => value.type === 'random' && onChange({ ...value, from: e.target.value })} />
      <span>and</span>
      <input type="time" className="input w-28 py-1" disabled={value.type !== 'random'} value={value.type === 'random' ? value.to : ''} onChange={(e) => value.type === 'random' && onChange({ ...value, to: e.target.value })} />
    </div>
  );
}

const MODES: [Schedule['mode'], string, string][] = [
  ['now', 'Send now', 'Starts as soon as you launch'],
  ['spread', 'Once, spread out', 'Only inside a daily window, with a daily limit'],
  ['repeat', 'Repeating', 'Daily, weekdays, weekly, monthly…'],
  ['dated', 'Date-based', 'Birthdays, due dates — before / on / after'],
];

/** The "When" step. Saves to the campaign (validated by the server) and shows what will happen. */
export function WhenPicker({ c, isGroups, onSaved }: { c: any; isGroups: boolean; onSaved: (c: any) => void }) {
  const [s, setS] = useState<Schedule>(c.schedule ?? { mode: 'now' });
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState<any>(null);
  const timer = useRef<number | undefined>(undefined);
  const groupIds: number[] = c.audience.groupIds ?? [];
  const { data: columns } = useLoad(() => (groupIds.length ? api.get<string[]>(`/columns?groupIds=${groupIds.join(',')}`) : Promise.resolve([])), [groupIds.join(',')]);

  const save = (next: Schedule, delay = 700) => {
    setS(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      try {
        const updated = await api.put(`/campaigns/${c.id}`, { schedule: next.mode === 'now' ? null : next });
        setErr(null); onSaved(updated);
        setPlan(next.mode === 'now' ? null : await api.get(`/campaigns/${c.id}/schedule`));
      } catch (e) { setErr((e as Error).message); }
    }, delay);
  };
  useEffect(() => { if (s.mode !== 'now') api.get(`/campaigns/${c.id}/schedule`).then(setPlan).catch(() => {}); }, [c.id, groupIds.join(','), c.audience.csv?.rows]);
  const set = (patch: any) => save({ ...s, ...patch } as Schedule);
  const modes = isGroups ? MODES.filter(([m]) => m !== 'dated') : MODES;

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {modes.map(([m, t, d]) => (
          <button key={m} type="button" onClick={() => s.mode !== m && save(c.schedule?.mode === m ? c.schedule : DEFAULTS[m](), 0)}
            className={`rounded-lg border px-3 py-2.5 text-left ${s.mode === m ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-100' : 'border-slate-200 hover:bg-slate-50'}`}>
            <div className="text-sm font-medium">{t}</div><div className="mt-0.5 text-xs text-slate-500">{d}</div>
          </button>
        ))}
      </div>

      {s.mode === 'spread' && (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Start"><input type="datetime-local" className="input" value={localInput(s.startAt)} onChange={(e) => e.target.value && set({ startAt: new Date(e.target.value).toISOString() })} /></Field>
          <Field label="Send only between">
            <div className="flex items-center gap-2"><input type="time" className="input" value={s.window.start} onChange={(e) => set({ window: { ...s.window, start: e.target.value } })} /><span>and</span>
              <input type="time" className="input" value={s.window.end} onChange={(e) => set({ window: { ...s.window, end: e.target.value } })} /></div>
          </Field>
          <Field label="On"><Chips options={WEEK.map((d) => [d, DAY[d]] as [number, string])} value={s.days} onChange={(days) => set({ days })} /></Field>
          <Field label="At most per day (this campaign)"><input type="number" min={1} className="input" value={s.dailyLimit} onChange={(e) => set({ dailyLimit: Number(e.target.value) })} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.skipHolidays} onChange={(e) => set({ skipHolidays: e.target.checked })} />Don't send on school holidays</label>
        </div>
      )}

      {s.mode === 'repeat' && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="How often">
              <select className="input" value={s.freq} onChange={(e) => {
                const freq = e.target.value as typeof s.freq;
                set({ freq, days: freq === 'weekdays' ? [1, 2, 3, 4, 5] : freq === 'days' ? (s.days?.length ? s.days : [1]) : s.days, every: s.every ?? 2, monthDay: s.monthDay ?? 1 });
              }}>
                <option value="daily">Every day</option><option value="weekdays">Weekdays (Mon–Fri)</option><option value="days">On chosen days</option>
                <option value="every">Every N days</option><option value="monthly">Monthly</option>
              </select>
            </Field>
            {s.freq === 'days' && <Field label="Days"><Chips options={WEEK.map((d) => [d, DAY[d]] as [number, string])} value={s.days ?? []} onChange={(days) => set({ days })} /></Field>}
            {s.freq === 'every' && <Field label="Every"><div className="flex items-center gap-2"><input type="number" min={2} className="input w-24" value={s.every ?? 2} onChange={(e) => set({ every: Number(e.target.value) })} />days</div></Field>}
            {s.freq === 'monthly' && (
              <Field label="On day">
                <select className="input" value={String(s.monthDay ?? 1)} onChange={(e) => set({ monthDay: e.target.value === 'last' ? 'last' : Number(e.target.value) })}>
                  {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}{i + 1 > 28 ? ' (or last day)' : ''}</option>)}<option value="last">Last day of the month</option>
                </select>
              </Field>
            )}
            <Field label="Starting"><input type="date" className="input" value={s.startDate} onChange={(e) => set({ startDate: e.target.value })} /></Field>
          </div>
          <Field label="Time"><TimePick value={s.time} onChange={(time) => set({ time })} /></Field>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="label mb-0">Ends</span>
            <label className="flex items-center gap-1.5"><input type="radio" checked={s.end.type === 'never'} onChange={() => set({ end: { type: 'never' } })} />Never</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={s.end.type === 'date'} onChange={() => set({ end: { type: 'date', date: s.end.type === 'date' ? s.end.date : today() } })} />On</label>
            <input type="date" className="input w-40 py-1" disabled={s.end.type !== 'date'} value={s.end.type === 'date' ? s.end.date : ''} onChange={(e) => set({ end: { type: 'date', date: e.target.value } })} />
            <label className="flex items-center gap-1.5"><input type="radio" checked={s.end.type === 'count'} onChange={() => set({ end: { type: 'count', count: 10 } })} />After</label>
            <input type="number" min={1} className="input w-20 py-1" disabled={s.end.type !== 'count'} value={s.end.type === 'count' ? s.end.count : ''} onChange={(e) => set({ end: { type: 'count', count: Number(e.target.value) } })} /> runs
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.skipHolidays} onChange={(e) => set({ skipHolidays: e.target.checked })} />Skip school holidays</label>
          <p className="text-xs text-slate-500">Each run is a separate report, with the audience worked out again at run time (new people included, removed ones left out). Tip: write several versions of the message separated by a line with only <code>===</code> — each run uses the next one, so people don't get the same text every day.</p>
        </div>
      )}

      {s.mode === 'dated' && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Date to use">
              <select className="input" value={s.source.type === 'birthday' ? 'birthday' : 'column'} onChange={(e) => set({ source: e.target.value === 'birthday' ? { type: 'birthday' } : { type: 'column', column: columns?.[0] ?? '', yearly: false } })}>
                <option value="birthday">Student birthdays (from the school system)</option>
                <option value="column">A date column in your lists</option>
              </select>
            </Field>
            {s.source.type === 'column' && (
              <Field label="Column" hint={groupIds.length ? 'From the CSV columns of the lists chosen above.' : 'Choose your lists above first.'}>
                <div className="flex items-center gap-3">
                  <input className="input" list="date-columns" value={s.source.column} placeholder="e.g. Due Date" onChange={(e) => set({ source: { ...s.source, column: e.target.value } })} />
                  <datalist id="date-columns">{columns?.map((k) => <option key={k} value={k} />)}</datalist>
                  <label className="flex items-center gap-1.5 whitespace-nowrap text-sm"><input type="checkbox" checked={(s.source as any).yearly} onChange={(e) => set({ source: { ...s.source, yearly: e.target.checked } })} />Every year</label>
                </div>
              </Field>
            )}
          </div>
          <div>
            <span className="label">Steps</span>
            <div className="space-y-2">
              {s.steps.map((st, i) => (
                <div key={i} className="grid gap-2 rounded-lg border border-slate-200 p-2 md:grid-cols-[170px_1fr_auto]">
                  <select className="input py-1.5 text-sm" value={st.offset} onChange={(e) => set({ steps: s.steps.map((x, j) => (j === i ? { ...x, offset: Number(e.target.value) } : x)) })}>
                    {OFFSETS.map((o) => <option key={o} value={o}>{offsetLabel(o)}</option>)}
                  </select>
                  <textarea className="input min-h-16 font-mono text-xs" value={st.body} placeholder="Message for this step — leave empty to use the main message below"
                    onChange={(e) => set({ steps: s.steps.map((x, j) => (j === i ? { ...x, body: e.target.value } : x)) })} />
                  <button className="self-start text-xs text-red-600 hover:underline disabled:opacity-40" disabled={s.steps.length === 1} onClick={() => set({ steps: s.steps.filter((_, j) => j !== i) })}>Remove</button>
                </div>
              ))}
            </div>
            <button className="btn-secondary mt-2" onClick={() => set({ steps: [...s.steps, { offset: OFFSETS.find((o) => !s.steps.some((x) => x.offset === o)) ?? 0, body: '' }] })}>+ Add step</button>
            <p className="mt-1 text-xs text-slate-500">Extra variables: {s.source.type === 'birthday' ? <><code>{'{{age}}'}</code> (age they turn), <code>{'{{birthday}}'}</code></> : <><code>{'{{date}}'}</code>, <code>{'{{days_left}}'}</code></>}.
              {s.source.type === 'birthday' && ' No classes chosen above = the whole school.'}</p>
          </div>
          <Field label="Send time"><TimePick value={s.time} onChange={(time) => set({ time })} /></Field>
        </div>
      )}

      {err ? <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div> : <SchedulePlan plan={plan} />}
      {c.status === 'scheduled' && c.next_run_at && <p className="text-xs text-slate-500">Next run {fmtDate(c.next_run_at)}</p>}
    </div>
  );
}
