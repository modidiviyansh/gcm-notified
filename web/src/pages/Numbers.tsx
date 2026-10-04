import { useEffect, useState } from 'react';
import { api, fmtDate, fmtPhone } from '../api';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHeader, Progress, statusLabel, statusTone, Toggle, useLoad, useToast } from '../components/ui';

interface Num {
  id: number; label: string; session: string; phone: string | null; push_name: string | null; status: string; status_at: string;
  paused: boolean; pause_reason: string | null; age_months: number; avg_chats_day: number; is_business: boolean; saved_by_contacts: boolean; past_ban: boolean;
  daily_cap: number; max_cap: number; cap_override: number | null; ramp_enabled: boolean; sent_today: number; failed_today: number;
  score: number; level: string; ramp_pct: number; effective_cap: number; remaining_today: number;
}

const LEVEL_TONE: Record<string, string> = { Cold: 'blue', Warm: 'amber', Trusted: 'green', Established: 'violet' };

export default function Numbers() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => api.get<Num[]>('/numbers'), [], 8000);
  const [editing, setEditing] = useState<Partial<Num> | null>(null);
  const [qrFor, setQrFor] = useState<Num | null>(null);
  const [groupsFor, setGroupsFor] = useState<Num | null>(null);

  const act = async (n: Num, path: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    try { await api.post(`/numbers/${n.id}/${path}`); toast('Done'); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const remove = async (n: Num) => {
    if (!confirm(`Remove "${n.label}"? This logs the number out of WhatsApp on this system. Queued messages move to other numbers.`)) return;
    try { await api.del(`/numbers/${n.id}`); toast('Number removed'); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <PageHeader title="Numbers" subtitle="WhatsApp numbers connected through WAHA, with warm-up limits"
        actions={<button className="btn-primary" onClick={() => setEditing({ label: '', age_months: 6, avg_chats_day: 20, is_business: true, saved_by_contacts: true, past_ban: false, max_cap: 1000 })}>Add number</button>} />
      <ErrorNote error={error} />
      {data && data.length === 0 && <Empty>No numbers yet. Click <b>Add number</b>, then scan the QR code with WhatsApp on the phone.</Empty>}
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.map((n) => (
          <Card key={n.id} title={<span className="flex items-center gap-2">{n.label}<Badge tone={LEVEL_TONE[n.level]}>{n.level} · {n.score}</Badge></span>}
            actions={n.paused ? <Badge tone="amber">Paused</Badge> : <Badge tone={statusTone(n.status)}>{statusLabel(n.status)}</Badge>}>
            <div className="mb-3 grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-slate-500">Phone</span><div className="font-medium">{fmtPhone(n.phone)}</div></div>
              <div><span className="text-slate-500">WhatsApp name</span><div className="font-medium">{n.push_name ?? '—'}</div></div>
            </div>
            {n.paused && n.pause_reason && <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{n.pause_reason}</div>}
            <div className="mb-1 flex justify-between text-xs text-slate-500">
              <span>Today: {n.sent_today} / {n.effective_cap}{n.cap_override !== null ? ' (manual cap)' : ''}{n.failed_today ? ` · ${n.failed_today} failed` : ''}</span>
              <span>max {n.max_cap}/day{n.ramp_enabled && n.cap_override === null ? ` · +${n.ramp_pct}%/day` : ''}</span>
            </div>
            <Progress value={n.sent_today} max={n.effective_cap} className="mb-4" />
            <div className="flex flex-wrap gap-2">
              {n.status === 'SCAN_QR_CODE' && <button className="btn-primary" onClick={() => setQrFor(n)}>Scan QR</button>}
              {['STOPPED', 'FAILED'].includes(n.status) && <button className="btn-primary" onClick={() => act(n, 'start')}>Start</button>}
              {n.status === 'WORKING' && <button className="btn-secondary" onClick={() => setGroupsFor(n)}>WhatsApp groups</button>}
              {n.paused ? <button className="btn-secondary" onClick={() => act(n, 'resume')}>Resume sending</button>
                : <button className="btn-secondary" onClick={() => act(n, 'pause')}>Pause sending</button>}
              <button className="btn-secondary" onClick={() => setEditing(n)}>Warm-up & limits</button>
              <details className="relative">
                <summary className="btn-ghost cursor-pointer list-none">More ▾</summary>
                <div className="absolute right-0 z-10 mt-1 w-44 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">
                  <button className="btn-ghost w-full justify-start" onClick={() => act(n, 'restart')}>Restart session</button>
                  <button className="btn-ghost w-full justify-start" onClick={() => act(n, 'stop')}>Stop session</button>
                  <button className="btn-ghost w-full justify-start text-amber-700" onClick={() => act(n, 'logout', 'Log this number out? You will need to scan the QR again.')}>Log out</button>
                  <button className="btn-ghost w-full justify-start text-red-600" onClick={() => remove(n)}>Remove</button>
                </div>
              </details>
            </div>
            <div className="mt-3 text-[11px] text-slate-400">Session <code>{n.session}</code> · status since {fmtDate(n.status_at)}</div>
          </Card>
        ))}
      </div>

      {editing && <NumberForm value={editing} onClose={() => setEditing(null)} onSaved={(n) => { setEditing(null); reload(); if (!editing.id) setQrFor(n); }} />}
      {qrFor && <QrModal n={qrFor} onClose={() => { setQrFor(null); reload(); }} />}
      {groupsFor && <GroupsModal n={groupsFor} onClose={() => setGroupsFor(null)} />}
    </>
  );
}

function NumberForm({ value, onClose, onSaved }: { value: Partial<Num>; onClose: () => void; onSaved: (n: Num) => void }) {
  const toast = useToast();
  const [v, setV] = useState<Partial<Num>>(value);
  const [levels, setLevels] = useState<{ level: string; minScore: number; startCap: number; rampPct: number }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.get('/numbers/levels').then(setLevels); }, []);
  const set = (k: keyof Num, x: unknown) => setV((o) => ({ ...o, [k]: x }));

  // Live score preview (same formula as the server)
  const age = (v.age_months ?? 0) >= 12 ? 30 : (v.age_months ?? 0) >= 6 ? 20 : (v.age_months ?? 0) >= 1 ? 10 : 0;
  const chats = (v.avg_chats_day ?? 0) >= 50 ? 30 : (v.avg_chats_day ?? 0) >= 20 ? 20 : (v.avg_chats_day ?? 0) >= 5 ? 10 : 0;
  const score = Math.max(0, Math.min(100, age + chats + (v.is_business ? 15 : 0) + (v.saved_by_contacts ? 15 : 0) - (v.past_ban ? 40 : 0)));
  const lvl = [...levels].reverse().find((l) => score >= l.minScore);

  const save = async () => {
    setBusy(true);
    try {
      const body = { ...v, cap_override: v.cap_override === undefined || (v.cap_override as any) === '' ? null : v.cap_override };
      const n = v.id ? await api.put<Num>(`/numbers/${v.id}`, body) : await api.post<Num>('/numbers', body);
      toast(v.id ? 'Saved' : 'Number added — scan the QR code');
      onSaved(n);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal open title={v.id ? `Warm-up & limits — ${v.label}` : 'Add WhatsApp number'} onClose={onClose} wide>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <Field label="Label"><input className="input" value={v.label ?? ''} onChange={(e) => set('label', e.target.value)} placeholder="e.g. Finance Office" /></Field>
          <Field label="How old is this WhatsApp number? (months)"><input className="input" type="number" min={0} value={v.age_months ?? 0} onChange={(e) => set('age_months', Number(e.target.value))} /></Field>
          <Field label="Average chats per day (last 3 months)" hint="Normal conversations people have with this number — not bulk messages.">
            <input className="input" type="number" min={0} value={v.avg_chats_day ?? 0} onChange={(e) => set('avg_chats_day', Number(e.target.value))} />
          </Field>
          <Toggle checked={!!v.is_business} onChange={(x) => set('is_business', x)} label="WhatsApp Business with a complete profile" hint="Name, logo, address and description filled in" />
          <Toggle checked={!!v.saved_by_contacts} onChange={(x) => set('saved_by_contacts', x)} label="Most recipients have saved this number" hint="e.g. printed on school letterheads, diaries, circulars" />
          <Toggle checked={!!v.past_ban} onChange={(x) => set('past_ban', x)} label="Was ever banned or restricted" />
        </div>
        <div className="space-y-3">
          <div className="rounded-lg bg-slate-50 p-3">
            <div className="text-xs text-slate-500">Trust score</div>
            <div className="text-2xl font-semibold">{score} <span className="text-base font-medium text-slate-600">· {lvl?.level}</span></div>
            {lvl && <div className="mt-1 text-xs text-slate-600">Starts at <b>{lvl.startCap}</b> messages/day, grows <b>+{lvl.rampPct}%</b> after each healthy day (failures under 5%, no disconnects, cap mostly used).</div>}
            <table className="mt-3 w-full text-xs">
              <tbody>{levels.map((l) => (
                <tr key={l.level} className={l.level === lvl?.level ? 'font-semibold text-brand-800' : 'text-slate-500'}>
                  <td>{l.level}</td><td>score {l.minScore}+</td><td>{l.startCap}/day</td><td>+{l.rampPct}%</td>
                </tr>))}</tbody>
            </table>
          </div>
          <Field label="Maximum per day (ceiling)"><input className="input" type="number" min={1} max={5000} value={v.max_cap ?? 1000} onChange={(e) => set('max_cap', Number(e.target.value))} /></Field>
          <Field label="Manual cap override (optional)" hint="Leave empty for automatic warm-up. A value here replaces the automatic cap.">
            <input className="input" type="number" min={0} value={v.cap_override ?? ''} onChange={(e) => set('cap_override', e.target.value === '' ? null : Number(e.target.value))} />
          </Field>
          {v.id && <Toggle checked={v.ramp_enabled ?? true} onChange={(x) => set('ramp_enabled', x)} label="Automatic daily ramp-up" />}
          {v.id && <div className="text-xs text-slate-500">Current automatic cap: <b>{v.daily_cap}</b>/day. Changing the level resets it to the level's starting cap.</div>}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy || !v.label?.trim()} onClick={save}>{v.id ? 'Save' : 'Add & show QR'}</button>
      </div>
    </Modal>
  );
}

function QrModal({ n, onClose }: { n: Num; onClose: () => void }) {
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState(n.status);
  const [code, setCode] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const toast = useToast();
  useEffect(() => {
    const t = setInterval(async () => {
      setTick((x) => x + 1);
      const list = await api.get<Num[]>('/numbers').catch(() => []);
      const cur = list.find((x) => x.id === n.id);
      if (cur) setStatus(cur.status);
    }, 4000);
    return () => clearInterval(t);
  }, [n.id]);
  const pair = async () => {
    try { setCode((await api.post<{ code: string }>(`/numbers/${n.id}/pairing-code`, { phone })).code); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal open title={`Connect "${n.label}"`} onClose={onClose}>
      {status === 'WORKING' ? (
        <div className="py-6 text-center">
          <div className="text-4xl">✅</div>
          <p className="mt-2 font-medium">Connected!</p>
          <button className="btn-primary mt-4" onClick={onClose}>Done</button>
        </div>
      ) : (
        <>
          <ol className="mb-3 list-decimal space-y-0.5 pl-5 text-sm text-slate-600">
            <li>Open WhatsApp on the phone for <b>{n.label}</b></li>
            <li>Tap <b>⋮ / Settings → Linked devices → Link a device</b></li>
            <li>Point the phone at this QR code</li>
          </ol>
          <div className="grid place-items-center rounded-lg bg-slate-50 p-4">
            {status === 'SCAN_QR_CODE'
              ? <img src={`/api/numbers/${n.id}/qr?t=${Math.floor(tick / 5)}`} alt="WhatsApp QR code" className="h-64 w-64" />
              : <div className="py-16 text-sm text-slate-500">Preparing session… ({statusLabel(status)})</div>}
          </div>
          <p className="mt-2 text-center text-xs text-slate-500">The QR refreshes automatically. This window closes itself once connected.</p>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-brand-700">Can't scan? Link with a code instead</summary>
            <div className="mt-2 flex gap-2">
              <input className="input" placeholder="Phone with country code, e.g. 919876543210" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <button className="btn-secondary" disabled={!phone} onClick={pair}>Get code</button>
            </div>
            {code && <p className="mt-2">On the phone choose <b>Link with phone number instead</b> and enter: <b className="font-mono text-lg">{code}</b></p>}
          </details>
        </>
      )}
    </Modal>
  );
}

function GroupsModal({ n, onClose }: { n: Num; onClose: () => void }) {
  const toast = useToast();
  const { data, reload, setData } = useLoad(() => api.get<any[]>(`/numbers/${n.id}/groups`), [n.id]);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try { setData(await api.post(`/numbers/${n.id}/groups/refresh`)); toast('Groups refreshed'); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`WhatsApp groups — ${n.label}`} onClose={onClose} wide>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-slate-500">Groups this number is a member of. Refresh after joining or leaving groups.</p>
        <button className="btn-secondary" disabled={busy} onClick={refresh}>{busy ? 'Refreshing…' : 'Refresh from WhatsApp'}</button>
      </div>
      {!data?.length ? <Empty>No groups loaded yet. Click <b>Refresh from WhatsApp</b>.</Empty> : (
        <div className="max-h-[50vh] overflow-y-auto">
          <table className="table">
            <thead><tr><th>Group</th><th>Members</th><th>Refreshed</th></tr></thead>
            <tbody>{data.map((g) => <tr key={g.chat_id}><td>{g.subject}</td><td>{g.participants ?? '—'}</td><td className="text-xs text-slate-500">{fmtDate(g.refreshed_at)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <div className="mt-3 text-right"><button className="btn-ghost" onClick={() => reload()}>Reload list</button></div>
    </Modal>
  );
}
