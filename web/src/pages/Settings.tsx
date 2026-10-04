import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Card, ErrorNote, Field, PageHeader, Toggle, useLoad, useToast } from '../components/ui';

export default function Settings() {
  const toast = useToast();
  const { data, error } = useLoad(() => api.get('/settings'), []);
  const { data: sys } = useLoad(() => api.get('/system'), []);
  const [s, setS] = useState<any>(null);
  useEffect(() => { if (data) setS(structuredClone(data)); }, [data]);
  if (error) return <ErrorNote error={error} />;
  if (!s) return <p className="text-sm text-slate-500">Loading…</p>;

  const set = (path: string, value: unknown) => setS((o: any) => {
    const n = structuredClone(o); const keys = path.split('.'); let t = n;
    for (const k of keys.slice(0, -1)) t = t[k];
    t[keys[keys.length - 1]] = value; return n;
  });
  const save = async () => { try { setS(await api.put('/settings', s)); toast('Settings saved'); } catch (e) { toast((e as Error).message, 'error'); } };
  const testAlert = async () => { try { await save(); await api.post('/settings/test-alert'); toast('Test alert sent — check WhatsApp / email'); } catch (e) { toast((e as Error).message, 'error'); } };
  const sec = (ms: number) => ms / 1000;

  return (
    <>
      <PageHeader title="Settings" actions={<button className="btn-primary" onClick={save}>Save settings</button>} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Quiet hours (IST)">
          <Toggle checked={s.quietHours.enabled} onChange={(x) => set('quietHours.enabled', x)} label="Don't send at night" hint="Campaigns pause and resume automatically. Each campaign can opt out (urgent notices)." />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="From"><input className="input" type="time" value={s.quietHours.start} onChange={(e) => set('quietHours.start', e.target.value)} /></Field>
            <Field label="Until"><input className="input" type="time" value={s.quietHours.end} onChange={(e) => set('quietHours.end', e.target.value)} /></Field>
          </div>
        </Card>

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

        <Card title="Speed presets">
          <p className="mb-3 text-sm text-slate-500">Shown as buttons when creating a campaign. Each campaign can still use custom values.</p>
          <table className="table">
            <thead><tr><th /><th>Delay (s)</th><th>Pause every</th><th>Pause (s)</th></tr></thead>
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

        <Card title="Warm-up safety">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Default max per number / day"><input className="input" type="number" value={s.defaultMaxCap} onChange={(e) => set('defaultMaxCap', Number(e.target.value))} /></Field>
            <div />
            <Field label="Auto-pause at failure rate (%)"><input className="input" type="number" value={s.autoPause.failureRatePct} onChange={(e) => set('autoPause.failureRatePct', Number(e.target.value))} /></Field>
            <Field label="…after at least (messages)"><input className="input" type="number" value={s.autoPause.minSamples} onChange={(e) => set('autoPause.minSamples', Number(e.target.value))} /></Field>
          </div>
          <p className="mt-3 text-xs text-slate-500">Per-number warm-up (age, activity, business profile) is set on the <b>Numbers</b> page.</p>
        </Card>

        <Card title="Frappe sync">
          <div className="space-y-3">
            <Field label="Academic year" hint="Empty = latest academic year in Frappe"><input className="input" value={s.frappe.academicYear} onChange={(e) => set('frappe.academicYear', e.target.value)} placeholder="2026-2027" /></Field>
            <Field label="Exclude programs" hint="Comma separated"><input className="input" value={s.frappe.excludePrograms.join(', ')} onChange={(e) => set('frappe.excludePrograms', e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean))} /></Field>
            <Field label="Sync every (hours)"><input className="input" type="number" min={1} value={s.frappe.syncEveryHours} onChange={(e) => set('frappe.syncEveryHours', Number(e.target.value))} /></Field>
          </div>
        </Card>

        {sys && (
          <Card title="System">
            <ul className="space-y-1 text-sm">
              <li>WhatsApp engine (WAHA): {sys.waha === 'ok' ? <Badge tone="green">reachable</Badge> : <Badge tone="red">{sys.waha}</Badge>}</li>
              <li>Frappe: {sys.frappe ? <Badge tone="green">configured</Badge> : <Badge tone="amber">not configured</Badge>}</li>
              <li>Email (SMTP): {sys.smtp ? <Badge tone="green">configured</Badge> : <Badge tone="amber">not configured</Badge>}</li>
              <li>Sending: {sys.sendingEnabled ? <Badge tone="green">live</Badge> : <Badge tone="amber">dry-run</Badge>}</li>
              <li className="text-xs text-slate-500">{sys.publicUrl} · {sys.timezone}</li>
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
