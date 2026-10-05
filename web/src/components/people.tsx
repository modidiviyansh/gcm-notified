import { useState } from 'react';
import { api } from '../api';
import { maskPhone, Phone, WaMark } from './phone';
import { describeRule, MessageType, NumberRule, RuleEditor, useLabels, useMessageTypes } from './rules';
import { Badge, Field, Modal, useLoad, useToast } from './ui';

export interface PersonPhone { phone: string; label: string; is_primary: boolean; opted_out?: boolean; wa?: boolean | null }

/** A person's numbers, one per line: label, number (hidden), ★ primary, opted-out badge. */
export function PhoneList({ phones }: { phones: PersonPhone[] }) {
  if (!phones?.length) return <span className="text-xs text-red-500">no number</span>;
  return (
    <div className="space-y-0.5">
      {phones.map((p) => (
        <div key={p.phone} className="flex items-center gap-1.5 whitespace-nowrap">
          <span className={`w-16 shrink-0 truncate rounded px-1.5 py-px text-center text-[11px] ${p.is_primary && phones.length > 1 ? 'bg-brand-50 text-brand-800' : 'bg-slate-100 text-slate-600'}`}
            title={p.is_primary ? `${p.label} — primary number` : p.label}>{p.label}</span>
          <Phone value={p.phone} />
          <WaMark wa={p.wa} />
          {p.opted_out && <Badge tone="amber">opted out</Badge>}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

/** Edit one person: name, notes, labelled numbers (primary), lists, and exceptions to the list rules. */
export function PersonModal({ id, onClose, onSaved }: { id: number; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const types = useMessageTypes();
  const { all: labels } = useLabels();
  const { data: p, setData } = useLoad(() => api.get(`/people/${id}`), [id]);
  const [adding, setAdding] = useState({ phone: '', label: '' });
  const [showRules, setShowRules] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!p) return <Modal open title="Person" onClose={onClose}><p className="text-sm text-slate-500">Loading…</p></Modal>;

  const phones: PersonPhone[] = p.phones;
  const set = (patch: any) => setData((o: any) => ({ ...o, ...patch }));
  const setPhone = (i: number, patch: Partial<PersonPhone>) =>
    set({ phones: phones.map((x, j) => (j === i ? { ...x, ...patch } : patch.is_primary ? { ...x, is_primary: false } : x)) });
  const rules: Record<string, NumberRule> = p.rules ?? {};
  const setRule = (key: string, r: NumberRule | null) => { const n = { ...rules }; if (r) n[key] = r; else delete n[key]; set({ rules: n }); };
  const exceptions = Object.keys(rules).length;

  const addNumber = () => {
    if (!adding.phone.trim()) return;
    set({ phones: [...phones, { phone: adding.phone.trim(), label: adding.label.trim() || (phones.length ? `Mobile ${phones.length + 1}` : 'Mobile'), is_primary: !phones.length }] });
    setAdding({ phone: '', label: '' });
  };
  const save = async () => {
    setBusy(true);
    try {
      const pending = adding.phone.trim() ? [...phones, { phone: adding.phone.trim(), label: adding.label.trim() || 'Mobile', is_primary: !phones.length }] : phones;
      await api.put(`/people/${id}`, { name: p.name, notes: p.notes, phones: pending.map(({ phone, label, is_primary }) => ({ phone, label, is_primary })), rules });
      toast('Saved'); onSaved();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  return (
    <Modal open wide title={p.name || 'Person'} onClose={onClose}>
      <datalist id="phone-labels">{labels.map((l) => <option key={l} value={l} />)}</datalist>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="input" value={p.name ?? ''} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Notes (optional)"><input className="input" value={p.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. Transport in-charge" /></Field>
        </div>

        <div>
          <span className="label">Numbers</span>
          <div className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {phones.map((x, i) => (
              <div key={x.phone} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <input className="input w-32 py-1 text-sm" list="phone-labels" value={x.label} onChange={(e) => setPhone(i, { label: e.target.value })} aria-label="Label" />
                <span className="min-w-0 flex-1"><Phone value={x.phone} /> {x.opted_out && <Badge tone="amber">opted out</Badge>}</span>
                <label className="flex items-center gap-1 text-xs text-slate-600"><input type="radio" name="primary" checked={x.is_primary} onChange={() => setPhone(i, { is_primary: true })} />Primary</label>
                <button className="text-xs text-red-600 hover:underline disabled:opacity-40" disabled={phones.length === 1}
                  title={phones.length === 1 ? 'A person needs at least one number' : 'Remove this number'}
                  onClick={() => set({ phones: phones.filter((_, j) => j !== i).map((y, j, arr) => (x.is_primary && j === 0 && !arr.some((z) => z.is_primary) ? { ...y, is_primary: true } : y)) })}>Remove</button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2 bg-slate-50/60 px-3 py-2">
              <input className="input w-32 py-1 text-sm" list="phone-labels" placeholder="Label" value={adding.label} onChange={(e) => setAdding({ ...adding, label: e.target.value })} />
              <input className="input min-w-40 flex-1 py-1 text-sm" placeholder="Add a number, e.g. 98765 43210" value={adding.phone}
                onChange={(e) => setAdding({ ...adding, phone: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && addNumber()} />
              <button className="btn-secondary py-1" disabled={!adding.phone.trim()} onClick={addNumber}>Add</button>
            </div>
          </div>
          <p className="mt-1 text-xs text-slate-500">Labels say what a number is for — <i>Personal</i>, <i>Work</i>, <i>Home</i> or anything you like. List rules use them to pick the right number per message type.</p>
        </div>

        <div>
          <span className="label">In lists</span>
          <div className="flex flex-wrap gap-1">{p.lists.map((l: any) => <Badge key={l.id}>{l.parent_name ? `${l.parent_name} › ` : ''}{l.name}</Badge>)}</div>
        </div>

        <div className="rounded-lg border border-slate-200">
          <button className="flex w-full items-center justify-between px-3 py-2 text-left text-sm" onClick={() => setShowRules(!showRules)}>
            <span><b>Exceptions for this person</b> <span className="text-slate-500">— only if they differ from the list rules</span></span>
            <span className="text-xs text-slate-500">{exceptions ? `${exceptions} set` : 'none'} {showRules ? '▴' : '▾'}</span>
          </button>
          {showRules && (
            <div className="space-y-3 border-t border-slate-100 p-3">
              <RuleRow icon="✳️" name="Every message type" value={rules['*'] ?? null} labels={phones.map((x) => x.label)} defaultLabel="Follow the list rules" onChange={(r) => setRule('*', r)} />
              {types?.map((t) => (
                <RuleRow key={t.key} icon={t.icon} name={t.name} value={rules[t.key] ?? null} labels={phones.map((x) => x.label)}
                  defaultLabel={rules['*'] ? `Same as “every message type” (${describeRule(rules['*'])})` : 'Follow the list rules'} onChange={(r) => setRule(t.key, r)} />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></div>
    </Modal>
  );
}

function RuleRow({ icon, name, value, labels, defaultLabel, onChange }: { icon: string; name: string; value: NumberRule | null; labels: string[]; defaultLabel: string; onChange: (r: NumberRule | null) => void }) {
  return (
    <div className="grid items-start gap-2 sm:grid-cols-[180px_1fr]">
      <span className="pt-1.5 text-sm"><span className="mr-1.5">{icon}</span>{name}</span>
      <RuleEditor compact value={value} onChange={onChange} labels={labels} defaultLabel={defaultLabel} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

/** Per message type: which label people in this list get it on. Sublists inherit their parent's rules. */
export function ListRulesModal({ group, parentRules, onClose, onSaved }: {
  group: { id: number; name: string; rules?: Record<string, NumberRule> }; parentRules?: Record<string, NumberRule> | null; onClose: () => void; onSaved: () => void;
}) {
  const toast = useToast();
  const types = useMessageTypes();
  const { all: labels, used } = useLabels(group.id);
  const [rules, setRules] = useState<Record<string, NumberRule>>(group.rules ?? {});
  const save = async () => {
    try { await api.put(`/groups/${group.id}/rules`, { rules }); toast('Number rules saved'); onSaved(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const defaultFor = (t: MessageType) => parentRules?.[t.key] ? `Same as the parent list (${describeRule(parentRules[t.key])})` : `Message type default (${describeRule(t.rule)})`;
  return (
    <Modal open wide title={`Number rules — ${group.name}`} onClose={onClose}>
      <p className="mb-4 text-sm text-slate-500">
        When people here have more than one number, choose which one each kind of message goes to. Labels in this list:{' '}
        {used.length ? used.map((l) => <Badge key={l}>{l}</Badge>) : <i>none yet</i>}. A person can still have their own exception.
      </p>
      <div className="space-y-3">
        {types?.map((t) => (
          <RuleRow key={t.key} icon={t.icon} name={t.name} value={rules[t.key] ?? null} labels={labels} defaultLabel={defaultFor(t)}
            onChange={(r) => setRules((o) => { const n = { ...o }; if (r) n[t.key] = r; else delete n[t.key]; return n; })} />
        ))}
      </div>
      <div className="mt-5 flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={save}>Save rules</button></div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------

interface CsvPreview { rows: number; columns: string[]; sample: Record<string, string>[]; nameColumn: string | null; phoneColumns: { column: string; label: string }[] }

/** CSV import with a mapping step: pick the name column and label each phone column. */
export function CsvImport({ groupId, onDone }: { groupId: number; onDone: (r: any) => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [pv, setPv] = useState<CsvPreview | null>(null);
  const [nameColumn, setNameColumn] = useState<string | null>(null);
  const [phoneCols, setPhoneCols] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const pick = async (f?: File) => {
    if (!f) return;
    setBusy(true);
    try {
      const r = await api.upload<CsvPreview>(`/groups/${groupId}/import/preview`, f);
      setFile(f); setPv(r); setNameColumn(r.nameColumn);
      setPhoneCols(Object.fromEntries(r.phoneColumns.map((p) => [p.column, p.label])));
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const mapping = { nameColumn, phoneColumns: Object.entries(phoneCols).map(([column, label]) => ({ column, label })) };
      onDone(await api.upload(`/groups/${groupId}/import`, file, { mapping: JSON.stringify(mapping) }));
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  if (!pv) {
    return (
      <div>
        <p className="mb-3 text-sm text-slate-600">First row = column names. Any number of phone columns (Phone, Work Phone, Mobile 2…) — you label them in the next step. Every other column is saved with the person for this list and usable in messages, e.g. <code>Route</code> → <code>{'{{route}}'}</code>.</p>
        <label className="block cursor-pointer rounded-lg border-2 border-dashed border-slate-300 p-8 text-center hover:border-brand-600 hover:bg-brand-50">
          <span className="text-sm font-medium text-brand-800">{busy ? 'Reading…' : 'Choose an Excel or CSV file'}</span>
          <span className="mt-1 block text-xs text-slate-500">.xlsx straight from Excel, or CSV (Google Sheets: File → Download)</span>
          <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" disabled={busy} onChange={(e) => pick(e.target.files?.[0])} />
        </label>
        <button className="mt-2 text-xs text-brand-700 hover:underline" onClick={() => {
          const blob = new Blob(['Name,Personal Phone,Work Phone,Department\nRamesh Kumar,9876543210,9811122233,Transport\n'], { type: 'text/csv' });
          const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'contacts-template.csv'; a.click();
        }}>Download a sample CSV</button>
      </div>
    );
  }

  const phoneCount = Object.keys(phoneCols).length;
  const cell = (col: string, v: string) => (phoneCols[col] !== undefined && v ? maskPhone(v) : v);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span><b>{file?.name}</b> · {pv.rows} rows</span>
        <button className="text-xs text-brand-700 hover:underline" onClick={() => { setPv(null); setFile(null); }}>Choose another file</button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="table text-xs">
          <thead>
            <tr>{pv.columns.map((c) => <th key={c} className="whitespace-nowrap">{c}</th>)}</tr>
            <tr className="bg-slate-50">
              {pv.columns.map((c) => {
                const role = c === nameColumn ? 'name' : phoneCols[c] !== undefined ? 'phone' : 'column';
                return (
                  <th key={c} className="min-w-36 align-top font-normal normal-case">
                    <select className="input py-1 text-xs" value={role} onChange={(e) => {
                      const v = e.target.value;
                      const next = { ...phoneCols };
                      if (v === 'phone') next[c] = pv.phoneColumns.find((p) => p.column === c)?.label ?? c; else delete next[c];
                      setPhoneCols(next);
                      if (v === 'name') setNameColumn(c); else if (nameColumn === c) setNameColumn(null);
                    }}>
                      <option value="column">List column</option>
                      <option value="name">Name</option>
                      <option value="phone">Phone number</option>
                    </select>
                    {role === 'phone' && (
                      <input className="input mt-1 py-1 text-xs" list="phone-labels" value={phoneCols[c]} placeholder="Label" aria-label={`Label for ${c}`}
                        onChange={(e) => setPhoneCols({ ...phoneCols, [c]: e.target.value })} />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>{pv.sample.map((r, i) => <tr key={i}>{pv.columns.map((c) => <td key={c} className="whitespace-nowrap">{cell(c, r[c])}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <datalist id="phone-labels">{['Mobile', 'Personal', 'Work', 'Home', 'Mobile 2', 'WhatsApp'].map((l) => <option key={l} value={l} />)}</datalist>
      <p className="text-xs text-slate-500">
        {phoneCount ? <>Each row becomes one person with <b>{phoneCount}</b> labelled number{phoneCount > 1 ? 's' : ''} — the first filled one is primary. </> : <span className="text-red-600">Mark at least one column as a phone number. </span>}
        Numbers already in your contacts join that existing person.
      </p>
      <div className="flex justify-end"><button className="btn-primary" disabled={busy || !phoneCount} onClick={run}>{busy ? 'Importing…' : `Import ${pv.rows} rows`}</button></div>
    </div>
  );
}
