import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Phone, RevealAll } from '../components/phone';
import { Badge, Card, Empty, ErrorNote, PageHeader, Progress, Stat, statusTone, useLoad, useToast } from '../components/ui';
import { describeSchedule, isTemplateSchedule, SchedulePlan } from '../components/schedule';

const FILTERS = ['', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped'];

export default function CampaignDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data: c, error, reload } = useLoad(() => api.get(`/campaigns/${id}`), [id], 5000);
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const { data: msgs } = useLoad(() => api.get<any[]>(`/campaigns/${id}/messages?status=${filter}&q=${encodeURIComponent(q)}`), [id, filter, q], 8000);

  const act = async (path: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      const r = await api.post(`/campaigns/${id}/${path}`);
      if (path === 'duplicate') return nav(`/campaigns/${r.id}/edit`);
      if (path === 'retry-failed') toast(`${r.requeued} messages queued again`);
      reload();
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  if (error) return <ErrorNote error={error} />;
  if (!c) return <p className="text-sm text-slate-500">Loading…</p>;
  if (isTemplateSchedule(c.schedule)) return <ScheduleDetail c={c} reload={reload} />;
  const done = c.sent + c.failed + c.skipped;

  return (
    <>
      <PageHeader title={c.name}
        subtitle={<><Link to="/campaigns" className="text-brand-700 hover:underline">Campaigns</Link> / {c.parent && <><Link to={`/campaigns/${c.parent.id}`} className="text-brand-700 hover:underline">{c.parent.name}</Link> / </>}<Badge tone={statusTone(c.status)}>{c.status}</Badge> · started {fmtDate(c.started_at)}{c.finished_at ? ` · finished ${fmtDate(c.finished_at)}` : ''}</>}
        actions={<>
          {c.status === 'running' && <button className="btn-secondary" onClick={() => act('pause')}>Pause</button>}
          {c.status === 'paused' && <button className="btn-primary" onClick={() => act('resume')}>Resume</button>}
          {['running', 'paused'].includes(c.status) && <button className="btn-ghost text-red-600" onClick={() => act('cancel', 'Cancel this campaign? Messages not yet sent will be skipped.')}>Cancel</button>}
          {c.failed > 0 && <button className="btn-secondary" onClick={() => act('retry-failed', `Retry ${c.failed} failed messages?`)}>Retry failed</button>}
          <button className="btn-ghost" onClick={() => act('duplicate')}>Duplicate</button>
        </>} />

      <div className="space-y-5">
        <Card>
          <div className="mb-2 flex justify-between text-sm"><span>{done} of {c.total} processed</span><span className="text-slate-500">{c.queued} waiting</span></div>
          <Progress value={done} max={c.total} />
          {c.schedule?.mode === 'spread' && <p className="mt-2 text-xs text-slate-600">{describeSchedule(c.schedule)}</p>}
          {c.status === 'running' && c.queued > 0 && <p className="mt-2 text-xs text-slate-500">Sending with random {c.delay_min_ms / 1000}–{c.delay_max_ms / 1000} s gaps{c.respect_quiet_hours ? ', pausing during quiet hours' : ''}. Numbers that reach their daily cap continue tomorrow.</p>}
        </Card>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Sent" value={c.sent} />
          <Stat label="Delivered" value={c.delivered} hint={c.sent ? `${Math.round((c.delivered / c.sent) * 100)}%` : undefined} />
          <Stat label="Read" value={c.read} hint={c.sent ? `${Math.round((c.read / c.sent) * 100)}%` : undefined} />
          <Stat label="Failed" value={c.failed} tone={c.failed ? 'red' : undefined} />
          <Stat label="Skipped" value={c.skipped} hint="opted out / not on WhatsApp" />
        </div>
        {c.byNumber?.length > 0 && (
          <Card title="By number">
            <div className="flex flex-wrap gap-4 text-sm">{c.byNumber.map((n: any) => <div key={n.id}><b>{n.label}</b>: {n.sent} sent{n.failed ? <span className="text-red-600"> · {n.failed} failed</span> : ''}</div>)}</div>
          </Card>
        )}
        <Card title="Messages" actions={<>
          <RevealAll />
          <input className="input w-48" placeholder="Search recipient / phone" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input w-auto" value={filter} onChange={(e) => setFilter(e.target.value)}>{FILTERS.map((f) => <option key={f} value={f}>{f || 'All statuses'}</option>)}</select>
        </>}>
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Recipient</th><th>Status</th><th>From</th><th>Sent</th><th>Message</th></tr></thead>
              <tbody>{msgs?.map((m) => (
                <tr key={m.id}>
                  <td><div>{m.recipient}{m.phone_label && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-px text-[11px] text-slate-600">{m.phone_label}</span>}</div><div className="text-xs text-slate-500">{m.phone ? <Phone value={m.phone} /> : /^\d+@(c\.us|s\.whatsapp\.net)$/.test(m.chat_id ?? '') ? <Phone value={m.chat_id.split('@')[0]} /> : m.chat_id}</div></td>
                  <td><Badge tone={statusTone(m.status)}>{m.status}</Badge>{m.error && <div className="mt-1 max-w-56 text-xs text-red-600">{m.error}</div>}</td>
                  <td className="text-xs">{m.number_label ?? '—'}</td>
                  <td className="whitespace-nowrap text-xs text-slate-500">{fmtDate(m.sent_at)}</td>
                  <td className="max-w-md whitespace-pre-wrap text-xs text-slate-600">{m.body}</td>
                </tr>))}</tbody>
            </table>
            {msgs?.length === 200 && <p className="mt-2 text-xs text-slate-500">Showing the first 200 — use search or the status filter.</p>}
          </div>
        </Card>
      </div>
    </>
  );
}

function ScheduleDetail({ c, reload }: { c: any; reload: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const { data: plan } = useLoad(() => api.get(`/campaigns/${c.id}/schedule`), [c.id, c.status, c.next_run_at]);
  const act = async (path: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      const r = await api.post(`/campaigns/${c.id}/${path}`);
      if (path === 'duplicate') return nav(`/campaigns/${r.id}/edit`);
      if (path === 'unschedule') return nav(`/campaigns/${c.id}/edit`);
      reload();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const label = c.status === 'scheduled' ? 'active' : c.status === 'completed' ? 'ended' : c.status;
  const runs: any[] = c.runList ?? [];
  const sum = (k: string) => runs.reduce((a, r) => a + (r[k] ?? 0), 0);
  return (
    <>
      <PageHeader title={c.name}
        subtitle={<><Link to="/campaigns" className="text-brand-700 hover:underline">Campaigns</Link> / <Badge tone={c.status === 'scheduled' ? 'violet' : statusTone(c.status)}>{label}</Badge> · {describeSchedule(c.schedule)}</>}
        actions={<>
          {c.status === 'scheduled' && <button className="btn-secondary" onClick={() => act('pause')}>Pause</button>}
          {c.status === 'paused' && <button className="btn-primary" onClick={() => act('resume')}>Resume</button>}
          {['scheduled', 'paused'].includes(c.status) && <button className="btn-secondary" onClick={() => act('unschedule', 'Stop the schedule and edit it? Runs so far are kept; activate it again when done.')}>Edit</button>}
          {['scheduled', 'paused'].includes(c.status) && <button className="btn-ghost text-red-600" onClick={() => act('cancel', 'End this schedule? No more runs will be sent.')}>End</button>}
          <button className="btn-ghost" onClick={() => act('duplicate')}>Duplicate</button>
        </>} />
      <div className="space-y-5">
        <Card title="Schedule">
          <div className="space-y-2">
            <p className="text-sm">{c.status === 'scheduled' && c.next_run_at ? <>Next run <b>{fmtDate(c.next_run_at)}</b></> : c.status === 'paused' ? 'Paused — no runs until you resume.' : 'This schedule has ended.'}
              {c.last_run_at && <span className="text-slate-500"> · last run {fmtDate(c.last_run_at)}</span>}</p>
            {c.status === 'scheduled' && <SchedulePlan plan={plan} />}
          </div>
        </Card>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Runs" value={runs.length} />
          <Stat label="Sent" value={sum('sent')} />
          <Stat label="Delivered" value={sum('delivered')} />
          <Stat label="Read" value={sum('read')} />
          <Stat label="Failed" value={sum('failed')} tone={sum('failed') ? 'red' : undefined} />
        </div>
        <Card title="Runs">
          {!runs.length ? <Empty>No runs yet.</Empty> : (
            <div className="overflow-x-auto">
              <table className="table">
                <thead><tr><th>Run</th><th>Status</th><th className="w-44">Progress</th><th>Delivered</th><th>Read</th><th>Failed</th></tr></thead>
                <tbody>{runs.map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/campaigns/${r.id}`} className="font-medium hover:underline">{r.name.replace(`${c.name} · `, '')}</Link><div className="text-xs text-slate-500">{fmtDate(r.started_at)}</div></td>
                    <td><Badge tone={statusTone(r.status)}>{r.status}</Badge></td>
                    <td>{r.total ? <><Progress value={r.sent + r.failed + r.skipped} max={r.total} /><div className="mt-1 text-xs text-slate-500">{r.sent}/{r.total}</div></> : '—'}</td>
                    <td>{r.delivered}</td><td>{r.read}</td><td className={r.failed ? 'text-red-600' : ''}>{r.failed}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
