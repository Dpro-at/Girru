// RULES-01: Agents › Rules (board AgentsRules). A short list grouped by where a rule applies;
// select a rule and the inspector edits it in place (saves by itself). One main button, New rule.
// Pause, Duplicate, Earlier versions and Delete in ⋯ and the right-click menu; Delete has Undo.
// The eye shows the exact list one agent gets in one project, in order (the later one wins; with the
// STORE-MAP-01 P2 switch, strongest precedence group first and the later one wins inside a group).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import { Avatar, ContextMenu, IconButton, Notice, Popover, Sheet, useMenu } from './desktop-ui';
import type { MenuItem } from './desktop-ui';
import { DocumentEditor } from './DocumentEditor';
import { PRECEDENCE_ORDER, PRECEDENCE_TITLES, RulesController, followers, reaches, ruleGroups, ruleLine, whoWords } from './agent-rules';
import type { FilesState, Rule, RuleAgent, RuleChange, RuleVersion, RuleWho } from './agent-rules';
import type { SessionClient } from './session';

const NEW = 'new';
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent ?? '');
const mod = isMac ? '⌘' : 'Ctrl+';
const WHERE_ICON = (r: Rule): UiIconName => (r.status === 'suggested' ? 'bulb' : r.who === 'agents' ? 'avatar' : r.projectId ? 'folder' : 'globe');
const WHERE_TIP = (r: Rule) => (r.status === 'suggested' ? 'Suggested by an agent' : r.who === 'agents' ? 'Chosen agents' : r.projectId ? 'One project' : 'Everywhere');

export function AgentRules({ client, agents, active, onCount }: { client: SessionClient; agents: readonly RuleAgent[]; active: boolean; onCount?: (suggestions: number) => void }) {
  const [c] = useState(() => new RulesController(client));
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const menu = useMenu();
  const [filter, setFilter] = useState<{ agentId: string; projectId: string }>({ agentId: '', projectId: '' });
  const [filtering, setFiltering] = useState(false);
  const [sees, setSees] = useState(false);
  const [history, setHistory] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (active) void c.load(); }, [active, c]);
  useEffect(() => { onCount?.(s.suggestions.length); }, [s.suggestions.length]);
  const agent = agents.find(a => a.id === filter.agentId) ?? null;
  const shown = (r: Rule) => reaches(r, agent, filter.projectId || null) && (!filter.projectId || r.projectId === filter.projectId || !r.projectId);
  const groups = useMemo(() => ruleGroups(s.rules.filter(shown), s.suggestions, s.projects), [s.rules, s.suggestions, s.projects, filter, agents]);
  const order = groups.flatMap(g => g.rules.map(r => r.id));
  const [filesFor, setFilesFor] = useState<string | null>(null);
  const filesWords = (id: string) => { const f = s.files[id]; return `Files for Claude Code, Codex, Gemini${!f ? '…' : f.upToDate ? ' · up to date' : f.written ? ' · will update' : ' · not written'}`; };
  const filesLink = (id: string) => s.files[id] || s.projects.find(p => p.id === id)?.folder ? <button type="button" className="link-button rules-files-link" title="Claude Code reads CLAUDE.md, Codex and Antigravity read AGENTS.md, Gemini reads GEMINI.md; the rules are written once to .girru/rules.md" onClick={() => setFilesFor(id)}><UiIcon name="file" size={11}/>{filesWords(id)}</button> : null;
  const selected = s.selected === NEW ? null : c.find(s.selected);
  const filters = (filter.agentId ? 1 : 0) + (filter.projectId ? 1 : 0);

  const itemsFor = (r: Rule): MenuItem[] => r.locked ? [] : r.status === 'suggested'
    ? [{ label: 'Use this rule', icon: 'check', run: () => void c.decide(r.id, true) }, { label: 'Dismiss', icon: 'close', run: () => void c.decide(r.id, false) }]
    : [
      { label: r.paused ? 'Turn on' : 'Pause', icon: r.paused ? 'play' : 'pause', shortcut: 'P', run: () => void c.change(r.id, { paused: !r.paused }) },
      { label: 'Duplicate', icon: 'copy', run: () => void c.duplicate(r.id) },
      { label: 'Earlier versions', icon: 'history', disabled: r.version < 2, run: () => setHistory(r.id) },
      ...(r.shipped ? [{ label: 'Put back as it came', icon: 'undo' as UiIconName, disabled: r.version < 2, run: () => void c.putBack(r.id) }]
        : ['sep' as const, { label: 'Delete', icon: 'trash' as UiIconName, shortcut: '⌫', danger: true, run: () => void c.remove(r.id) }]),
    ];
  const listKey = (e: ReactKeyboardEvent) => {
    const i = order.indexOf(s.selected ?? '');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const n = order[Math.min(order.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]; if (n) c.select(n); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selected?.status === 'active' && !selected.shipped) { e.preventDefault(); void c.remove(selected.id); }
    else if (e.key.toLowerCase() === 'p' && !e.metaKey && !e.ctrlKey && selected?.status === 'active' && !selected.locked) { e.preventDefault(); void c.change(selected.id, { paused: !selected.paused }); }
    else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && s.lastDeleted) { e.preventDefault(); void c.undo(); }
    else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); setSees(true); }
    else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && selected) menu.at(e, itemsFor(selected));
  };
  const empty = s.phase === 'ready' && !s.rules.length && !s.suggestions.length;

  return <section className="dk-mem rules-page" aria-label="Rules" data-inspector={s.selected ? 'open' : undefined} onKeyDown={listKey}>
    <div className="dk-content">
      <header className="dk-toolbar">
        <div className="dk-title"><h2>Rules</h2><span className="dk-sub">How your agents work. They read these before every task.</span></div>
        <span className="dk-toolbar-gap"/>
        <IconButton icon="eye" label="What an agent sees" shortcut={`${mod}⇧E`} onClick={() => setSees(true)}/>
        <span className="dk-anchor" data-popover-anchor><IconButton icon="filter" label="Show rules for a project or an agent" pressed={filtering || filters > 0} badge={filters || undefined} onClick={() => setFiltering(v => !v)}/>
          <Popover open={filtering} onClose={() => setFiltering(false)} label="Show rules for">
            <div className="rules-filter">
              <label className="dk-field">Project<select value={filter.projectId} onChange={e => setFilter({ ...filter, projectId: e.target.value })}><option value="">Every project</option>{s.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label className="dk-field">Agent<select value={filter.agentId} onChange={e => setFilter({ ...filter, agentId: e.target.value })}><option value="">Every agent</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
              {filters > 0 && <button type="button" className="link-button" onClick={() => setFilter({ agentId: '', projectId: '' })}>Show all</button>}
            </div>
          </Popover></span>
        <button type="button" className="primary" disabled={s.busy} onClick={() => c.select(NEW)}><UiIcon name="plus" size={13}/>New rule</button>
      </header>
      {s.notice && <p className="dk-inline-notice" role="alert">{s.notice}</p>}
      <div className="dk-body">
        {s.phase === 'loading' && !s.rules.length ? <p className="dk-empty" role="status">Loading the rules…</p>
          : empty ? <div className="dk-empty"><UiIcon name="scale" size={26}/><p>Rules tell every agent how you like the work done.</p>
            <span className="rules-empty-actions"><button type="button" disabled={s.busy} onClick={() => void c.starter()}>Start with our usual rules</button><button type="button" onClick={() => c.select(NEW)}><UiIcon name="plus" size={13}/>New rule</button></span>
            <small className="fine-print">"Our usual rules" adds them paused, so you look first.</small></div>
          : <div className="dk-list" role="listbox" aria-label="Rules" tabIndex={0} ref={listRef}>
            {groups.map(g => <div key={g.id} className="dk-list-group" role="group" aria-label={g.title}><h3>{g.title}{g.id.startsWith('project:') && <span className="rules-group-side">{filesLink(g.id.slice(8))}</span>}</h3>
              {!g.rules.length && <p className="dk-pad fine-print">No rules of its own; it gets the everywhere rules.</p>}
              {g.rules.map(r => <div key={r.id} role="option" className="dk-row rules-row" aria-selected={s.selected === r.id} data-paused={r.paused || undefined} data-suggested={r.status === 'suggested' || undefined}
                onClick={() => { c.select(r.id); listRef.current?.focus(); }} onContextMenu={(e: ReactMouseEvent) => { c.select(r.id); if (itemsFor(r).length) menu.at(e, itemsFor(r)); else e.preventDefault(); }}>
                <span className="dk-row-icon" title={WHERE_TIP(r)}><UiIcon name={WHERE_ICON(r)} size={15}/></span>
                <span className="dk-row-text"><span className="dk-row-main" dir="auto">{r.text}</span>
                  <span className="dk-row-sub">{r.when && <><span className="rules-when" title="Only in this case"><UiIcon name="branch" size={11}/>When {r.when}</span> · </>}{r.status === 'suggested' ? `${agents.find(a => a.id === r.suggestedBy)?.name ?? 'An agent'} suggests · ${whoWords(r, agents, s.projects)}${r.projectId ? '' : ' · everywhere'}` : whoWords(r, agents, s.projects)}</span></span>
                {r.locked && r.projectId ? <span className="rules-paused" title="Comes with the project’s task file: on while the task file is on"><UiIcon name="lock" size={11}/>{r.paused ? 'Task file off' : 'With the task file'}</span>
                  : r.locked ? <span className="rules-paused" title="Safety rule: always on"><UiIcon name="lock" size={11}/>Always on</span> : r.paused && <span className="rules-paused"><UiIcon name="pause" size={11}/>Paused</span>}
              </div>)}</div>)}
            {!groups.length && s.phase === 'ready' && <p className="dk-empty">No rule reaches {agent?.name ?? 'this choice'} here. <button type="button" className="link-button" onClick={() => setFilter({ agentId: '', projectId: '' })}>Show all</button></p>}
          </div>}
      </div>
    </div>
    {s.selected && <aside className="dk-inspector" aria-label="Rule details">
      {selected?.locked ? <LockedInspector key={s.selected} c={c} rule={selected}/> : <RuleInspector key={s.selected} c={c} rule={selected ?? null} agents={agents} onHistory={() => selected && setHistory(selected.id)} onMenu={e => selected && menu.at(e, itemsFor(selected))}/>}
    </aside>}
    <ContextMenu menu={menu.menu} onClose={menu.close}/>
    {sees && <AgentSees c={c} agents={agents} projects={s.projects} initial={filter} onClose={() => setSees(false)}/>}
    {history && <VersionsSheet c={c} id={history} onClose={() => setHistory(null)}/>}
    {filesFor && <FilesSheet c={c} projectId={filesFor} name={s.projects.find(p => p.id === filesFor)?.name ?? 'Project'} onClose={() => setFilesFor(null)}/>}
    <Notice toast={s.toast} onUndo={() => void c.undo()} onDone={id => c.dismiss(id)}/>
  </section>;
}

/** The selected rule (or a new one): its words, where, who, on/off, from, versions. Saves by itself. */
function RuleInspector({ c, rule, agents, onHistory, onMenu }: { c: RulesController; rule: Rule | null; agents: readonly RuleAgent[]; onHistory: () => void; onMenu: (e: ReactMouseEvent) => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const [text, setText] = useState(rule?.text ?? '');
  // RULES-02: a rule may apply only in a case ("When …"); null = always.
  const [when, setWhen] = useState<string | null>(rule?.when ?? null);
  const whenRef = useRef<HTMLInputElement>(null);
  const [reach, setReach] = useState<{ projectId: string | null; who: RuleWho; targets: string[] }>({ projectId: rule?.projectId ?? null, who: rule?.who ?? 'all', targets: [...(rule?.targets ?? [])] });
  const [editor, setEditor] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!rule) area.current?.focus(); }, []);
  const save = (change: RuleChange) => {
    if (!rule) { const t = (change.text ?? text).trim(); const w = change.when !== undefined ? change.when : when?.trim() || null; if (t) void c.create({ text: t, when: w, projectId: change.projectId ?? reach.projectId, who: change.who ?? reach.who, targets: change.targets ?? reach.targets }); return; }
    void c.change(rule.id, change);
  };
  // Saves by itself: a moment after typing stops, and when the field is left.
  useEffect(() => { if (!rule || text.trim() === rule.text || !text.trim()) return; const t = setTimeout(() => save({ text: text.trim() }), 800); return () => clearTimeout(t); }, [text]);
  useEffect(() => { if (!rule || when === null || !when.trim() || when.trim() === rule.when) return; const t = setTimeout(() => save({ when: when.trim() }), 800); return () => clearTimeout(t); }, [when]);
  const setCase = (only: boolean) => { if (!only) { setWhen(null); if (rule?.when) save({ when: null }); } else { setWhen(w => w ?? ''); requestAnimationFrame(() => whenRef.current?.focus()); } };
  const setWho = (who: RuleWho) => { const next = { ...reach, who, targets: who === reach.who ? reach.targets : [] }; setReach(next); if (who === 'all' || next.targets.length) save({ who, targets: next.targets }); };
  const toggle = (t: string) => { const targets = reach.targets.includes(t) ? reach.targets.filter(x => x !== t) : [...reach.targets, t]; setReach({ ...reach, targets }); if (targets.length) save({ who: reach.who, targets }); };
  const setWhere = (projectId: string | null) => { setReach({ ...reach, projectId }); save({ projectId }); };
  const suggested = rule?.status === 'suggested';
  const by = rule?.suggestedBy ? agents.find(a => a.id === rule.suggestedBy)?.name ?? 'An agent' : null;
  const n = followers(reach, agents);
  return <div className="rules-inspector">
    <div className="rules-inspector-head"><b>{rule ? (suggested ? 'Suggested rule' : 'Rule') : 'New rule'}</b>
      {rule && !suggested && <label className="rules-switch" title={rule.paused ? 'Paused: agents do not get it (P)' : 'On: agents follow it (P)'}><span>{rule.paused ? 'Paused' : 'On'}</span>
        <input type="checkbox" role="switch" aria-label="Agents follow this rule" checked={!rule.paused} onChange={e => save({ paused: !e.target.checked })}/></label>}
      {rule && !suggested && <IconButton icon="more" label="More" onClick={onMenu}/>}
      <IconButton icon="close" label="Close" shortcut="Esc" onClick={() => c.select(null)}/></div>
    {suggested && <p className="rules-from"><Avatar name={by ?? 'Agent'} size={20}/>{by} suggests this{rule?.reason ? <> · <span className="fine-print">Why: “{rule.reason}”</span></> : null}</p>}
    <div className="dk-field">When it applies
      <span className="dk-segmented" role="group" aria-label="When it applies">
        <button type="button" aria-pressed={when === null} onClick={() => setCase(false)}>Always</button>
        <button type="button" aria-pressed={when !== null} onClick={() => setCase(true)}><UiIcon name="branch" size={12}/>Only when…</button></span>
      {when !== null && <label className="rules-when-field"><b>When</b><input ref={whenRef} dir="auto" aria-label="The case" maxLength={300} value={when} placeholder="the task changes a screen"
        onChange={e => setWhen(e.target.value)} onBlur={() => { const w = when.trim(); if (rule && w && w !== rule.when) save({ when: w }); }}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); c.select(null); } }}/></label>}
      {when !== null && <small className="fine-print">Say the case the way you would tell a person. Agents follow the rule only then.</small>}</div>
    <label className="dk-field">The rule
      <textarea ref={area} rows={4} dir="auto" value={text} placeholder="One sentence, the way you would tell a person. For example: Run the tests before you say a task is done."
        onChange={e => setText(e.target.value)} onBlur={() => { if (text.trim() && text.trim() !== rule?.text) save({ text: text.trim() }); }}
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); setEditor(true); } else if (e.key === 'Escape') { e.stopPropagation(); c.select(null); } }}/>
      <small className="fine-print">{rule ? 'Saves by itself.' : 'Saved when you leave the field.'} Long rules open in the editor ({mod}↩).</small></label>
    <div className="dk-field">Where it applies
      <span className="dk-segmented" role="group" aria-label="Where it applies">
        <button type="button" aria-pressed={!reach.projectId} onClick={() => setWhere(null)}><UiIcon name="globe" size={12}/>Everywhere</button>
        <button type="button" aria-pressed={!!reach.projectId} disabled={!s.projects.length} title={s.projects.length ? undefined : 'No project yet'} onClick={() => setWhere(reach.projectId ?? s.projects[0]?.id ?? null)}><UiIcon name="folder" size={12}/>One project</button></span>
      {reach.projectId && <select aria-label="Project" value={reach.projectId} onChange={e => setWhere(e.target.value)}>{s.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</div>
    <div className="dk-field">Who follows it
      <span className="dk-segmented" role="group" aria-label="Who follows it">
        {([['all', 'All agents'], ['departments', 'A department'], ['agents', 'Chosen agents']] as const).map(([v, label]) => <button key={v} type="button" aria-pressed={reach.who === v} onClick={() => setWho(v)}>{label}</button>)}</span>
      {reach.who !== 'all' && <span className="rules-targets" role="group" aria-label={reach.who === 'departments' ? 'Departments' : 'Agents'}>
        {(reach.who === 'departments' ? s.departments.map(d => ({ id: d, name: d[0].toUpperCase() + d.slice(1) })) : agents).map(t =>
          <button key={t.id} type="button" className="rules-chip" aria-pressed={reach.targets.includes(t.id)} onClick={() => toggle(t.id)}>{reach.who === 'agents' && <Avatar name={t.name} size={16}/>}{t.name}</button>)}
        {reach.who === 'departments' && !s.departments.length && <small className="fine-print">No departments yet. Set them on each agent’s page.</small>}</span>}
      <small className="fine-print">{reach.who !== 'all' && !reach.targets.length ? 'Choose at least one.' : `${n} ${n === 1 ? 'agent follows' : 'agents follow'} it${reach.projectId ? ' in this project' : ''}.`}</small></div>
    {text.trim() && <p className="rules-reads"><b>The agent reads:</b> <span dir="auto">{ruleLine({ text: text.trim(), when: when?.trim() || null })}</span></p>}
    {rule && !suggested && <p className="rules-from">{rule.shipped ? <><UiIcon name="sparkle" size={13}/>Comes with Girru{rule.version > 1 ? <> · you changed it · <button type="button" className="link-button" onClick={() => void c.putBack(rule.id)}>Put back as it came</button></> : null}</> : rule.source === 'agent' ? <>Suggested by {by}, used by you</> : <>Written by you</>}{!rule.shipped && <> · {new Date(rule.createdAt.replace(' ', 'T') + (rule.createdAt.includes('Z') ? '' : 'Z')).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</>}</p>}
    {rule && !suggested && rule.version > 1 && <button type="button" className="link-button rules-versions" onClick={onHistory}><UiIcon name="history" size={13}/>{rule.version - 1} earlier {rule.version === 2 ? 'version' : 'versions'}</button>}
    {suggested && <span className="rules-decide"><button type="button" disabled={s.busy} onClick={() => void c.decide(rule!.id, false)}>Dismiss</button><button type="button" className="primary" disabled={s.busy} onClick={() => void c.decide(rule!.id, true)}>Use this rule</button></span>}
    <small className="fine-print rules-order">{s.precedence
      ? 'A rule without “When” always applies. When two disagree, the stronger one wins, in this order: safety rules, this project, rules for this agent, its department, all agents. An agent’s own instructions, specialties and skills never override a rule.'
      : 'A rule without “When” always applies. A project rule comes after an everywhere rule, and a rule for chosen agents comes last. When two disagree, the later one wins.'}</small>
    {editor && <DocumentEditor title="Rule" files={[{ id: 'rule', name: 'Rule.md', content: text }]} maxLength={2000} onChange={(_, t) => setText(t)} onClose={() => { setEditor(false); if (text.trim() && text.trim() !== rule?.text) save({ text: text.trim() }); }}/>}
  </div>;
}

/** The exact list one agent gets in one project, in order. */
function AgentSees({ c, agents, projects, initial, onClose }: { c: RulesController; agents: readonly RuleAgent[]; projects: readonly { id: string; name: string }[]; initial: { agentId: string; projectId: string }; onClose: () => void }) {
  const [agentId, setAgentId] = useState(initial.agentId || agents[0]?.id || '');
  const [projectId, setProjectId] = useState(initial.projectId);
  const [list, setList] = useState<Rule[] | null>(null);
  const [check, setCheck] = useState<{ conflicts: { a: string; b: string; why: string }[]; checked: boolean } | null | 'checking'>(null);
  useEffect(() => {
    if (!agentId) return;
    let on = true;
    setList(null); setCheck(null);
    void c.effective(agentId, projectId || null).then(l => {
      if (!on) return;
      setList(l);
      // Two or more rules: the local model looks for ones that disagree (a moment; the list shows first).
      if (l && l.length > 1) { setCheck('checking'); void c.conflicts(agentId, projectId || null).then(r => { if (on) setCheck(r ?? { conflicts: [], checked: false }); }); }
    });
    return () => { on = false; };
  }, [agentId, projectId]);
  const textOf = (id: string) => { const r = list?.find(x => x.id === id); return r ? ruleLine(r) : ''; };
  const open = (id: string) => { c.select(id); onClose(); };
  const tier = (r: Rule) => (r.who === 'agents' ? 'this agent' : r.projectId ? projects.find(p => p.id === r.projectId)?.name ?? 'project' : 'everywhere');
  const item = (r: Rule) => <li key={r.id} dir="auto">{r.when && <span className="rules-when-lead">When {r.when}: </span>}{r.text} <span className="fine-print">· {tier(r)}</span></li>;
  // STORE-MAP-01 P2: the backend sends the list strongest group first, each rule with its group.
  const byGroup = !!list?.length && list.every(r => r.group);
  // Who wins when two disagree: the stronger group; inside one group (or without groups) the later one.
  const winner = (a: string, b: string) => {
    const ra = list?.find(x => x.id === a), rb = list?.find(x => x.id === b);
    if (!byGroup || !ra?.group || !rb?.group || ra.group === rb.group) return b;
    return PRECEDENCE_ORDER.indexOf(ra.group) < PRECEDENCE_ORDER.indexOf(rb.group) ? a : b;
  };
  return <Sheet title="What an agent sees" onClose={onClose} wide actions={<button type="button" className="primary" onClick={onClose}>Done</button>}>
    <div className="rules-sees-pick">
      <label className="dk-field">Agent<select value={agentId} onChange={e => setAgentId(e.target.value)}>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="dk-field">In<select value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">A chat without a project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    </div>
    {list === null ? <p className="fine-print" role="status">Reading…</p> : !list.length ? <p className="fine-print">No rule reaches this agent here.</p>
      : byGroup ? PRECEDENCE_ORDER.filter(g => list.some(r => r.group === g)).map(g => <section key={g} className="rules-sees-group" aria-label={PRECEDENCE_TITLES[g]}>
          <h4 className="rules-sees-head">{PRECEDENCE_TITLES[g]}</h4>
          <ol className="rules-sees" start={list.findIndex(r => r.group === g) + 1}>{list.filter(r => r.group === g).map(item)}</ol></section>)
      : <ol className="rules-sees">{list.map(item)}</ol>}
    {check === 'checking' && <p className="fine-print" role="status">Checking for rules that disagree…</p>}
    {check && check !== 'checking' && check.conflicts.map(x => <div key={`${x.a}-${x.b}`} className="rules-conflict" role="alert"><UiIcon name="alert" size={14}/>
      <span>Two rules disagree: “{textOf(x.a)}” and “{textOf(x.b)}”.{x.why ? ` ${x.why}` : ''} {byGroup ? 'The stronger one' : 'The later one'}, “{textOf(winner(x.a, x.b))}”, wins.
        <span className="rules-conflict-open"><button type="button" className="link-button" onClick={() => open(x.a)}>Open the first</button><button type="button" className="link-button" onClick={() => open(x.b)}>Open the second</button></span></span></div>)}
    {check && check !== 'checking' && !check.checked && <p className="fine-print">The local model could not check whether rules disagree right now.</p>}
    <p className="fine-print">{byGroup
      ? 'This is the list the agent gets before a task, strongest group first: Safety (always on) · This project · For this agent · Its department · All agents. Inside a group the later rule wins. Paused rules are left out.'
      : 'This is the list, in this order, that the agent gets before a task. When two disagree, the later one wins; two rules for different cases do not disagree. Paused rules are left out.'}</p>
  </Sheet>;
}

function VersionsSheet({ c, id, onClose }: { c: RulesController; id: string; onClose: () => void }) {
  const [list, setList] = useState<RuleVersion[] | null>(null);
  useEffect(() => { void c.versions(id).then(setList); }, [id]);
  return <Sheet title="Earlier versions" onClose={onClose} actions={<button type="button" onClick={onClose}>Close</button>}>
    {list === null ? <p className="fine-print" role="status">Reading…</p> : !list.length ? <p className="fine-print">No earlier version.</p>
      : <ul className="rules-history">{list.map(v => <li key={v.version}><span dir="auto">{v.text}</span><small className="fine-print">{new Date(v.changedAt.replace(' ', 'T') + 'Z').toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
        <button type="button" className="link-button" onClick={() => { void c.restore(id, v.version); onClose(); }}>Put back</button></li>)}</ul>}
  </Sheet>;
}

/** RULES-04: a safety rule that comes with Girru: always on, never edited. */
function LockedInspector({ c, rule }: { c: RulesController; rule: Rule }) {
  // TASKLOG-01: the task file rule of one project (on while that project's task file is on).
  if (rule.projectId) return <div className="rules-inspector">
    <div className="rules-inspector-head"><b>Rule</b><span className="rules-paused" title="On while the project’s task file is on"><UiIcon name="lock" size={12}/>{rule.paused ? 'Task file off' : 'With the task file'}</span>
      <IconButton icon="close" label="Close" shortcut="Esc" onClick={() => c.select(null)}/></div>
    <p className="rules-reads" dir="auto">{rule.text}</p>
    <p className="rules-from"><UiIcon name="file" size={13}/>Comes with this project’s task file (.girru/tasks.md), so every agent and app keeps its tasks there. It is on while the task file is on; turn the task file on or off in the project’s files sheet.</p>
    <div className="dk-field">Who follows it<span className="rules-from">All agents and apps in {c.getSnapshot().projects.find(p => p.id === rule.projectId)?.name ?? 'this project'}</span></div>
  </div>;
  return <div className="rules-inspector">
    <div className="rules-inspector-head"><b>Rule</b><span className="rules-paused" title="Safety rule: always on, for everyone"><UiIcon name="lock" size={12}/>Always on</span>
      <IconButton icon="close" label="Close" shortcut="Esc" onClick={() => c.select(null)}/></div>
    <p className="rules-reads" dir="auto">{rule.text}</p>
    <p className="rules-from"><UiIcon name="shield" size={13}/>A safety rule that comes with Girru. It keeps your data and computer safe, so it is always on and cannot be changed.</p>
    <div className="dk-field">Who follows it<span className="rules-from">All agents, everywhere</span></div>
  </div>;
}

const ACTION_WORDS: Record<FilesState['files'][number]['action'], string> = {
  create: 'will be created', add: 'gets the Girru part (your notes stay)', update: 'will be updated', unchanged: 'up to date',
  tracked: 'already in Git: left as it is while the files are private', link: 'is a link: never written through',
};
/** RULES-03: one project's coding app files: what writing does, private or with the project, then Write the files. */
function FilesSheet({ c, projectId, name, onClose }: { c: RulesController; projectId: string; name: string; onClose: () => void }) {
  const s = useSyncExternalStore(c.subscribe, c.getSnapshot, c.getSnapshot);
  const [state, setState] = useState<FilesState | null>(s.files[projectId] ?? null);
  const [mode, setMode] = useState<'private' | 'project'>(s.files[projectId]?.mode ?? 'private');
  useEffect(() => { void c.filesState(projectId).then(f => { if (f) { setState(f); setMode(f.mode); } }); }, [projectId]);
  const write = async () => { if (await c.writeFiles(projectId, mode)) onClose(); };
  return <Sheet title={`Coding app files · ${name}`} wide onClose={onClose} actions={<><button type="button" onClick={onClose}>Not now</button>
    <button type="button" className="primary" disabled={s.busy || !state?.hasFolder} onClick={() => void write()}>{state?.written ? 'Write the files again' : 'Write the files'}</button></>}>
    <p className="fine-print rules-files-intro">The rules are written once, to .girru/rules.md. CLAUDE.md and GEMINI.md get one line that points to it. Codex and Antigravity read AGENTS.md and do not follow that line, so AGENTS.md gets the rules themselves. A rule change re-writes them by itself. Inside Girru the apps already get the rules; these files are for when an app runs on its own in this folder.</p>
    {!state ? <p className="fine-print" role="status">Reading the folder…</p> : !state.hasFolder ? <p className="dk-inline-notice">This project has no folder yet.</p>
      : <ul className="rules-files">{state.files.map(f => <li key={f.name} data-action={f.action}><UiIcon name="file" size={13}/><code>{f.name}</code><span className="fine-print">{ACTION_WORDS[f.action]}</span></li>)}</ul>}
    {state?.rules && <pre className="rules-files-preview" dir="auto">{state.rules.split('\n').slice(1).join('\n').trim()}</pre>}
    <div className="dk-field">Keep these files
      <span className="dk-segmented" role="group" aria-label="Keep these files">
        <button type="button" aria-pressed={mode === 'private'} onClick={() => setMode('private')}>Private on this computer</button>
        <button type="button" aria-pressed={mode === 'project'} onClick={() => setMode('project')}>With the project (in Git)</button></span>
      <small className="fine-print">{mode === 'private' ? 'Girru adds them to this folder’s own Git exclude, so nothing is committed or pushed.' : 'Everyone who opens the repository gets the same rules. Girru never commits; that stays your call.'}</small></div>
    {state?.written && <div className="dk-field rules-task-file">
      <span className="rules-task-file-head"><UiIcon name="file" size={14}/><b>Task file</b><code>.girru/tasks.md</code>
        <label className="rules-switch" title={state.tasks?.on ? 'On: every agent and app keeps its tasks in it' : 'Off: the file stays; nobody is asked to keep it'}><span>{state.tasks?.on ? 'On' : 'Off'}</span>
          <input type="checkbox" role="switch" aria-label="Task file" checked={!!state.tasks?.on} disabled={s.busy} onChange={e => void c.setTasks(projectId, e.target.checked).then(f => { if (f) setState(f); })}/></label></span>
      <small className="fine-print">One file in the project for every task, edit and continuation, kept by Girru’s agents, Claude Code, Codex and Gemini. The board shows each task on its department’s board with its agent, and any of them can continue it. {state.tasks?.on ? `${state.tasks.open} open on the board.` : 'Off keeps the file and stops the rule that asks the apps to keep it.'}</small>
      {state.tasks?.on && (state.tasks.problems.length ?? 0) > 0 && <ul className="rules-task-problems">{state.tasks.problems.map(p => <li key={p.line}><UiIcon name="alert" size={12}/>Line {p.line}: {p.message}</li>)}</ul>}
    </div>}
  </Sheet>;
}
