import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

const TONES: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  blue: 'bg-sky-50 text-sky-700 ring-sky-200',
  slate: 'bg-slate-100 text-slate-600 ring-slate-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
};
export function Badge({ tone = 'slate', children }: { tone?: keyof typeof TONES | string; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone] ?? TONES.slate}`}>{children}</span>;
}

export const statusTone = (s: string) =>
  ({ WORKING: 'green', SCAN_QR_CODE: 'amber', STARTING: 'blue', FAILED: 'red', STOPPED: 'slate',
     running: 'blue', scheduled: 'violet', paused: 'amber', completed: 'green', cancelled: 'slate', draft: 'slate',
     queued: 'slate', sending: 'blue', sent: 'blue', delivered: 'green', read: 'violet', failed: 'red', skipped: 'amber' } as Record<string, string>)[s] ?? 'slate';

export const statusLabel = (s: string) =>
  ({ WORKING: 'Connected', SCAN_QR_CODE: 'Scan QR', STARTING: 'Starting', FAILED: 'Failed', STOPPED: 'Stopped' } as Record<string, string>)[s] ?? s;

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone === 'red' ? 'text-red-600' : 'text-slate-900'}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

export function Progress({ value, max, className = '' }: { value: number; max: number; className?: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-slate-100 ${className}`}>
      <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`card w-full ${wide ? 'max-w-3xl' : 'max-w-lg'}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-slate-300 transition peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-100 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4" />
      <span className="text-sm">
        <span className="font-medium text-slate-700">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

// ---------- searchable multi-select dropdown ----------
export interface MsOption { value: string; label: string; group?: string; hint?: ReactNode; badge?: ReactNode; indent?: boolean; search?: string }

/**
 * Dropdown with search, grouped options and checkboxes. Selection logic stays with the caller
 * (isChecked / onToggle) so hierarchies like class → sections can be handled there.
 */
export function MultiSelect({ options, isChecked, onToggle, onBulk, chips, onRemoveChip, placeholder = 'Select…', emptyText = 'Nothing to choose from', loading }: {
  options: MsOption[];
  isChecked: (o: MsOption) => boolean;
  onToggle: (o: MsOption) => void;
  onBulk?: (shown: MsOption[], on: boolean) => void;
  chips: { value: string; label: ReactNode }[];
  onRemoveChip: (value: string) => void;
  placeholder?: string; emptyText?: ReactNode; loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);

  const needle = q.trim().toLowerCase();
  const shown = needle ? options.filter((o) => (o.search ?? o.label).toLowerCase().includes(needle)) : options;
  const groups: [string, MsOption[]][] = [];
  for (const o of shown) {
    const g = o.group ?? '';
    const last = groups[groups.length - 1];
    if (last && last[0] === g) last[1].push(o); else groups.push([g, [o]]);
  }
  const MAX_CHIPS = 8;

  return (
    <div className="relative" ref={box}>
      <div role="button" tabIndex={0} onClick={() => setOpen((x) => !x)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen((x) => !x))}
        className={`flex min-h-10 w-full cursor-pointer flex-wrap items-center gap-1.5 rounded-lg border bg-white px-2 py-1.5 text-sm transition ${open ? 'border-brand-600 ring-2 ring-brand-100' : 'border-slate-300 hover:border-slate-400'}`}>
        {chips.length === 0 && <span className="px-1 text-slate-400">{placeholder}</span>}
        {chips.slice(0, MAX_CHIPS).map((c) => (
          <span key={c.value} className="inline-flex max-w-full items-center gap-1 rounded-md bg-brand-50 py-0.5 pl-2 pr-1 text-xs text-brand-800 ring-1 ring-inset ring-brand-100">
            <span className="truncate">{c.label}</span>
            <button type="button" aria-label="Remove" className="rounded px-1 hover:bg-brand-100" onClick={(e) => { e.stopPropagation(); onRemoveChip(c.value); }}>✕</button>
          </span>
        ))}
        {chips.length > MAX_CHIPS && <span className="text-xs text-slate-500">+{chips.length - MAX_CHIPS} more</span>}
        <span className="ml-auto pl-1 text-slate-400" aria-hidden>{open ? '▴' : '▾'}</span>
      </div>
      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center gap-2 border-b border-slate-100 p-2">
            <input className="input py-1.5" autoFocus placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
            {onBulk && shown.length > 0 && <>
              <button type="button" className="btn-ghost whitespace-nowrap px-2 py-1 text-xs" onClick={() => onBulk(shown, true)}>Select {needle ? 'shown' : 'all'} ({shown.length})</button>
              <button type="button" className="btn-ghost whitespace-nowrap px-2 py-1 text-xs" onClick={() => onBulk(shown, false)}>Clear</button>
            </>}
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {loading && <p className="px-3 py-4 text-center text-sm text-slate-500">Loading…</p>}
            {!loading && !shown.length && <p className="px-3 py-4 text-center text-sm text-slate-500">{needle ? 'No matches' : emptyText}</p>}
            {groups.map(([g, opts]) => (
              <div key={g || '_'}>
                {g && <div className="sticky top-0 z-10 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{g} <span className="font-normal">({opts.length})</span></div>}
                {opts.map((o) => (
                  <label key={o.value} className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 ${o.indent ? 'pl-8 text-slate-600' : ''}`}>
                    <input type="checkbox" checked={isChecked(o)} onChange={() => onToggle(o)} />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.badge}
                    {o.hint !== undefined && <span className="shrink-0 text-xs text-slate-400">{o.hint}</span>}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500">{children}</div>;
}

// ---------- toasts ----------
type Toast = { id: number; text: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const id = useRef(0);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const t = { id: ++id.current, text, tone };
    setItems((x) => [...x, t]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex max-w-sm flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`pointer-events-auto rounded-lg px-4 py-3 text-sm shadow-lg ${t.tone === 'error' ? 'bg-red-600 text-white' : 'bg-slate-900 text-white'}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- data hook ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    reload();
    if (!pollMs) return;
    const t = setInterval(() => document.visibilityState === 'visible' && reload(), pollMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
}
