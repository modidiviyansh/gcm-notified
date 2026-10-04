import { useState } from 'react';
import { api } from '../api';
import { useLoad } from './ui';

// Which of a person's numbers a message goes to. Same shape as the server's NumberRule.
export interface NumberRule { use: 'primary' | 'all' | 'labels'; labels?: string[]; mode?: 'first' | 'all' }
export interface MessageType {
  key: string; name: string; icon: string; rule: NumberRule;
  school: 'primary' | 'father' | 'mother' | 'both' | 'student' | 'all';
  speed: 'urgent' | 'normal' | 'safe'; quietHours: boolean; overrideOptOut: boolean;
}

export const SCHOOL_LABEL: Record<MessageType['school'], string> = {
  primary: 'Primary parent', father: 'Father', mother: 'Mother', both: 'Both parents', student: "Student's number", all: 'Both parents + student',
};

export function describeRule(r?: NumberRule | null): string {
  if (!r || r.use === 'primary') return 'Primary number';
  if (r.use === 'all') return 'All numbers';
  const l = r.labels ?? [];
  return r.mode === 'all' ? l.join(' + ') : `${l.join(' → ')}${l.length > 1 ? ' (first available)' : ''}`;
}

/** Labels in use (most used first) plus common ones, for rule pickers and the person editor. */
export function useLabels(groupId?: number) {
  const { data } = useLoad(() => api.get<{ used: string[]; common: string[] }>(`/labels${groupId ? `?groupId=${groupId}` : ''}`), [groupId]);
  const all = [...new Set([...(data?.used ?? []), ...(data?.common ?? [])])];
  return { used: data?.used ?? [], all };
}

export function useMessageTypes() {
  const { data } = useLoad(() => api.get('/settings'), []);
  return (data?.messageTypes ?? null) as MessageType[] | null;
}

/**
 * Picks a number rule. With `defaultLabel` the first option means "no rule here, use the default" (value null).
 */
export function RuleEditor({ value, onChange, labels, defaultLabel, compact }: {
  value: NumberRule | null; onChange: (r: NumberRule | null) => void; labels: string[]; defaultLabel?: string; compact?: boolean;
}) {
  const [custom, setCustom] = useState('');
  const kind = value ? value.use : 'default';
  const chosen = value?.use === 'labels' ? value.labels ?? [] : [];
  const setKind = (k: string) => {
    if (k === 'default') return onChange(null);
    if (k === 'labels') return onChange({ use: 'labels', labels: chosen.length ? chosen : labels.slice(0, 1), mode: value?.mode ?? 'first' });
    onChange({ use: k as 'primary' | 'all' });
  };
  const setLabels = (l: string[]) => onChange(l.length ? { use: 'labels', labels: l, mode: value?.mode ?? 'first' } : defaultLabel ? null : { use: 'primary' });
  const addLabel = (l: string) => { const t = l.trim(); if (t && !chosen.some((x) => x.toLowerCase() === t.toLowerCase())) setLabels([...chosen, t]); };
  const move = (i: number, d: -1 | 1) => { const n = [...chosen]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; setLabels(n); };
  const rest = labels.filter((l) => !chosen.some((x) => x.toLowerCase() === l.toLowerCase()));

  return (
    <div className="space-y-2">
      <select className={`input ${compact ? 'py-1.5 text-sm' : ''}`} value={kind} onChange={(e) => setKind(e.target.value)}>
        {defaultLabel && <option value="default">{defaultLabel}</option>}
        <option value="primary">Primary number</option>
        <option value="all">All numbers</option>
        <option value="labels">Choose by label…</option>
      </select>
      {value?.use === 'labels' && (
        <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {chosen.map((l, i) => (
              <span key={l} className="inline-flex items-center gap-1 rounded-full bg-white px-2 py-0.5 text-xs ring-1 ring-slate-200">
                {value.mode !== 'all' && <span className="text-slate-400">{i + 1}.</span>}{l}
                {value.mode !== 'all' && i > 0 && <button type="button" className="text-slate-400 hover:text-slate-700" title="Move earlier" onClick={() => move(i, -1)}>‹</button>}
                {value.mode !== 'all' && i < chosen.length - 1 && <button type="button" className="text-slate-400 hover:text-slate-700" title="Move later" onClick={() => move(i, 1)}>›</button>}
                <button type="button" className="text-slate-400 hover:text-red-600" aria-label={`Remove ${l}`} onClick={() => setLabels(chosen.filter((x) => x !== l))}>×</button>
              </span>
            ))}
            {rest.length > 0 && (
              <select className="rounded-full border border-dashed border-slate-300 bg-transparent px-2 py-0.5 text-xs text-slate-600" value="" onChange={(e) => addLabel(e.target.value)}>
                <option value="">+ label</option>
                {rest.map((l) => <option key={l} value={l}>{l}</option>)}
              </select>
            )}
            <input className="w-24 rounded-full border border-dashed border-slate-300 bg-transparent px-2 py-0.5 text-xs" placeholder="other…" value={custom}
              onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLabel(custom); setCustom(''); } }} onBlur={() => { addLabel(custom); setCustom(''); }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
            <label className="flex items-center gap-1.5"><input type="radio" checked={value.mode !== 'all'} onChange={() => onChange({ ...value, mode: 'first' })} />First one they have, in this order</label>
            <label className="flex items-center gap-1.5"><input type="radio" checked={value.mode === 'all'} onChange={() => onChange({ ...value, mode: 'all' })} />Every one of these</label>
          </div>
          <p className="mt-1 text-[11px] text-slate-400">Someone with none of these labels gets it on their primary number.</p>
        </div>
      )}
    </div>
  );
}
