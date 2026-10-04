import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Badge, Card, Empty, ErrorNote, PageHeader, Progress, Stat, statusLabel, statusTone, useLoad } from '../components/ui';

export default function Dashboard() {
  const { data, error } = useLoad(() => api.get('/dashboard'), [], 10_000);
  const d = data;
  return (
    <>
      <PageHeader title="Dashboard" subtitle="Today at a glance" actions={<Link to="/campaigns" className="btn-primary">New campaign</Link>} />
      <ErrorNote error={error} />
      {d && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Sent today" value={d.today?.sent ?? 0} />
            <Stat label="Delivered" value={d.today?.delivered ?? 0} hint={d.today?.sent ? `${Math.round(((d.today.delivered ?? 0) / d.today.sent) * 100)}%` : undefined} />
            <Stat label="Read" value={d.today?.read ?? 0} />
            <Stat label="Failed (24 h)" value={d.today?.failed ?? 0} tone={d.today?.failed ? 'red' : undefined} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Numbers" actions={<Link to="/numbers" className="text-xs text-brand-700 hover:underline">Manage</Link>}>
              {d.numbers.length === 0 ? <Empty>No numbers yet. <Link className="text-brand-700 underline" to="/numbers">Add your first WhatsApp number</Link>.</Empty> : (
                <ul className="divide-y divide-slate-100">
                  {d.numbers.map((n: any) => (
                    <li key={n.id} className="flex items-center justify-between py-2 text-sm">
                      <span className="font-medium">{n.label}</span>
                      <span className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">{n.sent_today} sent{n.failed_today ? ` · ${n.failed_today} failed` : ''}</span>
                        {n.paused ? <Badge tone="amber">Paused</Badge> : <Badge tone={statusTone(n.status)}>{statusLabel(n.status)}</Badge>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title="Running campaigns">
              {d.running.length === 0 ? <Empty>Nothing is sending right now.</Empty> : (
                <ul className="space-y-3">
                  {d.running.map((c: any) => (
                    <li key={c.id}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <Link to={`/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                        <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                      </div>
                      <Progress value={c.sent + c.failed + c.skipped} max={c.total} />
                      <div className="mt-1 text-xs text-slate-500">{c.sent} / {c.total} sent{c.failed ? ` · ${c.failed} failed` : ''}</div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Recently finished">
              {d.recent.length === 0 ? <Empty>No finished campaigns yet.</Empty> : (
                <table className="table">
                  <thead><tr><th>Campaign</th><th>Sent</th><th>Read</th><th>Finished</th></tr></thead>
                  <tbody>
                    {d.recent.map((c: any) => (
                      <tr key={c.id}>
                        <td><Link to={`/campaigns/${c.id}`} className="hover:underline">{c.name}</Link></td>
                        <td>{c.sent}/{c.total}</td><td>{c.read}</td><td className="text-xs text-slate-500">{fmtDate(c.finished_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Activity" actions={<Link to="/activity" className="text-xs text-brand-700 hover:underline">All</Link>}>
              <ul className="max-h-72 space-y-1.5 overflow-y-auto text-sm">
                {d.events.slice(0, 12).map((e: any, i: number) => (
                  <li key={i} className="flex gap-2">
                    <span className="w-24 shrink-0 text-xs text-slate-400">{fmtDate(e.created_at)}</span>
                    <span className={e.level === 'error' ? 'text-red-600' : e.level === 'warn' ? 'text-amber-700' : ''}>{e.message}</span>
                  </li>
                ))}
                {!d.events.length && <li className="text-slate-500">No activity yet.</li>}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
