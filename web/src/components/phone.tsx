import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, fmtPhone } from '../api';
import { useToast } from './ui';

// Display-only privacy: numbers are hidden on screen ("•••••• 3210") and shown with the eye button.
// Nothing is fetched to reveal; a shown number hides again after `rehideSeconds` or when the page changes.

interface Ctx {
  enabled: boolean;
  shown: Set<string>;
  show: (phones: string[]) => void;
  hide: (phones?: string[]) => void;
  register: (phone: string) => () => void;
  pagePhones: () => string[];
  version: number;
}
const PrivacyCtx = createContext<Ctx | null>(null);

/** Hidden form shaped like the shown one: +91 98000 01234 → +91 ••••• •1234 */
export const maskPhone = (p: string) => {
  const d = p.replace(/\D/g, '');
  return d.startsWith('91') && d.length === 12 ? `+91 ••••• •${d.slice(-4)}` : `+${'•'.repeat(Math.max(d.length - 4, 2))}${d.slice(-4)}`;
};

export function PrivacyProvider({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const [enabled, setEnabled] = useState(true);
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const [version, setVersion] = useState(0);
  const rehide = useRef(30);
  const timers = useRef(new Map<string, number>());
  const mounted = useRef(new Map<string, number>());
  const frame = useRef(0);

  useEffect(() => {
    api.get('/settings').then((s) => {
      setEnabled(s?.privacy?.maskPhones !== false);
      rehide.current = Number(s?.privacy?.rehideSeconds) || 30;
    }).catch(() => {});
  }, []);

  const hide = useCallback((phones?: string[]) => {
    const list = phones ?? [...timers.current.keys()];
    for (const p of list) { clearTimeout(timers.current.get(p)); timers.current.delete(p); }
    setShown((cur) => {
      if (!phones) return new Set();
      const next = new Set(cur);
      for (const p of phones) next.delete(p);
      return next;
    });
  }, []);

  useEffect(() => () => hide(), [loc.pathname, hide]);

  const show = useCallback((phones: string[]) => {
    setShown((cur) => new Set([...cur, ...phones]));
    for (const p of phones) {
      clearTimeout(timers.current.get(p));
      timers.current.set(p, window.setTimeout(() => hide([p]), rehide.current * 1000));
    }
  }, [hide]);

  // Phone cells register themselves so "Show all" knows what is on screen; re-render is coalesced per frame
  const register = useCallback((phone: string) => {
    const m = mounted.current;
    m.set(phone, (m.get(phone) ?? 0) + 1);
    const changed = () => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(() => setVersion((v) => v + 1)); };
    changed();
    return () => { const n = (m.get(phone) ?? 1) - 1; if (n) m.set(phone, n); else m.delete(phone); changed(); };
  }, []);
  const pagePhones = useCallback(() => [...mounted.current.keys()], []);

  const value = useMemo(() => ({ enabled, shown, show, hide, register, pagePhones, version }), [enabled, shown, show, hide, register, pagePhones, version]);
  return <PrivacyCtx.Provider value={value}>{children}</PrivacyCtx.Provider>;
}

const usePrivacy = () => useContext(PrivacyCtx);

const EyeIcon = ({ off }: { off?: boolean }) => (
  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6S1.5 10 1.5 10Z" /><circle cx="10" cy="10" r="2.5" />
    {off && <path d="M3 17 17 3" />}
  </svg>
);

/** A phone number: hidden with a 👁 button, or shown with copy + hide. */
export function Phone({ value, missing = '—', className = '' }: { value?: string | null; missing?: ReactNode; className?: string }) {
  const p = usePrivacy();
  const toast = useToast();
  const active = !!(value && p?.enabled);
  useEffect(() => (active && value ? p!.register(value) : undefined), [active, value, p?.register]);
  if (!value) return <span className={className}>{missing}</span>;
  if (!active) return <span className={`whitespace-nowrap ${className}`}>{fmtPhone(value)}</span>;
  const shown = p!.shown.has(value);
  const full = fmtPhone(value);
  const btn = 'inline-grid h-5 w-5 shrink-0 place-items-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700';
  const copy = async () => {
    try { await navigator.clipboard.writeText('+' + value); toast('Number copied'); } catch { toast('Copy failed — select the number instead', 'error'); }
  };
  // Same font, a box as wide as the full number and fixed button slots, so nothing moves when toggling
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap ${className}`}>
      <span className="inline-block tabular-nums" style={{ minWidth: `${full.length}ch` }}>{shown ? full : maskPhone(value)}</span>
      <button type="button" className={btn} title={shown ? 'Hide number' : 'Show number'} aria-label={shown ? 'Hide number' : 'Show number'}
        onClick={() => (shown ? p!.hide([value]) : p!.show([value]))}><EyeIcon off={shown} /></button>
      <button type="button" className={`${btn} ${shown ? '' : 'invisible'}`} title="Copy" aria-label="Copy number" tabIndex={shown ? 0 : -1} onClick={copy}>
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><rect x="7" y="7" width="10" height="10" rx="2" /><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" /></svg>
      </button>
    </span>
  );
}

/** "Show all numbers" / "Hide numbers" for the phone cells currently on the page. */
export function RevealAll() {
  const p = usePrivacy();
  if (!p?.enabled) return null;
  const phones = p.pagePhones();
  if (!phones.length) return null;
  const cls = 'btn-secondary inline-flex items-center gap-1.5 whitespace-nowrap';
  return phones.every((x) => p.shown.has(x))
    ? <button type="button" className={cls} onClick={() => p.hide(phones)}><EyeIcon off /> Hide numbers</button>
    : <button type="button" className={cls} onClick={() => p.show(phones)}><EyeIcon /> Show all numbers</button>;
}
