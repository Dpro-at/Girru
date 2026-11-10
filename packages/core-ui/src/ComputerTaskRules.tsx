import type React from 'react';
import {useEffect, useMemo, useState} from 'react';
import type {SessionClient} from './session';
import {UiIcon} from './ui-icons';
import type {UiIconName} from './ui-icons';

/**
 * CP6 Settings › Computers › Tasks from other computers: one rule for all projects, then only the
 * projects that differ (found with search, never a table of every project). CP4b: Allow a task
 * once, or always from that computer in that project.
 */
export type TaskRule = 'ask' | 'auto' | 'refuse';
export type Rules = {rule: TaskRule; projects: Record<string, TaskRule>; always: {source: string; projectId: string}[]; atOnce?: number; column?: string | null; takes?: boolean};
const CHOICES: ReadonlyArray<{key: TaskRule; title: string; note: string; icon: UiIconName; tint: string}> = [
  {key: 'ask', title: 'Ask me every time', note: 'A notice with Allow / Not now. Recommended.', icon: 'inbox', tint: '#9DBBFF'},
  {key: 'auto', title: 'Allow automatically', note: 'It starts at once, with this computer’s rules for agents.', icon: 'play', tint: '#8FD6B0'},
  {key: 'refuse', title: 'Don’t accept', note: 'Other computers can’t send tasks here.', icon: 'close', tint: '#F29BC0'},
];
export const taskRuleWords = (r: TaskRule) => CHOICES.find(c => c.key === r)!.title.replace(' every time', '');
const path = '/api/computers/task-rules';

export async function post(client: SessionClient, body: unknown): Promise<Rules> {
  const r = await client.request({method: 'POST', path, body});
  if (r.status !== 200) throw Error('rules_refused');
  return r.body as Rules;
}

export function ComputerTaskRules({client, deviceNames, part = 'all'}: {client: SessionClient; deviceNames: Record<string, string>; part?: 'all' | 'main' | 'advanced'}) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [projects, setProjects] = useState<{id: string; name: string}[]>([]);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [pick, setPick] = useState<{id: string; name: string} | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let live = true;
    void client.request({method: 'GET', path}).then(r => { if (live && r.status === 200) setRules(r.body as Rules); }).catch(() => {});
    void client.request({method: 'GET', path: '/api/computers/options'}).then(r => { if (live && r.status === 200) setProjects(((r.body as any)?.projects ?? []).map((p: any) => ({id: p.id, name: p.name ?? p.title ?? p.id}))); }).catch(() => {});
    return () => { live = false; };
  }, [client]);
  const change = (body: unknown) => void post(client, body).then(setRules).catch(() => setNotice('It could not be saved. Try again.'));
  const nameOf = (id: string) => projects.find(p => p.id === id)?.name ?? 'A project';
  const found = useMemo(() => { const q = query.trim().toLowerCase(); return q ? projects.filter(p => p.name.toLowerCase().includes(q) && !(rules?.projects[p.id])).slice(0, 8) : []; }, [query, projects, rules]);
  if (!rules) return <p role="status" className="fine-print">Reading…</p>;
  const exceptions = Object.entries(rules.projects);
  const main = part !== 'advanced', advanced = part !== 'main';
  return <div className="computer-task-rules">
    {main && <section className="cp-block"><b className="cp-h">Tasks from my other computers</b>
    <div role="radiogroup" aria-label="Tasks from my other computers" className="cp-choices">
      {CHOICES.map(c => <button key={c.key} type="button" role="radio" aria-checked={rules.rule === c.key} className={`cp-choice${rules.rule === c.key ? ' is-on' : ''}`} onClick={() => change({rule: c.key})}>
        <span className="cp-tile" style={{'--tint': c.tint} as React.CSSProperties}><UiIcon name={c.icon} size={18}/></span><span className="cp-choice-text"><span>{c.title}</span><small>{c.note}</small></span>
      </button>)}
    </div></section>}
    {advanced && <section className="cp-block"><span className="cp-h-row"><b className="cp-h">Except these projects</b><button type="button" className="cp-soft" onClick={() => { setAdding(true); setPick(null); setQuery(''); }}>Add a project…</button></span>
    {exceptions.length > 0 && <div className="cp-list" role="list">{exceptions.map(([id, r]) => <div key={id} className="cp-list-row" role="listitem">
      <UiIcon name="folder" size={14}/><span className="cp-grow">{nameOf(id)}</span>
      <select className={`cp-pill${r === 'auto' ? ' is-auto' : ''}`} aria-label={`Rule for ${nameOf(id)}`} value={r} onChange={e => change({project: {id, rule: e.target.value}})}>{CHOICES.map(c => <option key={c.key} value={c.key}>{taskRuleWords(c.key)}</option>)}</select>
      <button type="button" className="cp-x" title="Remove exception" aria-label={`Remove ${nameOf(id)}`} onClick={() => change({project: {id, rule: null}})}><UiIcon name="close" size={14}/></button>
    </div>)}</div>}
    <span className="cp-note">Only projects that differ are listed, even with 200 projects.</span></section>}
    {advanced && adding && <div className="computer-rule-add">
      <label className="phone-field"><span>Find a project</span><input autoFocus value={query} placeholder="Type a name" onChange={e => { setQuery(e.target.value); setPick(null); }}/></label>
      {!pick && query.trim() && <div className="phone-list" role="listbox" aria-label="Projects">{found.length ? found.map(p => <button key={p.id} type="button" role="option" aria-selected={false} className="phone-row" onClick={() => setPick(p)}><UiIcon name="folder" size={14}/><span className="phone-row-text"><b>{p.name}</b></span></button>) : <p className="fine-print">No project with that name.</p>}</div>}
      {pick && <p className="computer-rule-pick"><b>{pick.name}</b>: {CHOICES.map(c => <button key={c.key} type="button" onClick={() => { change({project: {id: pick.id, rule: c.key}}); setAdding(false); }}>{taskRuleWords(c.key)}</button>)}</p>}
      <button type="button" className="link-button" onClick={() => setAdding(false)}>Cancel</button>
    </div>}
    {advanced && rules.always.length > 0 && <><b className="cp-h">Always allowed</b><div className="phone-list" role="list">{rules.always.map(a => <div key={a.source + a.projectId} className="phone-row" role="listitem">
      <span className="phone-tile"><UiIcon name="check" size={15}/></span><span className="phone-row-text"><b>From {deviceNames[a.source] ?? 'another computer'}</b><small>{nameOf(a.projectId)}</small></span>
      <button type="button" className="tool" title="Stop allowing always" aria-label="Stop allowing always" onClick={() => change({always: {source: a.source, projectId: a.projectId, on: false}})}><UiIcon name="close" size={13}/></button>
    </div>)}</div></>}
    {advanced && <LandingColumn rules={rules} onChange={change}/>}
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </div>;
}

/** CP6 “Where allowed tasks go”: the project's Board, in the first column or a column the owner names. */
function LandingColumn({rules, onChange}: {rules: Rules; onChange: (body: unknown) => void}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(rules.column ?? '');
  return <div className="cp-block">
    <div className="cp-card"><span className="cp-tile" style={{'--tint': '#9DBBFF'} as React.CSSProperties}><UiIcon name="board" size={18}/></span>
      <span className="cp-choice-text"><span>Where allowed tasks go</span><small>{rules.column ? `The project’s Board, column ${rules.column}` : 'The project’s Board, its first column'}</small></span>
      {!editing && <button type="button" className="cp-link" onClick={() => { setName(rules.column ?? ''); setEditing(true); }}>Change…</button>}
    </div>
    {editing && <div className="computer-rule-add">
      <label className="phone-field"><span>Column name</span><input autoFocus value={name} maxLength={60} placeholder="To do" onChange={e => setName(e.target.value)}/></label>
      <p className="cp-note">Used on every project’s Board that has a column with this name; otherwise the first column.</p>
      <div className="setup-actions">
        {rules.column && <button type="button" onClick={() => { onChange({column: null}); setEditing(false); }}>Use the first column</button>}
        <button type="button" onClick={() => setEditing(false)}>Cancel</button>
        <button type="button" className="primary" disabled={!name.trim()} onClick={() => { onChange({column: name.trim()}); setEditing(false); }}>Save</button>
      </div>
    </div>}
  </div>;
}

/** CP6d “Tasks at once on this computer” (1–5); more wait their turn on the computer that sent them. */
export function TasksAtOnce({client}: {client: SessionClient}) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { let live = true; void client.request({method: 'GET', path}).then(r => { if (live && r.status === 200) setRules(r.body as Rules); }).catch(() => {}); return () => { live = false; }; }, [client]);
  if (!rules) return null;
  return <div className="phone-list" role="list"><div className="phone-row" role="listitem">
    <span className="phone-tile"><UiIcon name="layers" size={15}/></span>
    <span className="phone-row-text"><b>Tasks at once on this computer</b><small>More wait their turn on the computer that sent them.</small></span>
    <select aria-label="Tasks at once on this computer" value={rules.atOnce ?? 3} onChange={e => void post(client, {atOnce: Number(e.target.value)}).then(setRules).catch(() => setNotice('It could not be saved. Try again.'))}>{[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}</select>
    {notice && <small role="status">{notice}</small>}
  </div></div>;
}

/** CP4b: Allow a task that arrived, once or always from that computer in that project; Not now keeps it waiting. */
export function AllowTask({client, approvalId, sourceName, onDone, onApprovals}: {client: SessionClient; approvalId: string; sourceName: string; onDone: (text: string) => void; onApprovals: () => void}) {
  const [always, setAlways] = useState(false);
  const [busy, setBusy] = useState(false);
  const allow = async () => {
    setBusy(true);
    try {
      const d = await client.request({method: 'GET', path: `/api/approvals/${encodeURIComponent(approvalId)}`} as never);
      const detail = (d.body as any)?.approval;
      if (d.status !== 200 || !detail?.paramsHash) { onApprovals(); return; }
      const preview = detail.params?.preview;
      if (always && typeof preview?.sourceDevice === 'string' && typeof preview?.project === 'string') await post(client, {always: {source: preview.sourceDevice, projectId: preview.project, on: true}}).catch(() => null);
      const r = await client.request({method: 'POST', path: `/api/approvals/${encodeURIComponent(approvalId)}/approve`, body: {paramsHash: detail.paramsHash}} as never);
      // Some approvals need a second check (verification): the Approvals page asks for it.
      if (r.status !== 200) { onApprovals(); return; }
      onDone('Allowed. It starts now.');
    } catch { onDone('It could not be allowed. Try again.'); } finally { setBusy(false); }
  };
  return <span className="computer-allow">
    <label className="computer-allow-always"><input type="checkbox" checked={always} onChange={e => setAlways(e.target.checked)}/>Always from {sourceName} here</label>
    <button type="button" className="primary" disabled={busy} onClick={() => void allow()}>Allow</button>
  </span>;
}

/** CP3 inspector: “Takes new tasks” for this computer (off: it shows as not taking tasks and refuses new ones). */
export function TakesNewTasks({client}: {client: SessionClient}) {
  const [rules, setRules] = useState<Rules | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { let live = true; void client.request({method: 'GET', path}).then(r => { if (live && r.status === 200) setRules(r.body as Rules); }).catch(() => {}); return () => { live = false; }; }, [client]);
  if (!rules) return null;
  return <label className="computers-check"><input type="checkbox" checked={rules.takes !== false} onChange={e => void post(client, {takes: e.target.checked}).then(setRules).catch(() => setNotice('It could not be saved.'))}/>Takes new tasks{notice && <small role="status">{notice}</small>}</label>;
}
