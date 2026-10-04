import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, fmtDuration } from '../api';
import { Badge, Card, Empty, ErrorNote, Field, Modal, MsOption, MultiSelect, PageHeader, statusLabel, Toggle, useLoad, useToast } from '../components/ui';
import type { GroupNode } from './Contacts';
import { describeRule, MessageType, RuleEditor, SCHOOL_LABEL, useLabels } from '../components/rules';

const STUDENT_VARS = ['student_name', 'first_name', 'admission_no', 'class', 'section', 'parent_name', 'father_name', 'mother_name', 'relation', 'child_count'];
const PRESET_LABEL = { urgent: 'Urgent', normal: 'Normal', safe: 'Safe' } as const;

export default function CampaignEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data: c, error, setData } = useLoad(() => api.get(`/campaigns/${id}`), [id]);
  const { data: settings } = useLoad(() => api.get('/settings'), []);
  const { data: numbers } = useLoad(() => api.get<any[]>('/numbers'), []);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => { if (c && c.status !== 'draft') nav(`/campaigns/${c.id}`, { replace: true }); }, [c?.status]);

  const patch = (p: Record<string, unknown>, immediate = false) => {
    setData((o: any) => ({ ...o, ...p, audience: p.audience ? { ...o.audience, ...(p.audience as object) } : o.audience }));
    window.clearTimeout(saveTimer.current);
    const run = async () => {
      try { await api.put(`/campaigns/${id}`, p); setPreview(null); } catch (e) { toast((e as Error).message, 'error'); }
    };
    if (immediate) return run();
    saveTimer.current = window.setTimeout(run, 600);
  };

  const loadPreview = async () => {
    window.clearTimeout(saveTimer.current);
    await api.put(`/campaigns/${id}`, { body: c.body, name: c.name });
    setBusy(true);
    try { setPreview(await api.get(`/campaigns/${id}/preview`)); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  const launch = async () => {
    if (!preview) return;
    const overriding = preview.overrideOptOut && preview.optedOut > 0;
    if (overriding && !confirm(`🚨 ${preview.optedOut} of these people replied STOP.\n\nThis is an emergency message type, so it WILL be sent to them too. This is logged in Activity.\n\nContinue?`)) return;
    if (!confirm(`Start sending to ${sendableOf(preview)} recipients now?`)) return;
    setBusy(true);
    try { await api.post(`/campaigns/${id}/launch`, { confirmOptOutOverride: overriding }); toast('Campaign started'); nav(`/campaigns/${id}`); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const chooseType = async (key: string) => {
    window.clearTimeout(saveTimer.current);
    try { setData(await api.put(`/campaigns/${id}`, { message_type: key })); setPreview(null); } catch (e) { toast((e as Error).message, 'error'); }
  };

  if (error) return <ErrorNote error={error} />;
  if (!c || !settings) return <p className="text-sm text-slate-500">Loading…</p>;
  const isGroups = c.kind === 'wa_groups';
  const types: MessageType[] = settings.messageTypes ?? [];
  const type = types.find((t) => t.key === c.message_type) ?? null;
  let step = 1;

  return (
    <>
      <PageHeader title={c.name} subtitle={<><Link to="/campaigns" className="text-brand-700 hover:underline">Campaigns</Link> / draft · {isGroups ? 'WhatsApp groups & channels' : 'Contacts'}</>}
        actions={<button className="btn-ghost text-red-600" onClick={async () => { if (confirm('Delete this draft?')) { await api.del(`/campaigns/${id}`); nav('/campaigns'); } }}>Delete draft</button>} />

      <div className="space-y-5">
        <Step n={step++} title="Name">
          <input className="input max-w-md" value={c.name} onChange={(e) => patch({ name: e.target.value })} />
        </Step>

        {!isGroups && (
          <Step n={step++} title="What is this message?">
            <TypePicker types={types} value={c.message_type} onChange={chooseType} />
          </Step>
        )}

        <Step n={step++} title={isGroups ? 'Choose WhatsApp groups & channels' : 'Who receives it'}>
          {isGroups ? <WaGroupsPicker c={c} numbers={numbers ?? []} onChange={(waGroups) => patch({ audience: { waGroups } })} />
            : <Audience c={c} type={type} primary={settings.primaryParent} onPatch={patch} onCsv={(info) => setData((o: any) => ({ ...o, audience: { ...o.audience, csv: info } }))} />}
        </Step>

        <Step n={step++} title="Message">
          <MessageEditor c={c} onPatch={patch} isGroups={isGroups} />
        </Step>

        <Step n={step++} title="Sending">
          {!isGroups && (
            <div className="mb-4">
              <span className="label">Send from</span>
              <div className="flex flex-wrap gap-2">
                {numbers?.map((n) => {
                  const on = c.number_ids.includes(n.id);
                  return (
                    <button key={n.id} onClick={() => patch({ number_ids: on ? c.number_ids.filter((x: number) => x !== n.id) : [...c.number_ids, n.id] }, true)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm ${on ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-100' : 'border-slate-200 hover:bg-slate-50'}`}>
                      <div className="font-medium">{on ? '☑' : '☐'} {n.label}</div>
                      <div className="text-xs text-slate-500">{n.paused ? 'paused' : statusLabel(n.status)} · {n.remaining_today} left today</div>
                    </button>
                  );
                })}
                {!numbers?.length && <Empty>No numbers. <Link to="/numbers" className="underline">Add one first</Link>.</Empty>}
              </div>
              {c.number_ids.length > 1 && <p className="mt-2 text-xs text-slate-500">Messages are shared out between the selected numbers automatically (rotation by free capacity).</p>}
            </div>
          )}
          <Speed c={c} presets={settings.speedPresets} onPatch={patch} quiet={settings.quietHours} />
        </Step>

        <Step n={step++} title="Review & launch">
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={loadPreview} disabled={busy}>{busy ? 'Checking…' : preview ? 'Refresh preview' : 'Preview messages'}</button>
            {preview && <TestSend id={c.id} numbers={(numbers ?? []).filter((n) => n.status === 'WORKING')} />}
            <button className="btn-primary" onClick={launch} disabled={busy || !preview || !sendableOf(preview)}>Launch campaign</button>
          </div>
          {preview && <Preview p={preview} />}
        </Step>
      </div>
    </>
  );
}

const sendableOf = (p: any) => p.recipients - (p.overrideOptOut ? 0 : p.optedOut) - (p.notAdmin?.length ?? 0);

function TypePicker({ types, value, onChange }: { types: MessageType[]; value: string | null; onChange: (key: string) => void }) {
  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {types.map((t) => {
          const on = t.key === value;
          return (
            <button key={t.key} onClick={() => !on && onChange(t.key)}
              className={`rounded-lg border px-3 py-2.5 text-left ${on ? (t.overrideOptOut ? 'border-red-500 bg-red-50 ring-2 ring-red-100' : 'border-brand-600 bg-brand-50 ring-2 ring-brand-100') : 'border-slate-200 hover:bg-slate-50'}`}>
              <div className="text-sm font-medium"><span className="mr-1.5">{t.icon}</span>{t.name}</div>
              <div className="mt-0.5 text-xs text-slate-500">
                {describeRule(t.rule)} · {SCHOOL_LABEL[t.school]} · {t.speed}{!t.quietHours ? ' · ignores quiet hours' : ''}
              </div>
              {t.overrideOptOut && <div className="mt-1 text-xs font-medium text-red-700">Also reaches people who replied STOP</div>}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-slate-500">This sets who gets it on which number, the speed and quiet hours below — you can still change them for this campaign. Edit types in <Link to="/settings" className="underline">Settings</Link>.</p>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Card title={<span className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-brand-700 text-xs text-white">{n}</span>{title}</span>}>{children}</Card>
  );
}

function Audience({ c, type, primary, onPatch, onCsv }: { c: any; type: MessageType | null; primary: string; onPatch: (p: any, i?: boolean) => void; onCsv: (info: any) => void }) {
  const toast = useToast();
  const { data: tree } = useLoad(() => api.get<GroupNode[]>('/groups'), []);
  const [csvReport, setCsvReport] = useState<any>(null);
  const ids: number[] = c.audience.groupIds ?? [];
  const csv = c.audience.csv;

  const setIds = (next: number[]) => onPatch({ audience: { groupIds: normaliseIds(next, tree ?? []) } }, true);
  const schoolPicked = ids.some((id) => (tree ?? []).some((g) => g.source === 'frappe' && (g.id === id || g.children.some((c) => c.id === id))));
  const listsPicked = !csv && ids.some((id) => (tree ?? []).some((g) => g.source === 'manual' && (g.id === id || g.children.some((c) => c.id === id))));
  const { all: labels } = useLabels();
  const upload = async (f?: File) => {
    if (!f) return;
    try { const r = await api.upload(`/campaigns/${c.id}/csv`, f); setCsvReport(r); onCsv(r); toast(`CSV: ${r.matched} of ${r.rows} rows matched`); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const clearCsv = async () => { await api.del(`/campaigns/${c.id}/csv`); setCsvReport(null); onCsv(null); };

  return (
    <div className="space-y-5">
      <div className="grid gap-5 md:grid-cols-2">
        <div className={csv ? 'pointer-events-none opacity-40' : ''}>
          <span className="label">Contact lists, classes & sections {csv && '(CSV is used instead)'}</span>
          <ListPicker tree={tree ?? []} ids={ids} onChange={setIds} />
          <p className="mt-1.5 text-xs text-slate-500">Pick any mix of your own lists and school classes or sections. A person in several lists gets the message once.</p>
        </div>
        <div>
          <span className="label">…or upload a CSV (marks, fee dues, custom lists)</span>
          {csv ? (
            <div className="rounded-lg border border-slate-200 p-3 text-sm">
              <div className="flex items-center justify-between"><b>{csv.filename}</b><button className="text-xs text-red-600 hover:underline" onClick={clearCsv}>Remove</button></div>
              <div className="mt-1 text-slate-600">Matched by <b>{csv.keyColumn}</b> ({csv.keyType === 'admission' ? 'admission no.' : 'phone'}): <b className="text-emerald-700">{csv.matched}</b> of {csv.rows} rows
                {csv.unmatched > 0 && <span className="text-red-600"> · {csv.unmatched} not matched</span>}</div>
              {csvReport?.unmatchedSamples?.length > 0 && <div className="mt-1 text-xs text-red-600">{csvReport.unmatchedSamples.slice(0, 5).join(' · ')}</div>}
              <div className="mt-2 flex flex-wrap gap-1">{csv.variables.map((v: string) => <code key={v} className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{`{{${v}}}`}</code>)}</div>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm">
              <input type="file" accept=".csv,text/csv" onChange={(e) => upload(e.target.files?.[0])} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-brand-800" />
              <p className="mt-2 text-xs text-slate-500">First row = headers. Include an <b>Admission No</b> column (or <b>Phone</b> for non-students). Every column becomes a variable, e.g. <code>Marks</code> → <code>{'{{marks}}'}</code>.</p>
              <button className="mt-2 text-xs text-brand-700 hover:underline" onClick={() => {
                const blob = new Blob(['Admission No,Subject,Test,Test Date,Marks,Max Marks\n10001,Maths,Unit Test 2,02-10-2026,42,50\n'], { type: 'text/csv' });
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'marks-template.csv'; a.click();
              }}>Download a sample marks CSV</button>
            </div>
          )}
        </div>
      </div>

      {listsPicked && (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Which number (your lists)" hint={c.number_rule ? 'Used for everyone in the chosen lists — list rules and personal exceptions are ignored for this campaign.' : 'Each person: their own exception → their list\'s rule → the message type default. Missing label → primary number.'}>
            <RuleEditor value={c.number_rule} onChange={(r) => onPatch({ number_rule: r }, true)} labels={labels}
              defaultLabel={`Follow list rules (default: ${describeRule(type?.rule)})`} />
          </Field>
        </div>
      )}

      {(schoolPicked || csv?.keyType === 'admission') && (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Send to" hint={c.recipient_mode === 'primary' ? `Primary = ${primary}, falling back to the other parent if missing. Change in Settings.` : undefined}>
            <select className="input" value={c.recipient_mode} onChange={(e) => onPatch({ recipient_mode: e.target.value }, true)}>
              <option value="primary">Primary parent (one per student)</option>
              <option value="father">Father</option>
              <option value="mother">Mother</option>
              <option value="both">Both parents</option>
              <option value="all">Both parents + student</option>
              <option value="student">Student's own number</option>
            </select>
          </Field>
          <div>
            <span className="label">Siblings (same parent number)</span>
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm"><input type="radio" checked={!c.per_child} onChange={() => onPatch({ per_child: false }, true)} className="mt-1" />
                <span><b>One message per parent</b> <span className="text-slate-500">— siblings merged ("Parent of Aarav & Diya"). Use <code>{'{{#each children}}'}</code> to list each child's details.</span></span></label>
              <label className="flex items-start gap-2 text-sm"><input type="radio" checked={c.per_child} onChange={() => onPatch({ per_child: true }, true)} className="mt-1" />
                <span><b>One message per child</b> <span className="text-slate-500">— separate messages, spaced 3 minutes apart.</span></span></label>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Ticking a class covers all its sections; ticking every section of a class stores the class instead. */
function normaliseIds(ids: number[], tree: GroupNode[]): number[] {
  let out = [...new Set(ids)];
  for (const root of tree) {
    const kids = root.children.map((c) => c.id);
    if (!kids.length) continue;
    if (out.includes(root.id)) out = out.filter((x) => !kids.includes(x));
    else if (kids.every((k) => out.includes(k))) out = [...out.filter((x) => !kids.includes(x)), root.id];
  }
  return out;
}

function ListPicker({ tree, ids, onChange }: { tree: GroupNode[]; ids: number[]; onChange: (ids: number[]) => void }) {
  const parentOf = new Map<number, GroupNode>();
  for (const r of tree) for (const c of r.children) parentOf.set(c.id, r);
  const byId = new Map<number, GroupNode>();
  for (const r of tree) { byId.set(r.id, r); for (const c of r.children) byId.set(c.id, c); }
  const roots = [...tree.filter((g) => g.source === 'manual'), ...tree.filter((g) => g.source !== 'manual')];
  const options: MsOption[] = roots.flatMap((r) => {
    const group = r.source === 'manual' ? 'My lists' : 'School — classes & sections';
    return [
      { value: String(r.id), label: r.name, group, hint: r.total ?? r.students + r.contacts },
      ...r.children.map((c) => ({ value: String(c.id), label: c.name, group, indent: true, hint: c.students + c.contacts, search: `${r.name} ${c.name}` })),
    ];
  });
  const checked = (id: number) => ids.includes(id) || (parentOf.has(id) && ids.includes(parentOf.get(id)!.id));
  const toggle = (o: MsOption) => {
    const id = Number(o.value);
    const parent = parentOf.get(id);
    if (!checked(id)) return onChange([...ids, id]);
    if (parent && ids.includes(parent.id)) {
      // Unticking one section of a fully selected class → keep its other sections
      return onChange([...ids.filter((x) => x !== parent.id), ...parent.children.map((c) => c.id).filter((x) => x !== id)]);
    }
    onChange(ids.filter((x) => x !== id));
  };
  const bulk = (shown: MsOption[], on: boolean) => {
    const shownIds = shown.map((o) => Number(o.value));
    if (on) return onChange([...ids, ...shownIds]);
    let next = [...ids];
    for (const id of shownIds) {
      const parent = parentOf.get(id);
      if (parent && next.includes(parent.id)) next = [...next.filter((x) => x !== parent.id), ...parent.children.map((c) => c.id)];
    }
    onChange(next.filter((x) => !shownIds.includes(x)));
  };
  const chips = ids.filter((id) => byId.has(id)).map((id) => {
    const p = parentOf.get(id);
    return { value: String(id), label: p ? `${p.name} › ${byId.get(id)!.name}` : byId.get(id)!.name };
  });
  return (
    <MultiSelect options={options} isChecked={(o) => checked(Number(o.value))} onToggle={toggle} onBulk={bulk}
      chips={chips} onRemoveChip={(v) => onChange(ids.filter((x) => x !== Number(v)))}
      placeholder="Choose lists, classes or sections…" emptyText={<>No lists yet — create one on the <Link to="/contacts" className="underline">Contacts</Link> page.</>} />
  );
}

interface WaTargetRow { chat_id: string; subject: string; participants: number | null; kind: 'group' | 'channel' | 'community'; announce: boolean; role: string | null; source: string; community: string | null; my_role: string | null; refreshed_at: string }

function WaGroupsPicker({ c, numbers, onChange }: { c: any; numbers: any[]; onChange: (g: any[]) => void }) {
  const toast = useToast();
  const working = numbers.filter((n) => n.status === 'WORKING');
  const [numberId, setNumberId] = useState<number | null>(null);
  const nid = numberId ?? working[0]?.id ?? null;
  const { data: rows, setData, loading } = useLoad(() => (nid ? api.get<WaTargetRow[]>(`/numbers/${nid}/groups`) : Promise.resolve([])), [nid]);
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const selected: { numberId: number; chatId: string; subject: string }[] = c.audience.waGroups ?? [];
  const mine = selected.filter((g) => g.numberId === nid);

  const refresh = async () => {
    setBusy(true); setWarning(null);
    try {
      const r = await api.post<{ items: WaTargetRow[]; warning: string | null }>(`/numbers/${nid}/groups/refresh`);
      setData(r.items); setWarning(r.warning);
      const k = (kind: string) => r.items.filter((x) => x.kind === kind).length;
      toast(`${k('group')} groups, ${k('community')} communities and ${k('channel')} channels loaded`);
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  if (!working.length) return <Empty>No connected numbers. Connect a number on the <Link to="/numbers" className="underline">Numbers</Link> page first.</Empty>;
  const list = rows ?? [];
  const countOf = (k: string) => list.filter((g) => g.kind === k).length;
  const notAdmin = (g: WaTargetRow) => g.announce && g.my_role !== null && !['admin', 'superadmin'].includes(g.my_role);
  const options: MsOption[] = list.map((g) => ({
    value: g.chat_id, label: g.subject, search: `${g.subject} ${g.community ?? ''}`,
    group: g.kind === 'channel' ? 'Channels you manage' : g.kind === 'community' ? 'Communities — announcement to all members' : 'Groups',
    hint: [g.community && g.kind === 'group' ? `in ${g.community}` : null, g.participants ? `${g.participants} ${g.kind === 'channel' ? 'followers' : 'members'}` : null].filter(Boolean).join(' · ') || undefined,
    badge: notAdmin(g) ? <Badge tone="red">not admin</Badge>
      : g.kind === 'channel' ? <Badge tone="violet">channel</Badge>
      : g.kind === 'community' ? <Badge tone="blue">community</Badge>
      : g.announce ? <Badge tone="amber">admins only</Badge> : undefined,
  }));
  const subjectOf = (chatId: string) => list.find((g) => g.chat_id === chatId)?.subject ?? chatId;
  const others = selected.filter((g) => g.numberId !== nid);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Post from number">
          <select className="input w-60" value={nid ?? ''} onChange={(e) => { setNumberId(Number(e.target.value)); setWarning(null); }}>
            {working.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </select>
        </Field>
        <button className="btn-secondary" disabled={busy} onClick={refresh}>{busy ? 'Loading from WhatsApp…' : list.length ? '↻ Refresh from WhatsApp' : 'Load groups & channels'}</button>
        {list.length > 0 && <span className="pb-2 text-xs text-slate-500">{countOf('group')} groups · {countOf('community')} communities · {countOf('channel')} channels · updated {fmtDate(list[0].refreshed_at)}</span>}
      </div>
      {(warning || list.some((g) => g.source === 'chats')) && (
        <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{warning ?? 'Showing groups from recent chats only — the full list could not be loaded last time.'}</div>
      )}
      <MultiSelect options={options} loading={loading}
        isChecked={(o) => mine.some((g) => g.chatId === o.value)}
        onToggle={(o) => onChange(mine.some((g) => g.chatId === o.value)
          ? selected.filter((g) => !(g.numberId === nid && g.chatId === o.value))
          : [...selected, { numberId: nid!, chatId: o.value, subject: o.label }])}
        onBulk={(shown, on) => {
          const vals = new Set(shown.map((o) => o.value));
          onChange(on
            ? [...selected, ...shown.filter((o) => !mine.some((g) => g.chatId === o.value)).map((o) => ({ numberId: nid!, chatId: o.value, subject: o.label }))]
            : selected.filter((g) => !(g.numberId === nid && vals.has(g.chatId))));
        }}
        chips={mine.map((g) => ({ value: g.chatId, label: `${g.chatId.endsWith('@newsletter') ? '📢 ' : list.find((x) => x.chat_id === g.chatId)?.kind === 'community' ? '🏘 ' : ''}${g.subject ?? subjectOf(g.chatId)}` }))}
        onRemoveChip={(v) => onChange(selected.filter((g) => !(g.numberId === nid && g.chatId === v)))}
        placeholder={list.length ? 'Choose groups, communities or channels…' : 'Click “Load groups & channels” first'}
        emptyText="No groups loaded yet." />
      {others.length > 0 && (
        <p className="text-xs text-slate-500">Also selected from other numbers: {others.map((g) => `${g.subject} (via ${numbers.find((n) => n.id === g.numberId)?.label ?? '?'})`).join(', ')}</p>
      )}
      <p className="text-xs text-slate-500">
        <b>{selected.length}</b> selected. Each group or channel is posted to from the number it was picked under. Posting to a <Badge tone="blue">community</Badge> reaches all its members; in communities and <Badge tone="amber">admins only</Badge> groups the number must be an admin — this is checked before launch. Variable: <code>{'{{group_name}}'}</code>.
      </p>
    </div>
  );
}

function MessageEditor({ c, onPatch, isGroups }: { c: any; onPatch: (p: any, i?: boolean) => void; isGroups: boolean }) {
  const toast = useToast();
  const ref = useRef<HTMLTextAreaElement>(null);
  const { data: templates, reload } = useLoad(() => api.get<any[]>('/templates'), []);
  const [media, setMedia] = useState<any>(null);
  useEffect(() => { if (c.media_id) api.get<any[]>('/media').then((l) => setMedia(l.find((m) => m.id === c.media_id) ?? null)); else setMedia(null); }, [c.media_id]);

  const vars = useMemo(() => {
    if (isGroups) return ['group_name'];
    const csvVars: string[] = c.audience.csv?.variables ?? [];
    if (c.audience.csv?.keyType === 'phone') return ['name', ...csvVars];
    return [...STUDENT_VARS, ...csvVars];
  }, [c.audience.csv, isGroups]);

  const insert = (text: string) => {
    const el = ref.current; if (!el) return;
    const s = el.selectionStart, e = el.selectionEnd;
    const body = c.body.slice(0, s) + text + c.body.slice(e);
    onPatch({ body });
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = s + text.length; });
  };
  const upload = async (f?: File) => {
    if (!f) return;
    try { const m = await api.upload('/media', f); onPatch({ media_id: m.id }, true); setMedia(m); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const saveTemplate = async () => {
    const name = prompt('Template name'); if (!name) return;
    await api.post('/templates', { name, body: c.body, media_id: c.media_id }); toast('Template saved'); reload();
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <select className="input w-auto" value="" onChange={(e) => { const t = templates?.find((x) => x.id === Number(e.target.value)); if (t) onPatch({ body: t.body, ...(t.media_id ? { media_id: t.media_id } : {}) }, true); }}>
            <option value="">Load a template…</option>
            {templates?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button className="btn-ghost" onClick={saveTemplate} disabled={!c.body.trim()}>Save as template</button>
        </div>
        <textarea ref={ref} className="input min-h-56 font-mono text-[13px] leading-relaxed" value={c.body} onChange={(e) => onPatch({ body: e.target.value })}
          placeholder={'{Dear|Respected} Parent of {{student_name}},\n\nThe school will remain closed on 20 Oct for Diwali.\n\nRegards,\nGCM Convent School'} />
        <div className="mt-1 text-xs text-slate-500">{c.body.length} characters · *bold* _italic_ ~strike~ · <code>{'{A|B|C}'}</code> picks one at random per message (makes every message slightly different)</div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {media ? (
            <span className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm">
              {media.mimetype.startsWith('image/') ? <img src={`/api/media/${media.id}`} alt="" className="h-10 w-10 rounded object-cover" /> : '📄'}
              {media.filename}<button className="text-xs text-red-600" onClick={() => onPatch({ media_id: null }, true)}>Remove</button>
            </span>
          ) : (
            <label className="btn-secondary cursor-pointer">📎 Attach image / PDF
              <input type="file" className="hidden" accept="image/jpeg,image/png,image/webp,application/pdf,video/mp4" onChange={(e) => upload(e.target.files?.[0])} />
            </label>
          )}
          {media && <span className="text-xs text-slate-500">The message text is sent as the caption.</span>}
        </div>
      </div>
      <div>
        <span className="label">Insert a variable</span>
        <div className="flex flex-wrap gap-1.5">
          {vars.map((v) => <button key={v} className="rounded-md bg-slate-100 px-2 py-1 font-mono text-xs hover:bg-brand-50" onClick={() => insert(`{{${v}}}`)}>{v}</button>)}
        </div>
        {!isGroups && c.audience.csv?.keyType !== 'phone' && (
          <>
            <span className="label mt-4">Siblings block</span>
            <button className="w-full rounded-md bg-slate-100 px-2 py-1.5 text-left font-mono text-xs hover:bg-brand-50"
              onClick={() => insert(`{{#each children}}• {{student_name}} ({{section}})${(c.audience.csv?.variables ?? []).includes('marks') ? ': {{subject}} {{marks}}/{{max_marks}}' : ''}\n{{/each}}`)}>
              {'{{#each children}} … {{/each}}'}
            </button>
            <p className="mt-1 text-xs text-slate-500">Repeats for each child of the parent — ideal for marks of siblings in one message.</p>
          </>
        )}
      </div>
    </div>
  );
}

function Speed({ c, presets, onPatch, quiet }: { c: any; presets: any; onPatch: (p: any, i?: boolean) => void; quiet: any }) {
  const apply = (k: keyof typeof PRESET_LABEL) => {
    const p = presets[k];
    onPatch({ delay_min_ms: p.delayMinMs, delay_max_ms: p.delayMaxMs, burst_min: p.burstMin, burst_max: p.burstMax, burst_pause_min_ms: p.burstPauseMinMs, burst_pause_max_ms: p.burstPauseMaxMs }, true);
  };
  const current = (Object.keys(PRESET_LABEL) as (keyof typeof PRESET_LABEL)[]).find((k) => presets[k].delayMinMs === c.delay_min_ms && presets[k].delayMaxMs === c.delay_max_ms && presets[k].burstMin === c.burst_min);
  const sec = (ms: number) => Math.round(ms / 100) / 10;
  const num = (k: string, v: string, mult = 1000) => onPatch({ [k]: Math.round(Number(v) * mult) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {(Object.keys(PRESET_LABEL) as (keyof typeof PRESET_LABEL)[]).map((k) => (
          <button key={k} onClick={() => apply(k)} className={`rounded-lg border px-3 py-2 text-left text-sm ${current === k ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-100' : 'border-slate-200 hover:bg-slate-50'}`}>
            <div className="font-medium">{PRESET_LABEL[k]} {k === 'urgent' ? '🔴' : k === 'normal' ? '🟡' : '🟢'}</div>
            <div className="text-xs text-slate-500">{sec(presets[k].delayMinMs)}–{sec(presets[k].delayMaxMs)} s</div>
          </button>
        ))}
        <span className={`self-center text-xs ${current ? 'text-slate-400' : 'font-medium text-brand-800'}`}>{current ? '' : 'Custom'}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Delay min (s)"><input className="input" type="number" min={0} step={0.5} value={sec(c.delay_min_ms)} onChange={(e) => num('delay_min_ms', e.target.value)} /></Field>
        <Field label="Delay max (s)"><input className="input" type="number" min={0} step={0.5} value={sec(c.delay_max_ms)} onChange={(e) => num('delay_max_ms', e.target.value)} /></Field>
        <Field label="Pause after every (msgs)"><div className="flex gap-1"><input className="input" type="number" min={0} value={c.burst_min} onChange={(e) => num('burst_min', e.target.value, 1)} /><input className="input" type="number" min={0} value={c.burst_max} onChange={(e) => num('burst_max', e.target.value, 1)} /></div></Field>
        <Field label="Pause length (s)"><div className="flex gap-1"><input className="input" type="number" min={0} value={sec(c.burst_pause_min_ms)} onChange={(e) => num('burst_pause_min_ms', e.target.value)} /><input className="input" type="number" min={0} value={sec(c.burst_pause_max_ms)} onChange={(e) => num('burst_pause_max_ms', e.target.value)} /></div></Field>
      </div>
      {c.delay_min_ms < 2000 && <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">⚠ Delays under 2 seconds look automated and raise the risk of the number being restricted. Use only for urgent notices to people who know your number.</div>}
      <div className="flex flex-wrap gap-6">
        <Toggle checked={c.typing} onChange={(x) => onPatch({ typing: x }, true)} label='Show "typing…" before each message' hint="1–4 s depending on message length" />
        <Toggle checked={c.respect_quiet_hours} onChange={(x) => onPatch({ respect_quiet_hours: x }, true)} label={`Respect quiet hours (${quiet.start}–${quiet.end})`} hint={quiet.enabled ? 'Sending pauses overnight and resumes in the morning' : 'Quiet hours are disabled in Settings'} />
      </div>
    </div>
  );
}

function Preview({ p }: { p: any }) {
  const e = p.estimate;
  const sendable = sendableOf(p);
  const riskTone = e.risk === 'high' ? 'red' : e.risk === 'medium' ? 'amber' : 'green';
  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Messages</div><div className="text-xl font-semibold">{sendable}</div>
          <div className="text-xs text-slate-500">{p.students ? `${p.students} students` : ''}{p.contacts ? ` ${p.contacts} contacts` : ''}</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Skipped</div><div className="text-xl font-semibold">{(p.overrideOptOut ? 0 : p.optedOut) + p.noNumber}</div>
          <div className="text-xs text-slate-500">{p.overrideOptOut ? 0 : p.optedOut} opted out · {p.noNumber} no number</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Estimated time</div><div className="text-xl font-semibold">{fmtDuration(e.minutesToday)}</div>
          <div className="text-xs text-slate-500">{e.numbers} number{e.numbers > 1 ? 's' : ''} · ~{e.perNumberPerHour}/h each</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Ban risk</div><div className="mt-1"><Badge tone={riskTone}>{e.risk}</Badge></div>
          <div className="mt-1 text-xs text-slate-500">based on speed</div></div>
      </div>
      {p.breakdown?.length > 0 && (
        <div className="text-sm"><span className="text-slate-500">Sent to: </span>
          {p.breakdown.map((b: any) => <span key={b.label + b.fallback} className="mr-1.5 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs">
            {b.label}{b.fallback && <span className="text-amber-700">(no match → primary)</span>} <b>{b.n}</b></span>)}
        </div>
      )}
      {p.overrideOptOut && p.optedOut > 0 && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">🚨 <b>{p.optedOut}</b> recipient{p.optedOut > 1 ? 's' : ''} replied STOP — this emergency message type sends to them anyway. You'll be asked to confirm, and it is logged.</div>}
      {e.overflow > 0 && <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Today's remaining capacity is {e.capToday}. The other <b>{e.overflow}</b> messages continue automatically tomorrow when daily caps reset — or add more numbers.</div>}
      {p.numbers.some((n: any) => n.status !== 'WORKING' || n.paused) && <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Some selected numbers are not connected or are paused — they won't send until they are back.</div>}
      {p.notAdmin?.length > 0 && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">Not an admin in <b>{p.notAdmin.length}</b> admins-only group{p.notAdmin.length > 1 ? 's' : ''}/communit{p.notAdmin.length > 1 ? 'ies' : 'y'} — {p.notAdmin.slice(0, 5).join(', ')}{p.notAdmin.length > 5 ? '…' : ''}. These are skipped.</div>}
      {p.csv?.unmatched > 0 && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{p.csv.unmatched} CSV rows did not match a student and will not be sent.</div>}
      <div>
        <span className="label">First {p.samples.length} messages</span>
        <div className="grid gap-3 md:grid-cols-2">
          {p.samples.map((s: any, i: number) => (
            <div key={i} className="rounded-lg border border-slate-200 bg-[#efeae2] p-3">
              <div className="mb-1 text-xs text-slate-600">To <b>{s.to}</b></div>
              <div className="whitespace-pre-wrap rounded-lg rounded-tl-none bg-white px-3 py-2 text-sm shadow-sm">{s.text || <i className="text-slate-400">(attachment only)</i>}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TestSend({ id, numbers }: { id: number; numbers: any[] }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [numberId, setNumberId] = useState<number | ''>(numbers[0]?.id ?? '');
  const send = async () => {
    try { await api.post(`/campaigns/${id}/test`, { phone, numberId }); toast('Test message queued — it arrives in a few seconds'); setOpen(false); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <>
      <button className="btn-secondary" onClick={() => setOpen(true)} disabled={!numbers.length}>Send test to my phone</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Send a test message">
        <p className="mb-3 text-sm text-slate-500">Sends the first recipient's version of the message to your own number.</p>
        <div className="space-y-3">
          <Field label="Your WhatsApp number"><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" /></Field>
          <Field label="Send from"><select className="input" value={numberId} onChange={(e) => setNumberId(Number(e.target.value))}>{numbers.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</select></Field>
        </div>
        <div className="mt-4 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button><button className="btn-primary" disabled={!phone || !numberId} onClick={send}>Send test</button></div>
      </Modal>
    </>
  );
}

