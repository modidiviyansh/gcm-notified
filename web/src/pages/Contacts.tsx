import { ReactNode, useEffect, useState } from 'react';
import { api, fmtDate, fmtPhone } from '../api';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHeader, useLoad, useToast } from '../components/ui';

export interface GroupNode {
  id: number; parent_id: number | null; name: string; source: 'frappe' | 'manual'; description?: string | null; created_at?: string;
  students: number; contacts: number; total?: number; children: GroupNode[];
}

type Tab = 'lists' | 'school' | 'optouts';

export default function Contacts() {
  const [tab, setTab] = useState<Tab>('lists');
  const { data: tree, error, reload } = useLoad(() => api.get<GroupNode[]>('/groups'), []);
  const { data: sync } = useLoad(() => api.get('/sync'), []);
  const lists = tree?.filter((g) => g.source === 'manual') ?? [];
  const school = tree?.filter((g) => g.source === 'frappe') ?? [];
  const showSchool = !!sync?.configured || school.length > 0;
  const tabs: [Tab, string, number | null][] = [
    ['lists', 'My lists', lists.length],
    ...(showSchool ? [['school', 'School (Frappe)', school.reduce((a, g) => a + (g.total ?? 0), 0)] as [Tab, string, number]] : []),
    ['optouts', 'Opted out', null],
  ];
  return (
    <>
      <PageHeader title="Contacts" subtitle="Everyone you can message: your own lists of any kind, plus classes synced from the school system" />
      <ErrorNote error={error} />
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {tabs.map(([k, l, n]) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-brand-700 font-medium text-brand-800' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            {l}{n !== null && <span className="rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-500">{n}</span>}
          </button>
        ))}
      </div>
      {tab === 'lists' && <Lists lists={lists} reload={reload} />}
      {tab === 'school' && <School classes={school} reload={reload} />}
      {tab === 'optouts' && <OptOuts />}
    </>
  );
}

// ======================= My lists =======================

function Lists({ lists, reload }: { lists: GroupNode[]; reload: () => void }) {
  const toast = useToast();
  const [selId, setSelId] = useState<number | 'all' | null>(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ list?: GroupNode; parent?: GroupNode } | null>(null);
  const [adding, setAdding] = useState<GroupNode | null>(null);

  const flat = lists.flatMap((l) => [l, ...l.children]);
  const sel = typeof selId === 'number' ? flat.find((g) => g.id === selId) ?? null : null;
  const root = sel ? (sel.parent_id ? lists.find((l) => l.id === sel.parent_id) ?? sel : sel) : null;
  useEffect(() => { if (selId === null) setSelId(lists[0]?.id ?? 'all'); }, [lists.length]);

  const shown = lists.filter((l) => !q || [l.name, ...l.children.map((c) => c.name)].some((n) => n.toLowerCase().includes(q.toLowerCase())));
  const del = async (g: GroupNode) => {
    if (!confirm(`Delete "${g.name}"${g.children.length ? ' and its sublists' : ''} with all ${g.total ?? g.contacts} contacts in it? People who are also in other lists stay there.`)) return;
    try { await api.del(`/groups/${g.id}`); toast('List deleted'); setSelId(g.parent_id ?? null); reload(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  if (!lists.length) {
    return (
      <>
        <div className="card p-8 text-center">
          <div className="text-3xl">📇</div>
          <h2 className="mt-2 text-lg font-semibold">Create your first contact list</h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">Staff, drivers, vendors, alumni, a recreated phone broadcast list — any group of people. Paste numbers or import a CSV; extra CSV columns become message variables.</p>
          <button className="btn-primary mt-4" onClick={() => setEditing({})}>+ New list</button>
        </div>
        {editing && <ListModal {...editing} onClose={() => setEditing(null)} onDone={(g) => { setEditing(null); reload(); setSelId(g.id); setAdding(g); }} />}
        {adding && <AddContactsModal group={adding} onClose={() => setAdding(null)} onDone={() => { setAdding(null); reload(); }} />}
      </>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <aside className="card h-fit">
        <div className="flex items-center gap-2 border-b border-slate-100 p-3">
          <input className="input py-1.5" placeholder="Find a list" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn-primary whitespace-nowrap px-3 py-1.5" onClick={() => setEditing({})}>+ New</button>
        </div>
        <nav className="max-h-[65vh] overflow-y-auto p-2">
          <ListItem active={selId === 'all'} onClick={() => setSelId('all')} name="All contacts" hint="search everyone" />
          <div className="my-2 border-t border-slate-100" />
          {shown.map((l) => (
            <div key={l.id}>
              <ListItem active={selId === l.id} onClick={() => setSelId(l.id)} name={l.name} count={l.total ?? l.contacts} hint={l.description ?? undefined} />
              {l.children.map((c) => (
                <ListItem key={c.id} sub active={selId === c.id} onClick={() => setSelId(c.id)} name={c.name} count={c.contacts} />
              ))}
            </div>
          ))}
          {!shown.length && <p className="p-3 text-sm text-slate-500">No list matches “{q}”.</p>}
        </nav>
      </aside>

      <div className="min-w-0">
        {selId === 'all' && <AllContacts />}
        {sel && root && (
          <ListDetail key={sel.id} list={sel} root={root}
            onSelect={setSelId} onAdd={() => setAdding(sel)} onEdit={() => setEditing({ list: sel })}
            onSub={() => setEditing({ parent: root })} onDelete={() => del(sel)} />
        )}
      </div>

      {editing && <ListModal {...editing} onClose={() => setEditing(null)} onDone={(g) => { const isNew = !editing.list; setEditing(null); reload(); setSelId(g.id); if (isNew) setAdding(g); }} />}
      {adding && <AddContactsModal group={adding} onClose={() => setAdding(null)} onDone={() => { setAdding(null); reload(); setSelId(adding.id); }} />}
    </div>
  );
}

function ListItem({ name, count, hint, active, sub, onClick }: { name: string; count?: number; hint?: string; active: boolean; sub?: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm ${sub ? 'ml-4 w-[calc(100%-1rem)] text-[13px]' : ''} ${active ? 'bg-brand-50 font-medium text-brand-800' : 'text-slate-700 hover:bg-slate-50'}`}>
      <span className="min-w-0">
        <span className="block truncate">{sub && <span className="mr-1 text-slate-300">└</span>}{name}</span>
        {hint && !sub && <span className="block truncate text-[11px] font-normal text-slate-400">{hint}</span>}
      </span>
      {count !== undefined && <span className="shrink-0 rounded-full bg-slate-100 px-2 text-[11px] text-slate-500">{count}</span>}
    </button>
  );
}

function ListDetail({ list, root, onSelect, onAdd, onEdit, onSub, onDelete }: {
  list: GroupNode; root: GroupNode; onSelect: (id: number) => void; onAdd: () => void; onEdit: () => void; onSub: () => void; onDelete: () => void;
}) {
  const [q, setQ] = useState('');
  const { data, reload } = useLoad(() => api.get(`/groups/${list.id}/members?q=${encodeURIComponent(q)}`), [list.id, q, list.contacts, list.total]);
  const remove = async (id: number) => { await api.del(`/contacts/${id}`); reload(); };
  const contacts: any[] = data?.contacts ?? [];
  const extraCols = [...new Set(contacts.flatMap((c) => Object.keys(c.extra ?? {})))].slice(0, 4);
  const total = list.parent_id ? list.contacts : list.total ?? list.contacts;

  return (
    <Card title={
      <span className="flex flex-col">
        <span className="text-base">{list.parent_id && <span className="font-normal text-slate-400">{root.name} › </span>}{list.name}</span>
        <span className="text-xs font-normal text-slate-500">{total} contact{total === 1 ? '' : 's'}{list.description ? ` · ${list.description}` : ''}{list.created_at ? ` · created ${fmtDate(list.created_at)}` : ''}</span>
      </span>}
      actions={<>
        <button className="btn-primary" onClick={onAdd}>+ Add contacts</button>
        <button className="btn-secondary" onClick={onEdit}>Edit</button>
        {!list.parent_id && <button className="btn-secondary" onClick={onSub}>+ Sublist</button>}
        <button className="btn-ghost text-red-600" onClick={onDelete}>Delete</button>
      </>}>
      {root.children.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Chip active={list.id === root.id} onClick={() => onSelect(root.id)}>All in {root.name} ({root.total})</Chip>
          {root.children.map((c) => <Chip key={c.id} active={list.id === c.id} onClick={() => onSelect(c.id)}>{c.name} ({c.contacts})</Chip>)}
        </div>
      )}
      <input className="input mb-3" placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      {contacts.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Name</th><th>Phone</th>{extraCols.map((c) => <th key={c}>{c}</th>)}<th /></tr></thead>
            <tbody>{contacts.map((c) => (
              <tr key={c.id}>
                <td>{c.name ?? <span className="text-slate-400">—</span>}</td>
                <td className="whitespace-nowrap">{fmtPhone(c.phone)} {c.opted_out && <Badge tone="amber">opted out</Badge>}</td>
                {extraCols.map((k) => <td key={k} className="text-xs text-slate-600">{c.extra?.[k] ?? ''}</td>)}
                <td className="text-right"><button className="text-xs text-red-600 hover:underline" onClick={() => remove(c.id)}>Remove</button></td>
              </tr>))}</tbody>
          </table>
          {contacts.length >= 2000 && <p className="mt-2 text-xs text-slate-500">Showing the first 2000 — search to narrow down.</p>}
        </div>
      ) : data && (
        <Empty>{q ? 'Nobody matches your search.' : <>This list is empty. <button className="text-brand-700 underline" onClick={onAdd}>Add contacts</button> by pasting numbers or importing a CSV.</>}</Empty>
      )}
    </Card>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button onClick={onClick} className={`rounded-full px-3 py-1 text-xs ${active ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>{children}</button>;
}

function AllContacts() {
  const [q, setQ] = useState('');
  const { data } = useLoad(() => api.get<any[]>(`/contacts?q=${encodeURIComponent(q)}`), [q]);
  return (
    <Card title={<span className="flex flex-col"><span className="text-base">All contacts</span><span className="text-xs font-normal text-slate-500">Everyone in your lists, once per number</span></span>}>
      <input className="input mb-3" placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {!data?.length ? <Empty>{q ? 'Nobody matches your search.' : 'No contacts yet.'}</Empty> : (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Name</th><th>Phone</th><th>Lists</th></tr></thead>
            <tbody>{data.map((c) => (
              <tr key={c.phone}>
                <td>{c.name ?? <span className="text-slate-400">—</span>}</td>
                <td className="whitespace-nowrap">{fmtPhone(c.phone)} {c.opted_out && <Badge tone="amber">opted out</Badge>}</td>
                <td><div className="flex flex-wrap gap-1">{c.lists.map((l: string) => <Badge key={l}>{l}</Badge>)}</div></td>
              </tr>))}</tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ListModal({ list, parent, onClose, onDone }: { list?: GroupNode; parent?: GroupNode; onClose: () => void; onDone: (g: GroupNode) => void }) {
  const toast = useToast();
  const [name, setName] = useState(list?.name ?? '');
  const [description, setDescription] = useState(list?.description ?? '');
  const save = async () => {
    try {
      const g = list ? await api.put(`/groups/${list.id}`, { name, description }) : await api.post('/groups', { name, description, parent_id: parent?.id ?? null });
      toast(list ? 'Saved' : 'List created');
      onDone({ ...(list ?? {}), ...g });
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal open title={list ? `Edit "${list.name}"` : parent ? `New sublist in "${parent.name}"` : 'New contact list'} onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={parent ? 'e.g. Drivers' : 'e.g. Staff, Vendors, Alumni 2020'} /></Field>
        <Field label="Description (optional)"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who is in this list?" /></Field>
        {!list && !parent && <p className="text-xs text-slate-500">You can split a list into sublists later (e.g. Staff → Teaching, Admin, Drivers) and message either the whole list or one sublist.</p>}
      </div>
      <div className="mt-4 flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={!name.trim()} onClick={save}>{list ? 'Save' : 'Create'}</button></div>
    </Modal>
  );
}

function AddContactsModal({ group, onClose, onDone }: { group: GroupNode; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'paste' | 'csv'>('paste');
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
  const lines = text.split('\n').filter((l) => l.trim()).length;
  return (
    <Modal open title={`Add contacts to "${group.name}"`} onClose={onClose} wide>
      <div className="mb-4 flex gap-2">
        <Chip active={mode === 'paste'} onClick={() => setMode('paste')}>Paste numbers</Chip>
        <Chip active={mode === 'csv'} onClick={() => setMode('csv')}>Import CSV / Excel export</Chip>
      </div>
      {mode === 'paste' ? (
        <div>
          <p className="mb-2 text-xs text-slate-500">One person per line — <code>Name, 98765 43210</code>, <code>98765 43210 Name</code> or just the number. Indian numbers work without +91.</p>
          <textarea className="input h-56 font-mono text-xs" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={'Ramesh Kumar, 98765 43210\n+91 98111 22233 Sunita\n9876501234'} />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-slate-500">{lines} line{lines === 1 ? '' : 's'}</span>
            <button className="btn-primary" disabled={busy || !text.trim()} onClick={paste}>{busy ? 'Adding…' : 'Add to list'}</button>
          </div>
        </div>
      ) : (
        <div>
          <p className="mb-3 text-sm text-slate-600">First row = column names. Needs a <b>Phone</b> (or Mobile / WhatsApp) column; <b>Name</b> is optional. Every other column is saved with the contact and usable in messages — e.g. a <code>Route</code> column becomes <code>{'{{route}}'}</code>.</p>
          <label className="block cursor-pointer rounded-lg border-2 border-dashed border-slate-300 p-8 text-center hover:border-brand-600 hover:bg-brand-50">
            <span className="text-sm font-medium text-brand-800">{busy ? 'Importing…' : 'Choose a CSV file'}</span>
            <span className="mt-1 block text-xs text-slate-500">From Excel / Google Sheets: File → Download → CSV</span>
            <input type="file" accept=".csv,text/csv" className="hidden" disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
          </label>
          <button className="mt-2 text-xs text-brand-700 hover:underline" onClick={() => {
            const blob = new Blob(['Name,Phone,Department\nRamesh Kumar,9876543210,Transport\n'], { type: 'text/csv' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'contacts-template.csv'; a.click();
          }}>Download a sample CSV</button>
        </div>
      )}
    </Modal>
  );
}

// ======================= School (Frappe) =======================

function School({ classes, reload }: { classes: GroupNode[]; reload: () => void }) {
  const [view, setView] = useState<'classes' | 'missing'>('classes');
  const [sel, setSel] = useState<GroupNode | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          <Chip active={view === 'classes'} onClick={() => setView('classes')}>Classes & sections</Chip>
          <Chip active={view === 'missing'} onClick={() => setView('missing')}>Missing parent numbers</Chip>
        </div>
        <SyncButton onSynced={reload} />
      </div>
      <p className="text-sm text-slate-500">Read-only copy of students and parent numbers from Frappe, refreshed automatically. Fix data in Frappe — the next sync picks it up.</p>
      {view === 'missing' ? <Missing /> : !classes.length ? <Empty>Not synced yet — click <b>Sync now</b>.</Empty> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {classes.map((g) => (
              <div key={g.id} className={`card p-3 ${sel && (sel.id === g.id || sel.parent_id === g.id) ? 'ring-2 ring-brand-100' : ''}`}>
                <button className="flex w-full items-baseline justify-between text-left" onClick={() => setSel(g)}>
                  <span className="font-semibold">{g.name}</span><span className="text-xs text-slate-500">{g.total} students</span>
                </button>
                <div className="mt-2 flex flex-wrap gap-1">
                  {g.children.map((s) => (
                    <button key={s.id} onClick={() => setSel(s)} className={`rounded-md px-2 py-0.5 text-xs ${sel?.id === s.id ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                      {s.name.replace(g.name, '').trim() || s.name} <span className="opacity-60">{s.students}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {sel && <Students group={sel} />}
        </>
      )}
    </div>
  );
}

function Students({ group }: { group: GroupNode }) {
  const [q, setQ] = useState('');
  const { data } = useLoad(() => api.get(`/groups/${group.id}/members?q=${encodeURIComponent(q)}`), [group.id, q]);
  return (
    <Card title={<>{group.name} <Badge tone="blue">Frappe</Badge></>}>
      <input className="input mb-3" placeholder="Search student name or admission no." value={q} onChange={(e) => setQ(e.target.value)} />
      {!data?.students?.length ? <Empty>No students{q ? ' match your search' : ''}.</Empty> : (
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
    </Card>
  );
}

function SyncButton({ onSynced }: { onSynced: () => void }) {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get('/sync'), [], 15_000);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post('/sync');
      toast(`Synced ${r.students} students · ${r.groups} classes · ${r.subgroups} sections`);
      reload(); onSynced();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  if (data && !data.configured) return <Badge tone="amber">Frappe not configured</Badge>;
  return (
    <div className="flex items-center gap-3">
      {data?.last && <span className="text-xs text-slate-500">Last sync {fmtDate(data.last.started_at)} {data.last.ok === false && <span className="text-red-600">(failed)</span>}</span>}
      <button className="btn-secondary" disabled={busy || data?.running} onClick={run}>{busy || data?.running ? 'Syncing…' : 'Sync now'}</button>
    </div>
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
      <p className="mb-3 text-sm text-slate-500"><b className="text-red-600">{both}</b> cannot be reached at all.</p>
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

// ======================= Opt-outs =======================

function OptOuts() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.get<any[]>('/opt-outs'), []);
  const [phone, setPhone] = useState('');
  const add = async () => { try { await api.post('/opt-outs', { phone }); setPhone(''); reload(); } catch (e) { toast((e as Error).message, 'error'); } };
  const remove = async (p: string) => { if (confirm('Allow messages to this number again?')) { await api.del(`/opt-outs/${p}`); reload(); } };
  return (
    <Card title={`Opted out (${data?.length ?? 0})`} actions={<div className="flex gap-2"><input className="input w-56" placeholder="Add number manually" value={phone} onChange={(e) => setPhone(e.target.value)} /><button className="btn-secondary" disabled={!phone} onClick={add}>Add</button></div>}>
      <p className="mb-3 text-sm text-slate-500">People who replied <b>STOP</b> or <b>UNSUBSCRIBE</b>. They are skipped in every campaign, whichever list they are in.</p>
      {!data?.length ? <Empty>Nobody has opted out.</Empty> : (
        <table className="table"><thead><tr><th>Phone</th><th>How</th><th>When</th><th /></tr></thead>
          <tbody>{data.map((o) => <tr key={o.phone}><td>{fmtPhone(o.phone)}</td><td>{o.reason}</td><td className="text-xs text-slate-500">{fmtDate(o.created_at)}</td><td className="text-right"><button className="text-xs text-brand-700 hover:underline" onClick={() => remove(o.phone)}>Re-allow</button></td></tr>)}</tbody>
        </table>
      )}
    </Card>
  );
}
