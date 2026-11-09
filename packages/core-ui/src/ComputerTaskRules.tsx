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
type Rules = {rule: TaskRule; projects: Record<string, TaskRule>; always: {source: string; projectId: string}[]};
const CHOICES: ReadonlyArray<{key: TaskRule; title: string; note: string; icon: UiIconName}> = [
  {key: 'ask', title: 'Ask me every time', note: 'A notice with Allow / Not now. Recommended.', icon: 'inbox'},
  {key: 'auto', title: 'Allow automatically', note: 'It starts at once, with this computer’s rules for agents.', icon: 'play'},
  {key: 'refuse', title: 'Don’t accept', note: 'Other computers can’t send tasks here.', icon: 'close'},
];
export const taskRuleWords = (r: TaskRule) => CHOICES.find(c => c.key === r)!.title.replace(' every time', '');
const path = '/api/computers/task-rules';

async function post(client: SessionClient, body: unknown): Promise<Rules> {
  const r = await client.request({method: 'POST', path, body});
  if (r.status !== 200) throw Error('rules_refused');
  return r.body as Rules;
}

export function ComputerTaskRules({client, deviceNames}: {client: SessionClient; deviceNames: Record<string, string>}) {
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
  return <div className="computer-task-rules">
    <p className="section-label">For all projects</p>
    <div role="radiogroup" aria-label="For all projects" className="computer-start-choices">
      {CHOICES.map(c => <button key={c.key} type="button" role="radio" aria-checked={rules.rule === c.key} className={`computer-start-choice${rules.rule === c.key ? ' is-on' : ''}`} onClick={() => change({rule: c.key})}>
        <span className="computer-start-tile"><UiIcon name={c.icon} size={16}/></span><span><b>{c.title}</b><small>{c.note}</small></span>
      </button>)}
    </div>
    <p className="section-label computers-label"><span>Except these projects</span><button type="button" className="tool" title="Add a project" aria-label="Add a project" onClick={() => { setAdding(true); setPick(null); setQuery(''); }}><UiIcon name="plus" size={14}/></button></p>
    {exceptions.length ? <div className="phone-list" role="list">{exceptions.map(([id, r]) => <div key={id} className="phone-row" role="listitem">
      <span className="phone-tile"><UiIcon name="folder" size={15}/></span><span className="phone-row-text"><b>{nameOf(id)}</b></span>
      <select aria-label={`Rule for ${nameOf(id)}`} value={r} onChange={e => change({project: {id, rule: e.target.value}})}>{CHOICES.map(c => <option key={c.key} value={c.key}>{taskRuleWords(c.key)}</option>)}</select>
      <button type="button" className="tool" title="Use the rule for all" aria-label={`Remove ${nameOf(id)}`} onClick={() => change({project: {id, rule: null}})}><UiIcon name="close" size={13}/></button>
    </div>)}</div> : <p className="fine-print">Only projects that differ are listed here.</p>}
    {adding && <div className="computer-rule-add">
      <label className="phone-field"><span>Find a project</span><input autoFocus value={query} placeholder="Type a name" onChange={e => { setQuery(e.target.value); setPick(null); }}/></label>
      {!pick && query.trim() && <div className="phone-list" role="listbox" aria-label="Projects">{found.length ? found.map(p => <button key={p.id} type="button" role="option" aria-selected={false} className="phone-row" onClick={() => setPick(p)}><UiIcon name="folder" size={14}/><span className="phone-row-text"><b>{p.name}</b></span></button>) : <p className="fine-print">No project with that name.</p>}</div>}
      {pick && <p className="computer-rule-pick"><b>{pick.name}</b>: {CHOICES.map(c => <button key={c.key} type="button" onClick={() => { change({project: {id: pick.id, rule: c.key}}); setAdding(false); }}>{taskRuleWords(c.key)}</button>)}</p>}
      <button type="button" className="link-button" onClick={() => setAdding(false)}>Cancel</button>
    </div>}
    {rules.always.length > 0 && <><p className="section-label">Always allowed</p><div className="phone-list" role="list">{rules.always.map(a => <div key={a.source + a.projectId} className="phone-row" role="listitem">
      <span className="phone-tile"><UiIcon name="check" size={15}/></span><span className="phone-row-text"><b>From {deviceNames[a.source] ?? 'another computer'}</b><small>{nameOf(a.projectId)}</small></span>
      <button type="button" className="tool" title="Stop allowing always" aria-label="Stop allowing always" onClick={() => change({always: {source: a.source, projectId: a.projectId, on: false}})}><UiIcon name="close" size={13}/></button>
    </div>)}</div></>}
    <p className="section-label">Where allowed tasks go</p>
    <p className="fine-print"><UiIcon name="board" size={13}/> The project’s Board, in its first column. Each computer works in its own copy, on its own branch.</p>
    <p className="section-label">Tasks at once on this computer</p>
    <p className="fine-print"><UiIcon name="layers" size={13}/> Up to 3. More wait their turn on the computer that sent them.</p>
    {notice && <p role="status" className="fine-print">{notice}</p>}
  </div>;
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
