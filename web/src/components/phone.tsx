import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, fmtPhone } from '../api';
import { useToast } from './ui';

// Numbers arrive from the server masked ("•••••• 3210") with an encrypted `<key>_ref`. Revealing one asks the
// server (which logs it), shows it for `rehideSeconds`, then hides it again. Leaving the page hides everything.

const PAGE_NAMES: [RegExp, string][] = [
  [/^\/contacts/, 'Contacts'], [/^\/campaigns\/\d+$/, 'Campaign report'], [/^\/campaigns/, 'Campaigns'],
  [/^\/numbers/, 'Numbers'], [/^\/$/, 'Dashboard'],
];

interface Ctx {
  revealed: Record<string, string>;
  reveal: (refs: string[]) => Promise<void>;
  hide: (refs?: string[]) => void;
  register: (ref: string) => () => void;
  pageRefs: () => string[];
  version: number;
}
const PrivacyCtx = createContext<Ctx | null>(null);

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const loc = useLocation();
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [version, setVersion] = useState(0);
  const rehide = useRef(30);
  const timers = useRef(new Map<string, number>());
  const mounted = useRef(new Map<string, number>());
  const bump = useRef(0);

  useEffect(() => { api.get('/settings').then((s) => { rehide.current = Number(s?.privacy?.rehideSeconds) || 30; }).catch(() => {}); }, []);

  const hide = useCallback((refs?: string[]) => {
    const list = refs ?? [...timers.current.keys()];
    for (const r of list) { clearTimeout(timers.current.get(r)); timers.current.delete(r); }
    setRevealed((cur) => {
      if (!refs) return {};
      const next = { ...cur };
      for (const r of refs) delete next[r];
      return next;
    });
  }, []);

  useEffect(() => () => hide(), [loc.pathname, hide]);

  const reveal = useCallback(async (refs: string[]) => {
    const want = refs.filter(Boolean);
    if (!want.length) return;
    const where = PAGE_NAMES.find(([re]) => re.test(loc.pathname))?.[1] ?? 'the dashboard';
    try {
      const { phones } = await api.post<{ phones: Record<string, string> }>('/reveal', { refs: want, where });
      setRevealed((cur) => ({ ...cur, ...phones }));
      for (const r of Object.keys(phones)) {
        clearTimeout(timers.current.get(r));
        timers.current.set(r, window.setTimeout(() => hide([r]), rehide.current * 1000));
      }
    } catch (e) { toast((e as Error).message, 'error'); }
  }, [loc.pathname, hide, toast]);

  // Phone cells register their ref so "Show all" knows what is on screen. Re-render is coalesced per frame.
  const register = useCallback((ref: string) => {
    const m = mounted.current;
    m.set(ref, (m.get(ref) ?? 0) + 1);
    const changed = () => { cancelAnimationFrame(bump.current); bump.current = requestAnimationFrame(() => setVersion((v) => v + 1)); };
    changed();
    return () => { const n = (m.get(ref) ?? 1) - 1; if (n) m.set(ref, n); else m.delete(ref); changed(); };
  }, []);
  const pageRefs = useCallback(() => [...mounted.current.keys()], []);

  const value = useMemo(() => ({ revealed, reveal, hide, register, pageRefs, version }), [revealed, reveal, hide, register, pageRefs, version]);
  return <PrivacyCtx.Provider value={value}>{children}</PrivacyCtx.Provider>;
}

const usePrivacy = () => useContext(PrivacyCtx);

const EyeIcon = ({ off }: { off?: boolean }) => (
  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6S1.5 10 1.5 10Z" /><circle cx="10" cy="10" r="2.5" />
    {off && <path d="M3 17 17 3" />}
  </svg>
);

/** A phone number: masked with a 👁 button, or the full number with copy + hide. */
export function Phone({ value, pref, missing = '—', className = '' }: { value?: string | null; pref?: string | null; missing?: ReactNode; className?: string }) {
  const p = usePrivacy();
  const toast = useToast();
  useEffect(() => (pref && p ? p.register(pref) : undefined), [pref, p?.register]);
  if (!value) return <span className={className}>{missing}</span>;
  const full = pref ? p?.revealed[pref] : undefined;
  if (!pref || !p) return <span className={`whitespace-nowrap ${className}`}>{fmtPhone(value)}</span>;
  const btn = 'inline-grid h-5 w-5 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700';
  if (!full) {
    return (
      <span className={`inline-flex items-center gap-1 whitespace-nowrap ${className}`}>
        <span className="font-mono tracking-tight">{value}</span>
        <button type="button" className={btn} title="Show number" aria-label="Show number" onClick={() => p.reveal([pref])}><EyeIcon /></button>
      </span>
    );
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText('+' + full); toast('Number copied'); } catch { toast('Copy failed — select the number instead', 'error'); }
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap ${className}`}>
      <span className="font-medium text-slate-800">{fmtPhone(full)}</span>
      <button type="button" className={btn} title="Copy" aria-label="Copy number" onClick={copy}>
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /></svg>
      </button>
      <button type="button" className={btn} title="Hide number" aria-label="Hide number" onClick={() => p.hide([pref])}><EyeIcon off /></button>
    </span>
  );
}

/** "Show all numbers" for whatever phone cells are currently on the page (one request, one log entry). */
export function RevealAll() {
  const p = usePrivacy();
  if (!p) return null;
  const refs = p.pageRefs();
  if (!refs.length) return null;
  const allShown = refs.every((r) => p.revealed[r]);
  return allShown
    ? <button type="button" className="btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap" onClick={() => p.hide(refs)}><EyeIcon off /> Hide numbers</button>
    : <button type="button" className="btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap" onClick={() => p.reveal(refs.filter((r) => !p.revealed[r]))}><EyeIcon /> Show all numbers</button>;
}
