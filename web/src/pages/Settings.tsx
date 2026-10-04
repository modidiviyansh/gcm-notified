import { ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Badge, Card, ErrorNote, Field, PageHeader, Toggle, useLoad, useToast } from '../components/ui';
import { MessageTypes } from './settings/MessageTypes';
import { ApiTab } from './settings/ApiTab';
import { CallsTab, WaCheckTab } from './settings/NumbersTabs';

const TABS = [
  { key: 'general', label: 'General', hint: 'Quiet hours, opt-out, privacy' },
  { key: 'types', label: 'Message types', hint: 'Who gets what, how fast' },
  { key: 'sending', label: 'Sending & safety', hint: 'Speed, limits, auto-pause' },
  { key: 'scheduling', label: 'Scheduling', hint: 'Per-person cap, holidays' },
  { key: 'calls', label: 'Numbers & calls', hint: 'Incoming calls, automatic use' },
  { key: 'wacheck', label: 'WhatsApp check', hint: 'Who is on WhatsApp' },
  { key: 'alerts', label: 'Alerts', hint: 'When something goes wrong' },
  { key: 'api', label: 'API', hint: 'Send from other systems' },
  { key: 'school', label: 'School system', hint: 'Frappe sync, status' },
] as const;
type Tab = (typeof TABS)[number]['key'];

export default function Settings() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'general') as Tab;
  const { data, error } = useLoad(() => api.get('/settings'), []);
  const { data: sys } = useLoad(() => api.get('/system'), []);
  const [s, setS] = useState<any>(null);
  const [saved, setSaved] = useState<string>('');
  useEffect(() => { if (data) { setS(structuredClone(data)); setSaved(JSON.stringify(data)); } }, [data]);
  const dirty = !!s && JSON.stringify(s) !== saved;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (error) return <ErrorNote error={error} />;
  if (!s) return <p className="text-sm text-slate-500">Loading…</p>;

  const set = (path: string, value: unknown) => setS((o: any) => {
    const n = structuredClone(o); const keys = path.split('.'); let t = n;
    for (const k of keys.slice(0, -1)) t = t[k];
    t[keys[keys.length - 1]] = value; return n;
  });
  const save = async () => {
    try { const r = await api.put('/settings', s); setS(r); setSaved(JSON.stringify(r)); toast('Settings saved'); return true; } catch (e) { toast((e as Error).message, 'error'); return false; }
  };
  const testAlert = async () => { if (dirty && !(await save())) return; try { await api.post('/settings/test-alert'); toast('Test alert sent — check WhatsApp / email'); } catch (e) { toast((e as Error).message, 'error'); } };
  const sec = (ms: number) => ms / 1000;
  const go = (k: Tab) => setParams(k === 'general' ? {} : { tab: k }, { replace: true });

  const body: Record<Tab, ReactNode> = {
    general: (
      <Stack>
        <Card title="Quiet hours (IST)">
          <Toggle checked={s.quietHours.enabled} onChange={(x) => set('quietHours.enabled', x)} label="Don't send at night" hint="Campaigns pause and resume automatically. Message types can opt out (emergencies)." />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="From"><input className="input" type="time" value={s.quietHours.start} onChange={(e) => set('quietHours.start', e.target.value)} /></Field>
            <Field label="Until"><input className="input" type="time" value={s.quietHours.end} onChange={(e) => set('quietHours.end', e.target.value)} /></Field>
          </div>
        </Card>
        <Card title="Recipients & opt-out">
          <div className="space-y-3">
            <Field label='"Primary parent" means'>
              <select className="input" value={s.primaryParent} onChange={(e) => set('primaryParent', e.target.value)}><option value="father">Father (fallback: mother)</option><option value="mother">Mother (fallback: father)</option></select>
            </Field>
            <Field label="Opt-out keywords" hint="Comma separated. A reply of exactly one of these words opts the sender out.">
              <input className="input" value={s.optOutKeywords.join(', ')} onChange={(e) => set('optOutKeywords', e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean))} />
            </Field>
            <Field label="Reply sent after opting out (empty = no reply)"><textarea className="input h-20" value={s.optOutReply} onChange={(e) => set('optOutReply', e.target.value)} /></Field>
          </div>
        </Card>
        <Card title="Privacy">
          <div className="space-y-3">
            <Toggle checked={s.privacy.maskPhones} onChange={(v) => set('privacy.maskPhones', v)} label="Hide phone numbers" hint="Numbers show only their last 4 digits on screen. Click the eye to see one." />
            <Field label="Hide again after (seconds)">
              <input className="input w-32" type="number" min={5} max={600} value={s.privacy.rehideSeconds} onChange={(e) => set('privacy.rehideSeconds', Math.min(600, Math.max(5, Number(e.target.value) || 30)))} />
            </Field>
          </div>
        </Card>
      </Stack>
    ),
    types: <MessageTypes types={s.messageTypes} onChange={(t) => set('messageTypes', t)} />,
    sending: (
      <Stack>
        <Card title="Speed presets">
          <p className="mb-3 text-sm text-slate-500">Each message type uses one of these. A campaign can still be given custom values.</p>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th /><th>Delay (s)</th><th>Pause every (messages)</th><th>Pause (s)</th></tr></thead>
              <tbody>{(['urgent', 'normal', 'safe'] as const).map((k) => {
                const p = s.speedPresets[k];
                const n = (f: string, v: string, mult = 1000) => set(`speedPresets.${k}.${f}`, Math.round(Number(v) * mult));
                return (
                  <tr key={k}>
                    <td className="font-medium capitalize">{k}</td>
                    <td><div className="flex gap-1"><input className="input w-16" type="number" step={0.5} value={sec(p.delayMinMs)} onChange={(e) => n('delayMinMs', e.target.value)} /><input className="input w-16" type="number" step={0.5} value={sec(p.delayMaxMs)} onChange={(e) => n('delayMaxMs', e.target.value)} /></div></td>
                    <td><div className="flex gap-1"><input className="input w-16" type="number" value={p.burstMin} onChange={(e) => n('burstMin', e.target.value, 1)} /><input className="input w-16" type="number" value={p.burstMax} onChange={(e) => n('burstMax', e.target.value, 1)} /></div></td>
                    <td><div className="flex gap-1"><input className="input w-16" type="number" value={sec(p.burstPauseMinMs)} onChange={(e) => n('burstPauseMinMs', e.target.value)} /><input className="input w-16" type="number" value={sec(p.burstPauseMaxMs)} onChange={(e) => n('burstPauseMaxMs', e.target.value)} /></div></td>
                  </tr>);
              })}</tbody>
            </table>
          </div>
        </Card>
        <Card title="Warm-up safety">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Default max per number / day"><input className="input" type="number" value={s.defaultMaxCap} onChange={(e) => set('defaultMaxCap', Number(e.target.value))} /></Field>
            <div />
            <Field label="Auto-pause at failure rate (%)"><input className="input" type="number" value={s.autoPause.failureRatePct} onChange={(e) => set('autoPause.failureRatePct', Number(e.target.value))} /></Field>
            <Field label="…after at least (messages)"><input className="input" type="number" value={s.autoPause.minSamples} onChange={(e) => set('autoPause.minSamples', Number(e.target.value))} /></Field>
          </div>
          <p className="mt-3 text-xs text-slate-500">Per-number warm-up (age, activity, business profile) is set on the <b>Numbers</b> page.</p>
        </Card>
      </Stack>
    ),
    scheduling: (
      <Card title="Scheduling">
        <div className="space-y-3">
          <Field label="Messages per person per day (all campaigns)" hint="Repeating and date-based schedules can't flood the same parent. Extra messages wait until the next morning. Emergency types and API messages are exempt. 0 = no limit.">
            <input className="input w-32" type="number" min={0} max={50} value={s.frequencyCap.perDay} onChange={(e) => set('frequencyCap.perDay', Number(e.target.value))} />
          </Field>
          <Field label="Extra holidays" hint={`One date per line (YYYY-MM-DD). ${sys?.holidays ? `${sys.holidays} holidays come from the school system.` : 'School holidays from Frappe appear here once it can read the Holiday List.'}`}>
            <textarea className="input h-28 font-mono text-xs" defaultValue={s.holidays.join('\n')} placeholder={'2026-10-20\n2026-11-08'}
              onBlur={(e) => set('holidays', e.target.value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean))} />
          </Field>
        </div>
      </Card>
    ),
    calls: <CallsTab />,
    wacheck: <WaCheckTab value={s.waCheck} onChange={(v) => set('waCheck', v)} />,
    alerts: (
      <Card title="Alerts">
        <p className="mb-3 text-sm text-slate-500">When a number disconnects (for more than 2 minutes), is auto-paused, or WAHA is unreachable.</p>
        <div className="space-y-3">
          <Field label="Admin WhatsApp number" hint="Sent from another connected number, so it still arrives when one number is down."><input className="input" value={s.alerts.adminPhone} onChange={(e) => set('alerts.adminPhone', e.target.value)} placeholder="98765 43210" /></Field>
          <Toggle checked={s.alerts.whatsapp} onChange={(x) => set('alerts.whatsapp', x)} label="WhatsApp alerts" />
          <Field label="Alert email"><input className="input" type="email" value={s.alerts.email} onChange={(e) => set('alerts.email', e.target.value)} /></Field>
          <Toggle checked={s.alerts.emailEnabled} onChange={(x) => set('alerts.emailEnabled', x)} label="Email alerts" hint={sys && !sys.smtp ? 'SMTP is not configured yet (set SMTP_* in Coolify)' : undefined} />
          <button className="btn-secondary" onClick={testAlert}>Send test alert</button>
        </div>
      </Card>
    ),
    api: <ApiTab perMinute={s.api.perMinute} onPerMinute={(n) => set('api.perMinute', n)} />,
    school: (
      <Stack>
        <Card title="Frappe sync">
          <div className="space-y-3">
            <Field label="Academic year" hint="Empty = the year most students are enrolled in"><input className="input" value={s.frappe.academicYear} onChange={(e) => set('frappe.academicYear', e.target.value)} placeholder="2026-2027" /></Field>
            <Field label="Exclude programs" hint="Comma separated"><input className="input" value={s.frappe.excludePrograms.join(', ')} onChange={(e) => set('frappe.excludePrograms', e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean))} /></Field>
            <Field label="Sync every (hours)"><input className="input w-32" type="number" min={1} value={s.frappe.syncEveryHours} onChange={(e) => set('frappe.syncEveryHours', Number(e.target.value))} /></Field>
          </div>
        </Card>
        {sys && (
          <Card title="System">
            <ul className="space-y-1.5 text-sm">
              <li>WhatsApp engine (WAHA): {sys.waha === 'ok' ? <Badge tone="green">reachable</Badge> : <Badge tone="red">{sys.waha}</Badge>}</li>
              <li>Frappe: {sys.frappe ? <Badge tone="green">configured</Badge> : <Badge tone="amber">not configured</Badge>}</li>
              <li>Email (SMTP): {sys.smtp ? <Badge tone="green">configured</Badge> : <Badge tone="amber">not configured</Badge>}</li>
              <li>Sending: {sys.sendingEnabled ? <Badge tone="green">live</Badge> : <Badge tone="amber">dry-run</Badge>}</li>
              <li className="text-xs text-slate-500">{sys.publicUrl} · {sys.timezone}</li>
            </ul>
          </Card>
        )}
      </Stack>
    ),
  };

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-5 md:grid-cols-[13rem_1fr]">
        <nav className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0" aria-label="Settings sections">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => go(t.key)}
              className={`shrink-0 rounded-lg px-3 py-2 text-left text-sm md:w-full ${tab === t.key ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-600 hover:bg-slate-50'}`}>
              {t.label}<span className="hidden text-[11px] font-normal text-slate-500 md:block">{t.hint}</span>
            </button>
          ))}
        </nav>
        <div className="min-w-0 pb-20">{body[tab]}</div>
      </div>
      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-lg backdrop-blur md:left-60">
          <div className="mx-auto flex max-w-6xl items-center justify-end gap-3">
            <span className="mr-auto text-sm text-slate-600">You have unsaved changes</span>
            <button className="btn-secondary" onClick={() => setS(JSON.parse(saved))}>Discard</button>
            <button className="btn-primary" onClick={save}>Save settings</button>
          </div>
        </div>
      )}
    </>
  );
}

const Stack = ({ children }: { children: ReactNode }) => <div className="space-y-5">{children}</div>;
