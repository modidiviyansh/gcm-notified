import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Badge, Empty, ErrorNote, Field, Modal, PageHeader, Progress, statusTone, useLoad, useToast } from '../components/ui';

export default function Campaigns() {
  const nav = useNavigate();
  const toast = useToast();
  const { data, error } = useLoad(() => api.get<any[]>('/campaigns'), [], 10_000);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'contacts' | 'wa_groups'>('contacts');

  const create = async () => {
    try {
      const c = await api.post('/campaigns', { name, kind });
      nav(`/campaigns/${c.id}/edit`);
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <>
      <PageHeader title="Campaigns" subtitle="Bulk and personalised messages with random delays" actions={<button className="btn-primary" onClick={() => setCreating(true)}>New campaign</button>} />
      <ErrorNote error={error} />
      {data && !data.length && <Empty>No campaigns yet. Create one to send a notice, greeting or marks to parents.</Empty>}
      {!!data?.length && (
        <div className="card overflow-x-auto">
          <table className="table">
            <thead><tr><th>Campaign</th><th>Status</th><th className="w-48">Progress</th><th>Delivered</th><th>Read</th><th>Failed</th><th>Created</th></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50">
                  <td>
                    <Link to={c.status === 'draft' ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                    <div className="text-xs text-slate-500">{c.kind === 'wa_groups' ? 'WhatsApp groups' : 'Contacts'}</div>
                  </td>
                  <td><Badge tone={statusTone(c.status)}>{c.status}</Badge></td>
                  <td>{c.total ? <><Progress value={c.sent + c.failed + c.skipped} max={c.total} /><div className="mt-1 text-xs text-slate-500">{c.sent}/{c.total}</div></> : '—'}</td>
                  <td>{c.delivered}</td><td>{c.read}</td><td className={c.failed ? 'text-red-600' : ''}>{c.failed}</td>
                  <td className="text-xs text-slate-500">{fmtDate(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} title="New campaign">
        <Field label="Name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali wishes 2026" /></Field>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {([['contacts', 'Parents & contacts', 'Classes, sections, your groups or a CSV (marks, fees…). Personal 1-to-1 messages.'],
             ['wa_groups', 'WhatsApp groups', 'Post into WhatsApp groups that your numbers are members of.']] as const).map(([k, t, d]) => (
            <button key={k} onClick={() => setKind(k)} className={`rounded-lg border p-3 text-left ${kind === k ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-100' : 'border-slate-200 hover:bg-slate-50'}`}>
              <div className="text-sm font-medium">{t}</div><div className="mt-1 text-xs text-slate-500">{d}</div>
            </button>
          ))}
        </div>
        <div className="mt-5 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setCreating(false)}>Cancel</button><button className="btn-primary" onClick={create}>Continue</button></div>
      </Modal>
    </>
  );
}
