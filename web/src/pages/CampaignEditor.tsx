import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDuration } from '../api';
import { Badge, Card, Empty, ErrorNote, Field, Modal, PageHeader, statusLabel, Toggle, useLoad, useToast } from '../components/ui';
import type { GroupNode } from './Contacts';

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
    if (!confirm(`Start sending to ${preview.recipients - preview.optedOut} recipients now?`)) return;
    setBusy(true);
    try { await api.post(`/campaigns/${id}/launch`); toast('Campaign started'); nav(`/campaigns/${id}`); } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };

  if (error) return <ErrorNote error={error} />;
  if (!c || !settings) return <p className="text-sm text-slate-500">Loading…</p>;
  const isGroups = c.kind === 'wa_groups';

  return (
    <>
      <PageHeader title={c.name} subtitle={<><Link to="/campaigns" className="text-brand-700 hover:underline">Campaigns</Link> / draft · {isGroups ? 'WhatsApp groups' : 'Parents & contacts'}</>}
        actions={<button className="btn-ghost text-red-600" onClick={async () => { if (confirm('Delete this draft?')) { await api.del(`/campaigns/${id}`); nav('/campaigns'); } }}>Delete draft</button>} />

      <div className="space-y-5">
        <Step n={1} title="Name">
          <input className="input max-w-md" value={c.name} onChange={(e) => patch({ name: e.target.value })} />
        </Step>

        <Step n={2} title={isGroups ? 'Choose WhatsApp groups' : 'Who receives it'}>
          {isGroups ? <WaGroupsPicker c={c} numbers={numbers ?? []} onChange={(waGroups) => patch({ audience: { waGroups } })} />
            : <Audience c={c} primary={settings.primaryParent} onPatch={patch} onCsv={(info) => setData((o: any) => ({ ...o, audience: { ...o.audience, csv: info } }))} />}
        </Step>

        <Step n={3} title="Message">
          <MessageEditor c={c} onPatch={patch} isGroups={isGroups} />
        </Step>

        <Step n={4} title="Sending">
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

        <Step n={5} title="Review & launch">
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={loadPreview} disabled={busy}>{busy ? 'Checking…' : preview ? 'Refresh preview' : 'Preview messages'}</button>
            {preview && <TestSend id={c.id} numbers={(numbers ?? []).filter((n) => n.status === 'WORKING')} />}
            <button className="btn-primary" onClick={launch} disabled={busy || !preview || !(preview.recipients - preview.optedOut)}>Launch campaign</button>
          </div>
          {preview && <Preview p={preview} />}
        </Step>
      </div>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <Card title={<span className="flex items-center gap-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-brand-700 text-xs text-white">{n}</span>{title}</span>}>{children}</Card>
  );
}

function Audience({ c, primary, onPatch, onCsv }: { c: any; primary: string; onPatch: (p: any, i?: boolean) => void; onCsv: (info: any) => void }) {
  const toast = useToast();
  const { data: tree } = useLoad(() => api.get<GroupNode[]>('/groups'), []);
  const [csvReport, setCsvReport] = useState<any>(null);
  const ids: number[] = c.audience.groupIds ?? [];
  const csv = c.audience.csv;

  const toggle = (g: GroupNode) => {
    let next: number[];
    const parent = g.parent_id ? tree?.find((t) => t.id === g.parent_id) : undefined;
    if (!parent) {
      // Whole class / group: selecting it replaces any individually ticked sections
      const childIds = g.children.map((x) => x.id);
      next = ids.includes(g.id) ? ids.filter((x) => x !== g.id) : [...ids.filter((x) => !childIds.includes(x)), g.id];
    } else if (ids.includes(parent.id)) {
      // Unticking one section of a fully selected class → keep its other sections
      next = [...ids.filter((x) => x !== parent.id), ...parent.children.map((x) => x.id).filter((x) => x !== g.id)];
    } else if (ids.includes(g.id)) {
      next = ids.filter((x) => x !== g.id);
    } else {
      next = [...ids, g.id];
      // All sections ticked → store the class instead
      if (parent.children.every((x) => next.includes(x.id))) next = [...next.filter((x) => !parent.children.some((c) => c.id === x)), parent.id];
    }
    onPatch({ audience: { groupIds: next } }, true);
  };
  const upload = async (f?: File) => {
    if (!f) return;
    try { const r = await api.upload(`/campaigns/${c.id}/csv`, f); setCsvReport(r); onCsv(r); toast(`CSV: ${r.matched} of ${r.rows} rows matched`); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const clearCsv = async () => { await api.del(`/campaigns/${c.id}/csv`); setCsvReport(null); onCsv(null); };

  return (
    <div className="space-y-5">
      <div className="grid gap-5 md:grid-cols-2">
        <div className={csv ? 'pointer-events-none opacity-40' : ''}>
          <span className="label">Classes, sections & groups {csv && '(CSV is used instead)'}</span>
          <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 p-2">
            {tree?.map((g) => (
              <div key={g.id}>
                <label className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
                  <input type="checkbox" checked={ids.includes(g.id)} onChange={() => toggle(g)} />
                  <span className="font-medium">{g.name}</span><span className="text-xs text-slate-400">{g.total}</span>
                  {g.source === 'manual' && <Badge>my group</Badge>}
                </label>
                {g.children.length > 0 && (
                  <div className="ml-6 flex flex-wrap gap-x-3">
                    {g.children.map((s) => (
                      <label key={s.id} className="flex items-center gap-1.5 py-0.5 text-xs text-slate-600">
                        <input type="checkbox" checked={ids.includes(g.id) || ids.includes(s.id)} onChange={() => toggle(s)} />{s.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {!tree?.length && <p className="p-2 text-sm text-slate-500">No groups yet — sync from Frappe on the Contacts page.</p>}
          </div>
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

      {(ids.length > 0 || csv?.keyType === 'admission') && (
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Send to" hint={c.recipient_mode === 'primary' ? `Primary = ${primary}, falling back to the other parent if missing. Change in Settings.` : undefined}>
            <select className="input" value={c.recipient_mode} onChange={(e) => onPatch({ recipient_mode: e.target.value }, true)}>
              <option value="primary">Primary parent (one per student)</option>
              <option value="father">Father</option>
              <option value="mother">Mother</option>
              <option value="both">Both parents</option>
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

function WaGroupsPicker({ c, numbers, onChange }: { c: any; numbers: any[]; onChange: (g: any[]) => void }) {
  const toast = useToast();
  const working = numbers.filter((n) => n.status === 'WORKING');
  const [numberId, setNumberId] = useState<number | null>(null);
  const nid = numberId ?? working[0]?.id ?? null;
  const { data: groups, setData } = useLoad(() => (nid ? api.get<any[]>(`/numbers/${nid}/groups`) : Promise.resolve([])), [nid]);
  const [q, setQ] = useState('');
  const selected: any[] = c.audience.waGroups ?? [];
  const isOn = (chatId: string) => selected.some((g) => g.chatId === chatId && g.numberId === nid);
  const toggle = (g: any) => onChange(isOn(g.chat_id) ? selected.filter((x) => !(x.chatId === g.chat_id && x.numberId === nid)) : [...selected, { numberId: nid, chatId: g.chat_id, subject: g.subject }]);
  const refresh = async () => { try { setData(await api.post(`/numbers/${nid}/groups/refresh`)); } catch (e) { toast((e as Error).message, 'error'); } };
  const shown = (groups ?? []).filter((g) => g.subject?.toLowerCase().includes(q.toLowerCase()));
  if (!working.length) return <Empty>No connected numbers. Connect a number first.</Empty>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <div className="mb-2 flex gap-2">
          <select className="input" value={nid ?? ''} onChange={(e) => setNumberId(Number(e.target.value))}>
            {working.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </select>
          <button className="btn-secondary whitespace-nowrap" onClick={refresh}>Refresh groups</button>
        </div>
        <input className="input mb-2" placeholder="Search groups" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="max-h-72 overflow-y-auto rounded-lg border border-slate-200 p-2">
          {shown.map((g) => (
            <label key={g.chat_id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
              <input type="checkbox" checked={isOn(g.chat_id)} onChange={() => toggle(g)} />{g.subject}<span className="text-xs text-slate-400">{g.participants ?? ''}</span>
            </label>
          ))}
          {!shown.length && <p className="p-2 text-sm text-slate-500">No groups — click Refresh groups.</p>}
        </div>
      </div>
      <div>
        <span className="label">Selected ({selected.length})</span>
        <ul className="space-y-1 text-sm">
          {selected.map((g) => (
            <li key={g.numberId + g.chatId} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1">
              <span>{g.subject} <span className="text-xs text-slate-500">via {numbers.find((n) => n.id === g.numberId)?.label}</span></span>
              <button className="text-xs text-red-600" onClick={() => onChange(selected.filter((x) => x !== g))}>✕</button>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">Each group is posted from the number you picked it under (it must be a member). Variable available: <code>{'{{group_name}}'}</code>.</p>
      </div>
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
  const sendable = p.recipients - p.optedOut;
  const riskTone = e.risk === 'high' ? 'red' : e.risk === 'medium' ? 'amber' : 'green';
  return (
    <div className="mt-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Messages</div><div className="text-xl font-semibold">{sendable}</div>
          <div className="text-xs text-slate-500">{p.students ? `${p.students} students` : ''}{p.contacts ? ` ${p.contacts} contacts` : ''}</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Skipped</div><div className="text-xl font-semibold">{p.optedOut + p.noNumber}</div>
          <div className="text-xs text-slate-500">{p.optedOut} opted out · {p.noNumber} no number</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Estimated time</div><div className="text-xl font-semibold">{fmtDuration(e.minutesToday)}</div>
          <div className="text-xs text-slate-500">{e.numbers} number{e.numbers > 1 ? 's' : ''} · ~{e.perNumberPerHour}/h each</div></div>
        <div className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500">Ban risk</div><div className="mt-1"><Badge tone={riskTone}>{e.risk}</Badge></div>
          <div className="mt-1 text-xs text-slate-500">based on speed</div></div>
      </div>
      {e.overflow > 0 && <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Today's remaining capacity is {e.capToday}. The other <b>{e.overflow}</b> messages continue automatically tomorrow when daily caps reset — or add more numbers.</div>}
      {p.numbers.some((n: any) => n.status !== 'WORKING' || n.paused) && <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Some selected numbers are not connected or are paused — they won't send until they are back.</div>}
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

