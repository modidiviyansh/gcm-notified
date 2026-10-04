import { useEffect, useState } from 'react';
import { api, fmtDate, fmtPhone } from '../api';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHeader, useLoad, useToast } from '../components/ui';

export interface GroupNode { id: number; parent_id: number | null; name: string; source: 'frappe' | 'manual'; students: number; contacts: number; total?: number; children: GroupNode[] }

export default function Contacts() {
  const [tab, setTab] = useState<'groups' | 'optouts' | 'missing'>('groups');
  return (
    <>
      <PageHeader title="Contacts" subtitle="Classes & sections from Frappe, plus your own contact groups" actions={<SyncButton />} />
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {([['groups', 'Groups'], ['optouts', 'Opted out'], ['missing', 'Missing numbers']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-brand-700 font-medium text-brand-800' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>{l}</button>
        ))}
      </div>
      {tab === 'groups' && <Groups />}
      {tab === 'optouts' && <OptOuts />}
      {tab === 'missing' && <Missing />}
    </>
  );
}

function SyncButton() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get('/sync'), [], 15_000);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post('/sync');
      toast(`Synced ${r.students} students · ${r.groups} classes · ${r.subgroups} sections`);
      reload();
      window.dispatchEvent(new Event('groups-changed'));
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  if (data && !data.configured) return <Badge tone="amber">Frappe not configured</Badge>;
  return (
    <div className="flex items-center gap-3">
      {data?.last && <span className="text-xs text-slate-500">Last sync {fmtDate(data.last.started_at)} {data.last.ok === false && <span className="text-red-600">(failed)</span>}</span>}
      <button className="btn-secondary" disabled={busy || data?.running} onClick={run}>{busy || data?.running ? 'Syncing…' : 'Sync from Frappe'}</button>
    </div>
  );
}

function Groups() {
  const toast = useToast();
  const { data: tree, error, reload } = useLoad(() => api.get<GroupNode[]>('/groups'), []);
  const [sel, setSel] = useState<GroupNode | null>(null);
  const [newGroup, setNewGroup] = useState<{ parent: GroupNode | null } | null>(null);
  const [adding, setAdding] = useState<GroupNode | null>(null);
  useEffect(() => {
    window.addEventListener('groups-changed', reload);
    return () => window.removeEventListener('groups-changed', reload);
  }, [reload]);

  const frappe = tree?.filter((g) => g.source === 'frappe') ?? [];
  const manual = tree?.filter((g) => g.source === 'manual') ?? [];

  const del = async (g: GroupNode) => {
    if (!confirm(`Delete group "${g.name}" and all its contacts?`)) return;
    try { await api.del(`/groups/${g.id}`); toast('Deleted'); setSel(null); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  const Tree = ({ nodes }: { nodes: GroupNode[] }) => (
    <ul className="space-y-0.5">
      {nodes.map((g) => (
        <li key={g.id}>
          <button onClick={() => setSel(g)} className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${sel?.id === g.id ? 'bg-brand-50 font-medium text-brand-800' : 'hover:bg-slate-50'}`}>
            <span>{g.name}</span><span className="text-xs text-slate-400">{g.total ?? g.students + g.contacts}</span>
          </button>
          {g.children.length > 0 && (
            <ul className="ml-3 border-l border-slate-100 pl-2">
              {g.children.map((c) => (
                <li key={c.id}>
                  <button onClick={() => setSel(c)} className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm ${sel?.id === c.id ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-600 hover:bg-slate-50'}`}>
                    <span>{c.name}</span><span className="text-xs text-slate-400">{c.students + c.contacts}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="grid gap-4 md:grid-cols-[280px_1fr]">
      <div className="space-y-4">
        <ErrorNote error={error} />
        <Card title="School (from Frappe)">
          {frappe.length ? <Tree nodes={frappe} /> : <Empty>Not synced yet. Click <b>Sync from Frappe</b>.</Empty>}
        </Card>
        <Card title="My groups" actions={<button className="btn-ghost px-2 py-1 text-xs" onClick={() => setNewGroup({ parent: null })}>+ Group</button>}>
          {manual.length ? <Tree nodes={manual} /> : <Empty>Staff, vendors, imported broadcast lists…</Empty>}
        </Card>
      </div>
      <div>
        {sel ? <Members group={sel} onAdd={() => setAdding(sel)} onDelete={() => del(sel)} onSub={() => setNewGroup({ parent: sel })} onRenamed={reload} />
          : <Empty>Select a group to see its members.</Empty>}
      </div>
      {newGroup && <NewGroupModal parent={newGroup.parent} onClose={() => setNewGroup(null)} onDone={() => { setNewGroup(null); reload(); }} />}
      {adding && <AddContactsModal group={adding} onClose={() => setAdding(null)} onDone={() => { setAdding(null); reload(); setSel({ ...adding }); }} />}
    </div>
  );
}

function Members({ group, onAdd, onDelete, onSub, onRenamed }: { group: GroupNode; onAdd: () => void; onDelete: () => void; onSub: () => void; onRenamed: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const { data, reload } = useLoad(() => api.get(`/groups/${group.id}/members?q=${encodeURIComponent(q)}`), [group.id, q, group]);
  const manual = group.source === 'manual';
  const rename = async () => {
    const name = prompt('New name', group.name);
    if (!name) return;
    await api.put(`/groups/${group.id}`, { name }); toast('Renamed'); onRenamed();
  };
  const removeContact = async (id: number) => { await api.del(`/contacts/${id}`); reload(); };
  return (
    <Card title={<>{group.name} {group.source === 'frappe' && <Badge tone="blue">Frappe</Badge>}</>}
      actions={manual && <>
        <button className="btn-primary" onClick={onAdd}>Add / import contacts</button>
        {!group.parent_id && <button className="btn-secondary" onClick={onSub}>+ Subgroup</button>}
        <button className="btn-ghost" onClick={rename}>Rename</button>
        <button className="btn-ghost text-red-600" onClick={onDelete}>Delete</button>
      </>}>
      <input className="input mb-3" placeholder={manual ? 'Search name or phone' : 'Search student name or admission no.'} value={q} onChange={(e) => setQ(e.target.value)} />
      {data?.students?.length > 0 && (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Adm. no</th><th>Student</th><th>Section</th><th>Father</th><th>Mother</th></tr></thead>
            <tbody>{data.students.map((s: any) => (
              <tr key={s.id}>
                <td className="font-mono text-xs">{s.admission_no}</td>
                <td>{s.student_name}</td>
                <td className="text-xs">{s.section ?? '—'}</td>
                <td className="text-xs">{s.father_name}<br /><span className={s.father_phone ? 'text-slate-500' : 'text-red-500'}>{s.father_phone ? fmtPhone(s.father_phone) : 'missing'}</span>{s.father_opted_out && <Badge tone="amber">opted out</Badge>}</td>
                <td className="text-xs">{s.mother_name}<br /><span className={s.mother_phone ? 'text-slate-500' : 'text-red-500'}>{s.mother_phone ? fmtPhone(s.mother_phone) : 'missing'}</span>{s.mother_opted_out && <Badge tone="amber">opted out</Badge>}</td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
      {data?.contacts?.length > 0 && (
        <table className="table">
          <thead><tr><th>Name</th><th>Phone</th><th>Extra fields</th><th /></tr></thead>
          <tbody>{data.contacts.map((c: any) => (
            <tr key={c.id}>
              <td>{c.name ?? '—'}</td><td>{fmtPhone(c.phone)} {c.opted_out && <Badge tone="amber">opted out</Badge>}</td>
              <td className="text-xs text-slate-500">{Object.entries(c.extra ?? {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td>
              <td className="text-right">{manual && <button className="text-xs text-red-600 hover:underline" onClick={() => removeContact(c.id)}>Remove</button>}</td>
            </tr>))}</tbody>
        </table>
      )}
      {data && !data.students?.length && !data.contacts?.length && <Empty>No members{q ? ' match your search' : ''}.</Empty>}
    </Card>
  );
}

function NewGroupModal({ parent, onClose, onDone }: { parent: GroupNode | null; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const save = async () => {
    try { await api.post('/groups', { name, parent_id: parent?.id ?? null }); toast('Group created'); onDone(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal open title={parent ? `New subgroup in "${parent.name}"` : 'New group'} onClose={onClose}>
      <Field label="Name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={parent ? 'e.g. Drivers' : 'e.g. Staff'} /></Field>
      <div className="mt-4 flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!name.trim()} onClick={save}>Create</button></div>
    </Modal>
  );
}

function AddContactsModal({ group, onClose, onDone }: { group: GroupNode; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const report = (r: any) => toast(`Added ${r.added}, updated ${r.updated}${r.invalid ? `, ${r.invalid} invalid skipped` : ''}`, r.invalid ? 'error' : 'ok');
  const paste = async () => {
    setBusy(true);
    try { report(await api.post(`/groups/${group.id}/contacts`, { text })); onDone(); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try { report(await api.upload(`/groups/${group.id}/import`, f)); onDone(); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  return (
    <Modal open title={`Add contacts to "${group.name}"`} onClose={onClose} wide>
      <div className="grid gap-5 md:grid-cols-2">
        <div>
          <h4 className="mb-1 text-sm font-medium">Paste</h4>
          <p className="mb-2 text-xs text-slate-500">One per line: <code>Name, 98765 43210</code> — or just numbers.</p>
          <textarea className="input h-48 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={'Ramesh Kumar, 98765 43210\nSunita, +91 98111 22233\n9876501234'} />
          <button className="btn-primary mt-2" disabled={busy || !text.trim()} onClick={paste}>Add</button>
        </div>
        <div>
          <h4 className="mb-1 text-sm font-medium">Import CSV</h4>
          <p className="mb-2 text-xs text-slate-500">Needs a <b>Phone</b> (or Mobile) column; <b>Name</b> is optional. Every other column is saved and usable as a variable, e.g. <code>{'{{route}}'}</code>.</p>
          <input type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-brand-800" />
          <p className="mt-3 text-xs text-slate-500">Recreating a phone broadcast list? Export or type its members into a CSV once — then reuse this group in any campaign.</p>
        </div>
      </div>
    </Modal>
  );
}

function OptOuts() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get<any[]>('/opt-outs'), []);
  const [phone, setPhone] = useState('');
  const add = async () => { try { await api.post('/opt-outs', { phone }); setPhone(''); reload(); } catch (e) { toast((e as Error).message, 'error'); } };
  const remove = async (p: string) => { if (confirm('Allow messages to this number again?')) { await api.del(`/opt-outs/${p}`); reload(); } };
  return (
    <Card title={`Opted out (${data?.length ?? 0})`} actions={<div className="flex gap-2"><input className="input w-56" placeholder="Add number manually" value={phone} onChange={(e) => setPhone(e.target.value)} /><button className="btn-secondary" disabled={!phone} onClick={add}>Add</button></div>}>
      <p className="mb-3 text-sm text-slate-500">People who replied <b>STOP</b> or <b>UNSUBSCRIBE</b>. They are skipped in every campaign, and Frappe syncs never re-add them.</p>
      {!data?.length ? <Empty>Nobody has opted out.</Empty> : (
        <table className="table"><thead><tr><th>Phone</th><th>How</th><th>When</th><th /></tr></thead>
          <tbody>{data.map((o) => <tr key={o.phone}><td>{fmtPhone(o.phone)}</td><td>{o.reason}</td><td className="text-xs text-slate-500">{fmtDate(o.created_at)}</td><td className="text-right"><button className="text-xs text-brand-700 hover:underline" onClick={() => remove(o.phone)}>Re-allow</button></td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}

function Missing() {
  const { data } = useLoad(() => api.get<any[]>('/reports/missing-numbers'), []);
  const both = data?.filter((r) => r.father_missing && r.mother_missing).length ?? 0;
  const csv = () => {
    const rows = [['Admission No', 'Student', 'Class', 'Section', 'Father number', 'Mother number'], ...(data ?? []).map((r) => [r.admission_no, r.student_name, r.program, r.section ?? '', r.father_missing ? 'MISSING' : 'ok', r.mother_missing ? 'MISSING' : 'ok'])];
    const blob = new Blob([rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'missing-numbers.csv'; a.click();
  };
  return (
    <Card title={`Students with a missing parent number (${data?.length ?? 0})`} actions={<button className="btn-secondary" onClick={csv} disabled={!data?.length}>Download CSV</button>}>
      <p className="mb-3 text-sm text-slate-500"><b className="text-red-600">{both}</b> cannot be reached at all. Fix numbers in Frappe — the next sync picks them up.</p>
      <div className="max-h-[60vh] overflow-y-auto">
        <table className="table"><thead><tr><th>Adm. no</th><th>Student</th><th>Section</th><th>Father</th><th>Mother</th></tr></thead>
          <tbody>{data?.map((r) => (
            <tr key={r.admission_no} className={r.father_missing && r.mother_missing ? 'bg-red-50' : ''}>
              <td className="font-mono text-xs">{r.admission_no}</td><td>{r.student_name}</td><td className="text-xs">{r.section ?? r.program}</td>
              <td>{r.father_missing ? <Badge tone="red">missing</Badge> : '✓'}</td><td>{r.mother_missing ? <Badge tone="red">missing</Badge> : '✓'}</td>
            </tr>))}</tbody>
        </table>
      </div>
    </Card>
  );
}
