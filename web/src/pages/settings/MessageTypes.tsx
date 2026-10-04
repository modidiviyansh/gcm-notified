import { Badge, Card, Field } from '../../components/ui';
import { MessageType, RuleEditor, SCHOOL_LABEL, useLabels } from '../../components/rules';

const SPEEDS = { urgent: 'Urgent 🔴', normal: 'Normal 🟡', safe: 'Safe 🟢' } as const;

export function MessageTypes({ types, onChange }: { types: MessageType[]; onChange: (t: MessageType[]) => void }) {
  const { all: labels } = useLabels();
  const set = (i: number, patch: Partial<MessageType>) => onChange(types.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const add = () => onChange([...types, { key: '', name: 'New type', icon: '✉️', rule: { use: 'primary' }, school: 'primary', speed: 'normal', quietHours: true, overrideOptOut: false }]);
  return (
    <Card title="Message types" actions={<button className="btn-secondary" onClick={add}>+ Add type</button>}>
      <p className="mb-3 text-sm text-slate-500">
        Every campaign starts by choosing what the message is for. The type decides which number people get it on (lists and people can override this),
        which parent for school classes, the speed and quiet hours. Save settings to apply.
      </p>
      <div className="space-y-3">
        {types.map((t, i) => (
          <div key={t.key || i} className={`rounded-lg border p-3 ${t.overrideOptOut ? 'border-red-200 bg-red-50/40' : 'border-slate-200'}`}>
            <div className="flex flex-wrap items-center gap-2">
              <input className="input w-14 text-center" value={t.icon} onChange={(e) => set(i, { icon: e.target.value })} aria-label="Icon" />
              <input className="input w-56 font-medium" value={t.name} onChange={(e) => set(i, { name: e.target.value })} aria-label="Name" />
              <span className="flex-1" />
              <button className="text-xs text-red-600 hover:underline disabled:opacity-40" disabled={types.length === 1}
                onClick={() => confirm(`Remove "${t.name}"? Lists and people keep their rules for it, but new campaigns can't use it.`) && onChange(types.filter((_, j) => j !== i))}>Remove</button>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-[1.4fr_1fr_1fr]">
              <Field label="Your lists — send to"><RuleEditor compact value={t.rule} onChange={(r) => set(i, { rule: r ?? { use: 'primary' } })} labels={labels} /></Field>
              <Field label="School classes — send to">
                <select className="input py-1.5 text-sm" value={t.school} onChange={(e) => set(i, { school: e.target.value as MessageType['school'] })}>
                  {Object.entries(SCHOOL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
              <Field label="Speed">
                <select className="input py-1.5 text-sm" value={t.speed} onChange={(e) => set(i, { speed: e.target.value as MessageType['speed'] })}>
                  {Object.entries(SPEEDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <label className="flex items-center gap-2"><input type="checkbox" checked={t.quietHours} onChange={(e) => set(i, { quietHours: e.target.checked })} />Respect quiet hours</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={t.overrideOptOut} onChange={(e) => set(i, { overrideOptOut: e.target.checked })} />
                Also send to people who replied STOP {t.overrideOptOut && <Badge tone="red">emergencies only</Badge>}</label>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
