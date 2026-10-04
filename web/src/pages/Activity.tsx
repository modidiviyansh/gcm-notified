import { useState } from 'react';
import { api, fmtDate } from '../api';
import { Badge, Card, PageHeader, useLoad } from '../components/ui';

export default function Activity() {
  const { data } = useLoad(() => api.get<any[]>('/events'), [], 15_000);
  const [level, setLevel] = useState('');
  const rows = (data ?? []).filter((e) => !level || e.level === level);
  return (
    <>
      <PageHeader title="Activity" subtitle="Connections, syncs, campaigns, opt-outs and alerts"
        actions={<select className="input w-auto" value={level} onChange={(e) => setLevel(e.target.value)}><option value="">All</option><option value="warn">Warnings</option><option value="error">Errors</option></select>} />
      <Card>
        <table className="table">
          <thead><tr><th className="w-36">When</th><th className="w-24">Type</th><th>Event</th></tr></thead>
          <tbody>{rows.map((e) => (
            <tr key={e.id}>
              <td className="text-xs text-slate-500">{fmtDate(e.created_at)}</td>
              <td><Badge tone={e.level === 'error' ? 'red' : e.level === 'warn' ? 'amber' : 'slate'}>{e.kind}</Badge></td>
              <td className="text-sm">{e.message}</td>
            </tr>))}</tbody>
        </table>
      </Card>
    </>
  );
}
