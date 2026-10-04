import { useEffect, useState } from 'react';
import { api, fmtDate } from '../../api';
import { Badge, Card, Field, Progress, statusLabel, statusTone, Toggle, useLoad, useToast } from '../../components/ui';
import { Phone } from '../../components/phone';

const ACTION: Record<string, [string, string]> = {
  ignored: ['rang on phone', 'slate'], rejected: ['declined', 'amber'], 'rejected+replied': ['declined + replied', 'blue'], failed: ['decline failed', 'red'],
};

function NumberCallCard({ n, onSaved }: { n: any; onSaved: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({ auto_use: n.auto_use, call_policy: n.call_policy, call_reply: n.call_reply ?? '' });
  useEffect(() => setV({ auto_use: n.auto_use, call_policy: n.call_policy, call_reply: n.call_reply ?? '' }), [n]);
  const dirty = v.auto_use !== n.auto_use || v.call_policy !== n.call_policy || v.call_reply !== (n.call_reply ?? '');
  const save = async () => {
    try { await api.put(`/numbers/${n.id}`, v); toast(`"${n.label}" saved`); onSaved(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="font-medium">{n.label}</span>
        <span className="text-xs text-slate-500"><Phone value={n.phone} /></span>
        <Badge tone={statusTone(n.status)}>{statusLabel(n.status)}</Badge>
        <span className="flex-1" />
        {dirty && <button className="btn-primary py-1" onClick={save}>Save</button>}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Toggle checked={v.auto_use} onChange={(x) => setV({ ...v, auto_use: x })} label="App may use this number on its own"
          hint="For API messages sent without a number, and for the weekly WhatsApp check. Turn off for a personal number." />
        <div>
          <span className="label">When someone calls this number</span>
          <div className="space-y-1.5 text-sm">
            <label className="flex items-start gap-2"><input type="radio" className="mt-1" checked={v.call_policy === 'ignore'} onChange={() => setV({ ...v, call_policy: 'ignore' })} />
              <span>Let it ring on the phone <span className="block text-xs text-slate-500">Someone answers on the phone where WhatsApp is installed</span></span></label>
            <label className="flex items-start gap-2"><input type="radio" className="mt-1" checked={v.call_policy === 'reject'} onChange={() => setV({ ...v, call_policy: 'reject' })} />
              <span>Decline automatically <span className="block text-xs text-slate-500">For a messaging-only number nobody picks up</span></span></label>
          </div>
        </div>
      </div>
      {v.call_policy === 'reject' && (
        <Field label="Reply after declining (empty = no reply)" hint="Sent at most once every 6 hours to the same caller.">
          <textarea className="input mt-1 h-20" value={v.call_reply} onChange={(e) => setV({ ...v, call_reply: e.target.value })}
            placeholder="This number does not take calls. For queries please call the school office at 0141-XXXXXXX (9 am – 2 pm)." />
        </Field>
      )}
    </div>
  );
}

export function CallsTab() {
  const { data, reload } = useLoad(() => api.get('/calls'), [], 30_000);
  return (
    <div className="space-y-5">
      <Card title="Numbers & incoming calls">
        <p className="mb-4 text-sm text-slate-600">
          GCM Notified is a <i>linked device</i>, like WhatsApp Web: it can't answer calls, and every call keeps ringing on the phone itself
          unless you choose to decline it here. Calls are listed below either way.
        </p>
        <div className="space-y-3">{(data?.numbers ?? []).map((n: any) => <NumberCallCard key={n.id} n={n} onSaved={reload} />)}</div>
        {data && !data.numbers.length && <p className="text-sm text-slate-500">No numbers yet — add one on the Numbers page.</p>}
      </Card>
      <Card title="Recent calls" actions={data && <span className="text-xs text-slate-500">{data.last7days} in the last 7 days</span>}>
        {data?.recent.length ? (
          <table className="table">
            <thead><tr><th>When</th><th>From</th><th>To number</th><th>What happened</th></tr></thead>
            <tbody>{data.recent.map((c: any) => (
              <tr key={c.id}>
                <td className="text-xs text-slate-500">{fmtDate(c.created_at)}</td>
                <td><Phone value={c.phone} missing="hidden number" /> {c.video && <Badge>video</Badge>}</td>
                <td className="text-xs">{c.label}</td>
                <td><Badge tone={ACTION[c.action]?.[1] ?? 'slate'}>{ACTION[c.action]?.[0] ?? c.action}</Badge></td>
              </tr>))}</tbody>
          </table>
        ) : <p className="text-sm text-slate-500">No calls received since call tracking started.</p>}
      </Card>
    </div>
  );
}

export function WaCheckTab({ value, onChange }: { value: { enabled: boolean; everyDays: number; perHour: number }; onChange: (v: any) => void }) {
  const { data: st } = useLoad(() => api.get('/wa-check'), [], 30_000);
  return (
    <Card title="WhatsApp check">
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          Every parent, student and contact number is checked: is it on WhatsApp? Contacts show a <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" /> green dot
          or a <span className="rounded bg-red-50 px-1.5 text-[11px] font-medium text-red-700">No WhatsApp</span> tag, and campaigns skip numbers that aren't on WhatsApp.
          Checks run slowly in the background during the day.
        </p>
        <Toggle checked={value.enabled} onChange={(x) => onChange({ ...value, enabled: x })} label="Check numbers automatically" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Re-check every (days)"><input className="input" type="number" min={1} max={90} value={value.everyDays} onChange={(e) => onChange({ ...value, everyDays: Number(e.target.value) })} /></Field>
          <Field label="Checks per hour" hint="Keep it modest — a few a minute looks normal to WhatsApp."><input className="input" type="number" min={10} max={1000} value={value.perHour} onChange={(e) => onChange({ ...value, perHour: Number(e.target.value) })} /></Field>
        </div>
        {st && (
          <div className="rounded-lg bg-slate-50 p-3 text-sm">
            <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1">
              <span><b className="tabular-nums">{st.total.toLocaleString('en-IN')}</b> numbers</span>
              <span className="text-emerald-700"><b className="tabular-nums">{st.onWhatsapp.toLocaleString('en-IN')}</b> on WhatsApp</span>
              <span className="text-red-700"><b className="tabular-nums">{st.notOnWhatsapp.toLocaleString('en-IN')}</b> not on WhatsApp</span>
              {st.unchecked > 0 && <span className="text-slate-500"><b className="tabular-nums">{st.unchecked.toLocaleString('en-IN')}</b> not checked yet</span>}
            </div>
            <Progress value={st.total - st.due} max={st.total} />
            <p className="mt-2 text-xs text-slate-500">
              {st.due ? `${st.due.toLocaleString('en-IN')} due for a check · about ${st.hoursToFinish} h at this pace` : 'All numbers are up to date.'}
              {' · '}{st.checker ? <>checking from <b>{st.checker}</b></> : <span className="text-amber-700">no connected number may be used automatically — see Numbers &amp; calls</span>}
              {st.lastCheckAt && <> · last check {fmtDate(st.lastCheckAt)}</>}
            </p>
            {st.error && <p className="mt-1 text-xs text-red-600">Paused for 15 minutes: {st.error}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}
