// Settings › Memory (boards M25–M27, M29, M31 J6, M32 K4): the advanced
// memory options moved out of the Memory window. Rules · Folders and drives ·
// Sources · Documents · Projects · Access · Health and backup · Schedule. Each pane reuses
// the controller the old Memory tabs used, so nothing is lost on the way.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useStoreP2, useStoreP3 } from './store-switches';
import type { SessionClient } from './session';
import type {BackgroundMemoryConsentResponse,NativeMemoryProfile} from './memory-encryption-contract.js';
import { MemoryHealthController } from './memory-health';
import { HealthView } from './MemoryHealth';
import { MemoryAccessController } from './memory-access';
import { AccessView } from './MemoryAccess';
import { MemoryBridgeController } from './memory-bridge';
import { BridgeView } from './MemoryBridge';
import { MemoryScopesController } from './memory-scopes';
import { MemoryDesktopController } from './memory-desktop';
import { DiscoveryController } from './discovery-controller';
import { DiscoveryView, FolderTree } from './Discovery';
import { LocalImport } from './LocalImport';
import { FilesView } from './MemoryPlaces';
import { UiIcon } from './ui-icons';
import { MemoryHelperRow } from './MemoryHelper';
import { DocumentsPane } from './MemoryDocuments';
import { Tile, useMenu, ContextMenu, IconButton, Notice, Sheet } from './desktop-ui';
import { OutsideTag, useOutsideProjects, verdictWhy } from './outside-projects';
import type { ProjectGroup } from './memory-desktop-contract.js';
import type { ScopeRules } from './memory-pages-contract.js';

export type MemorySettingsPane = 'rules' | 'folders' | 'sources' | 'documents' | 'projects' | 'access' | 'health' | 'schedule';
export const MEMORY_PANES: ReadonlyArray<{ key: MemorySettingsPane; label: string }> = [
  { key: 'rules', label: 'Rules' }, { key: 'folders', label: 'Folders and drives' }, { key: 'sources', label: 'Sources' }, { key: 'documents', label: 'Documents' }, { key: 'projects', label: 'Projects' },
  { key: 'access', label: 'Access' }, { key: 'health', label: 'Health and backup' }, { key: 'schedule', label: 'Schedule' },
];

function useOnce<T extends { dispose(): void }>(make: () => T, deps: unknown[]): T | undefined {
  const [x, setX] = useState<T>();
  useEffect(() => { const v = make(); setX(v); return () => v.dispose(); }, deps);
  return x;
}
const use = <S,>(c: { subscribe: (f: () => void) => () => void; getSnapshot: () => S } | undefined) =>
  useSyncExternalStore(c?.subscribe ?? (() => () => {}), c?.getSnapshot ?? (() => undefined as S | undefined), c?.getSnapshot ?? (() => undefined as S | undefined));

export function MemorySettings({ client, pane, onOpenMemory }: { client: SessionClient; pane: MemorySettingsPane; onOpenMemory?: () => void }) {
  const health = useOnce(() => new MemoryHealthController(client), [client]);
  const scopes = useOnce(() => new MemoryScopesController(client), [client]);
  const disc = useOnce(() => new DiscoveryController(client), [client]);
  const ss = use(scopes);
  useEffect(() => { if (scopes && !ss?.tree) void scopes.load(); }, [scopes]);
  useEffect(() => { if (disc && (pane === 'folders' || pane === 'projects' || pane === 'schedule' || pane === 'sources')) { if (disc.getSnapshot().phase === 'idle') void disc.load(); if (pane === 'folders' && !disc.getSnapshot().places.top) void disc.loadPlaces(); } }, [disc, pane]);
  const [files, setFiles] = useState(false);
  const title = MEMORY_PANES.find(p => p.key === pane)?.label ?? 'Memory';
  return <section className="mem-settings" aria-label={`Memory: ${title}`}>
    <h3>{title}</h3>
    {pane === 'rules' && health && <RulesPane client={client} health={health} scopes={scopes}/>}
    {pane === 'folders' && disc && <><p className="fine-print">Tick folders, drives or partitions (several at once). Everything inside is read, also new folders. Girru only reads; your files never change. On Windows: C:, D:, E: and USB drives show here the same way.</p><FolderTree c={disc}/></>}
    {pane === 'sources' && <SourcesPane client={client} disc={disc}/>}
    {pane === 'documents' && <DocumentsPane client={client}/>}
    {pane === 'projects' && scopes && disc && <ProjectsPane client={client} scopes={scopes} disc={disc}/>}
    {pane === 'access' && <AccessPane client={client} tree={ss?.tree ?? null}/>}
    {pane === 'health' && health && <>{files ? <><button type="button" className="link-button" onClick={() => setFiles(false)}>Back to Health and backup</button><FilesView client={client} agents={ss?.agents ?? {}} drawers={[{ id: 'owner', name: 'About you' }, { id: 'experience', name: 'Lessons' }, ...(ss?.tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto && !p.trashedAt).map(p => ({ id: `project:${p.slug}`, name: p.name }))]}/></>
      : <><DataJobs client={client}/><MemoryEncryptionStatus client={client}/><MemoryHelperRow client={client}/><HealthLoader c={health} part="health" onReview={onOpenMemory} onFiles={() => setFiles(true)}/></>}</>}
    {pane === 'schedule' && disc && health && <SchedulePane client={client} disc={disc} health={health}/>}
  </section>;
}

function HealthLoader({ c, part, onReview, onFiles }: { c: MemoryHealthController; part: 'health' | 'rules'; onReview?: () => void; onFiles?: () => void }) {
  const s = use(c);
  useEffect(() => { if (s?.phase === 'idle') void c.load('company'); }, [c]);
  return <HealthView c={c} part={part} conflicts={null} onReview={onReview ?? (() => {})} onFiles={onFiles ?? (() => {})}/>;
}

// ---------------------------------------------------------------- Rules
const STANDING = [
  ['Reads the project’s memory and DESIGN.md before it starts', 'colours, logos, fonts, rules, decisions'],
  ['Keeps DESIGN.md in the project up to date', 'written only between Girru’s markers, your text stays'],
  ['Keeps the project’s documents in Girru’s order', 'README for people, DESIGN.md, decisions and handoff notes'],
  ['Saves what it learns in the right project on its own', 'routine facts saved; important or conflicting ones wait in Needs you'],
  ['Follows the design it found', 'never invents colours or logos when the project has them'],
  ['Leaves a handoff note when it stops', 'done, left, next'],
] as const;
/** STORE-MAP-01 P2 (MD4): what agents save, first in the list while the switch is on. */
const SAVE_ROW = ['Saves only what will matter later', 'decisions with their reason, your preferences, facts needed again, lessons; never drafts, small talk or secrets'] as const;
function RulesPane({ client, health, scopes }: { client: SessionClient; health: MemoryHealthController; scopes?: MemoryScopesController }) {
  const s = use(health); const ss = use(scopes);
  const p2 = useStoreP2(client);
  const [scope, setScope] = useState('company');
  // How long Trash keeps things: the company's rules (MEM-TRASH-01).
  const [trashDays, setTrashDays] = useState<number | null>(null);
  useEffect(() => { void health.load(scope); }, [health, scope]);
  useEffect(() => { void (async () => { try { const r = await client.request({ method: 'GET', path: '/api/memory/scopes/rules?scope=company' } as never); if (r.status === 200) setTrashDays((r.body as ScopeRules).effective.trashDays); } catch { /* shown as 30 */ } })(); }, [client]);
  const [saved, setSaved] = useState<string | null>(null);
  async function setTrash(days: number) {
    const before = trashDays; setTrashDays(days);
    try {
      const r = await client.request({ method: 'PUT', path: '/api/memory/scopes/rules', body: { scope: 'company', trashDays: days } } as never);
      if (r.status === 200) setSaved('Saved.'); else { setTrashDays(before); setSaved('Not saved.'); }
    } catch { setTrashDays(before); setSaved('Not saved (no connection).'); }
  }
  const projects = (ss?.tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto);
  return <div className="mem-settings-body">
    <label className="settings-row"><span>Rules for<span className="fine-print">Each project or department can use other rules; the rest use the company's.</span></span>
      <select value={scope} onChange={e => setScope(e.target.value)}><option value="company">The whole company</option>
        {(ss?.tree?.departments ?? []).map(d => <option key={d.id} value={`department:${d.id}`}>Department · {d.name}</option>)}
        {projects.map(p => <option key={p.slug} value={`project:${p.slug}`}>Project · {p.name}</option>)}</select></label>
    {s?.phase === 'ready' ? <HealthView c={health} part="rules" conflicts={null} onReview={() => {}} onFiles={() => {}}/> : <p className="fine-print" role="status">Reading the rules…</p>}
    <h4>Archive or Trash?</h4>
    <div className="mem-two"><div><b><UiIcon name="archive" size={13}/> Archived</b><p className="fine-print">Kept for good, not loaded into replies. For old projects you may need again. Bring back any time.</p></div>
      <div><b><UiIcon name="trash" size={13}/> Trash</b><p className="fine-print">Deleted. Agents no longer read it. Restore within the time below, then it is forgotten for good. Empty Trash forgets now.</p></div></div>
    <label className="settings-row"><span>Forget what is in Trash after<span className="fine-print">Empty Trash is the only action in Memory that asks first, because it cannot be undone.</span></span>
      <select value={trashDays ?? 30} disabled={trashDays === null} onChange={e => void setTrash(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={0}>Never on its own</option></select></label>
    {saved && <p className="fine-print" role="status">{saved}</p>}
    <details className="preference-help"><summary>Default project behaviour</summary><h4>What every agent does in a project, without being told</h4>
    <p className="fine-print">This comes with Girru’s skill for every agent and coding app. It is on for all projects; you never have to remind it.</p>
    <ul className="mem-standing">{(p2 ? [SAVE_ROW, ...STANDING] : STANDING).map(([a, b]) => <li key={a}><UiIcon name="check" size={13}/><span><b>{a}</b><span className="fine-print">{b}</span></span></li>)}</ul>
    <p className="fine-print">DESIGN.md is written into each project folder (only between Girru's markers). Switch it off per project in Memory › the project › Design.</p></details>
  </div>;
}

// ---------------------------------------------------------------- Sources
function SourcesPane({ client, disc }: { client: SessionClient; disc?: DiscoveryController }) {
  const [tab, setTab] = useState<'computer' | 'conversations' | 'apps'>('computer');
  const bridge = useOnce(() => new MemoryBridgeController(client), [client]);
  useEffect(() => { if (tab === 'apps' && bridge) void bridge.load(); }, [tab, bridge]);
  return <div className="mem-settings-body">
    <p className="fine-print">Choose where memory comes from. Automatic memory import follows the setting below; other discoveries wait for review.</p>
    <div className="dk-segmented" role="group" aria-label="Sources">{([['computer', 'On this computer'], ['conversations', 'Conversations'], ['apps', 'Coding apps']] as const).map(([v, l]) => <button key={v} type="button" aria-pressed={tab === v} onClick={() => setTab(v)}>{l}</button>)}</div>
    {tab === 'computer' && <AutomaticMemoryImport client={client}/>}
    {tab === 'computer' && disc && <><DiscoveryView c={disc} active kinds={['memory', 'note', 'tool', 'design', 'database']} noFolders/>
      <p className="fine-print">Skills, MCP servers and SSH hosts found by the same scan go to their own sections (Skills, MCP connections, Terminal), not here. Folders: Settings › Memory › Folders and drives.</p></>}
    {tab === 'conversations' && <LocalImport client={client} active onReview={() => {}}/>}
    {tab === 'apps' && bridge && <><p className="fine-print">When you allow memory from this computer, Girru connects the coding apps it finds. They read the memory of the project they work in and can only suggest new memories. Per project: right-click a project in Settings › Projects.</p><BridgeView c={bridge}/></>}
  </div>;
}

// ---------------------------------------------------------------- Projects
function ProjectsPane({ client, scopes, disc }: { client: SessionClient; scopes: MemoryScopesController; disc: DiscoveryController }) {
  const ss = use(scopes); const ds = use(disc);
  const desk = useOnce(() => new MemoryDesktopController(client), [client]);
  const dk = use(desk);
  const menu = useMenu();
  useEffect(() => { if (desk) void desk.loadGroups(); }, [desk]);
  // REPO-TRUST-01 (board R1): someone else's repositories are listed apart, under the owner's projects.
  const trust = useOutsideProjects(client);
  const [toast, setToast] = useState<{ id: number; text: string; undo: boolean } | null>(null);
  const undo = useRef<(() => Promise<void>) | null>(null);
  const [adding, setAdding] = useState(false);
  const trustIdOf = (p: { slug: string; name: string }) => trust?.getSnapshot().view?.projects.find(v => v.projectId === p.slug)?.projectId
    ?? trust?.getSnapshot().view?.projects.find(v => v.name === p.name)?.projectId ?? null;
  async function setOutside(id: string, name: string, outside: boolean) {
    const u = await trust?.set(id, outside);
    if (!u) { setToast({ id: Date.now(), text: 'Not changed. Try again.', undo: false }); return; }
    undo.current = u;
    setToast({ id: Date.now(), text: outside ? `${name} is on Outside projects` : `${name} is trusted`, undo: true });
  }
  const outsideList = (trust?.getSnapshot().view?.projects ?? []).filter(v => v.outside);
  const projects = (ss?.tree?.projects ?? []).filter(p => !p.archived && !p.mergedInto && !trust?.isOutside(trustIdOf(p)));
  const groups: readonly ProjectGroup[] = Array.isArray(dk?.groups) ? dk!.groups as readonly ProjectGroup[] : [];
  const roots = ds?.view?.roots ?? [];
  const foldersOf = (slug: string, name: string) => roots.filter(r => (r.project ?? '').toLowerCase() === slug || r.name.toLowerCase() === name.toLowerCase());
  const row = (p: typeof projects[number]) => {
    const rs = foldersOf(p.slug, p.name);
    return <li key={p.slug} className="mem-project" onContextMenu={e => menu.at(e, [
      ...groups.filter(g => !g.projects.includes(p.slug)).map(g => ({ label: `Move to ${g.name}`, icon: 'group' as const, run: () => void desk?.moveToGroup(p.slug, g.id) })),
      ...(rs.some(r => r.group) ? [{ label: 'Separate…', icon: 'diff' as const, run: () => { const r = rs.find(x => x.group); if (r) void disc.separate(r.id); } }] : []),
      ...(rs.length ? [{ label: 'Merge with another folder…', icon: 'folder' as const, run: () => disc.startMerge([rs[0].id], p.name) }] : []),
      ...(trustIdOf(p) ? ['sep' as const, { label: 'Put on Outside projects', icon: 'shield' as const, run: () => void setOutside(trustIdOf(p)!, p.name, true) }] : []),
    ])}>
      <Tile name={p.name}/><span className="mem-project-name"><b>{p.name}</b><span className="fine-print">{p.memories} memories</span></span>
      <span className="mem-project-folders">{rs.length ? rs.flatMap(r => r.group ? r.group.members.map(m => <span key={m.id} className="fine-print dk-path" title={m.path}>{m.path} · joined by you</span>) : [<span key={r.id} className="fine-print dk-path" title={r.path ?? ''}>{r.path ?? r.name} · {r.path ? 'this computer' : 'older computer · no folder here'}</span>]) : <span className="fine-print">no folder found yet</span>}</span>
    </li>;
  };
  const grouped = new Set(groups.flatMap(g => g.projects));
  const sugg = ds?.view?.suggestions ?? [];
  return <div className="mem-settings-body">
    <p className="fine-print">Groups of projects (a client, a team) and which folders make one project. Girru joins folders by git or the same name, or you join them; it asks when not sure. Drag projects between groups in the Memory sidebar.</p>
    {sugg.map(s => <div key={s.key} className="dk-ask"><p>Same project? <b>{s.a.name}</b> and <b>{s.b.name}</b>{s.reason ? <span className="fine-print"> · {s.reason}</span> : null}</p>
      <div className="actions"><button type="button" className="primary" onClick={() => disc.startMerge([s.a.id, s.b.id], s.a.name)}>Join</button><button type="button" onClick={() => void disc.dismissSuggestion(s)}>Not the same</button></div></div>)}
    {ds?.merge && <div className="dk-ask"><label className="dk-field">One project named<input value={ds.merge.name} onChange={e => disc.setMerge({ name: e.target.value })}/></label>
      <label className="dk-field">With folder<select value="" onChange={e => { if (e.target.value) disc.setMerge({ ids: [...ds.merge!.ids, e.target.value] }); }}><option value="">Add a folder…</option>{roots.filter(r => r.id !== 'computer' && !ds.merge!.ids.includes(r.id)).map(r => <option key={r.id} value={r.id}>{r.name}{r.path ? ` · ${r.path}` : ''}</option>)}</select></label>
      <p className="fine-print">{ds.merge.ids.length} folders. The folders stay where they are; their memory is kept together.</p>
      <div className="actions"><button type="button" onClick={() => disc.cancelMerge()}>Cancel</button><button type="button" className="primary" disabled={ds.merge.ids.length < 2 || !ds.merge.name.trim()} onClick={() => void disc.merge()}>Join</button></div></div>}
    {ds?.result && <p className="fine-print" role="status">{ds.result}</p>}
    {groups.map(g => <section key={g.id} className="mem-group"><h4><Tile name={g.name}/>{g.name}{g.label ? <span className="fine-print"> · {g.label}</span> : null}</h4><ul className="mem-projects">{projects.filter(p => g.projects.includes(p.slug)).map(row)}</ul></section>)}
    <section className="mem-group">{groups.length > 0 && <h4>Not in a group</h4>}<ul className="mem-projects">{projects.filter(p => !grouped.has(p.slug)).map(row)}</ul></section>
    {dk?.groups === 'missing' && <p className="fine-print">Groups of projects arrive with the next backend update.</p>}
    <p className="fine-print">Right-click a project: Move to group · Merge with another folder · Separate · Put on Outside projects.</p>
    {trust && !trust.getSnapshot().off && <section className="mem-group outside-group" aria-label="Outside projects">
      <h4><UiIcon name="shield" size={14}/>Outside projects</h4>
      <p className="fine-print">Someone else’s repositories. Their files are read as data only and rank below your memory; they never become rules or pinned facts, coding apps get no memory there, and tasks from their task file wait for you once.</p>
      {outsideList.length ? <ul className="mem-projects">{outsideList.map(v => <li key={v.projectId} className="mem-project outside-row" onContextMenu={e => menu.at(e, [{ label: 'Trust it', icon: 'check', run: () => void setOutside(v.projectId, v.name ?? 'Project', false) }])}>
        <Tile name={v.name ?? 'Project'}/><span className="mem-project-name"><b>{v.name ?? 'Project'}<OutsideTag store={trust} projectId={v.projectId}/></b><span className="fine-print">{verdictWhy(v)}</span></span>
        <span className="outside-actions"><button type="button" onClick={() => void setOutside(v.projectId, v.name ?? 'Project', false)}>Trust it</button></span>
      </li>)}</ul> : <p className="fine-print">None. A project whose folder is someone else’s repository shows here by itself.</p>}
      <p className="fine-print outside-accounts">Your accounts: {(trust.getSnapshot().view?.owners ?? []).map((o, i) => <span key={`${o.host}/${o.name}`}>{i ? ' · ' : ''}<b title={o.host}>{o.name}</b>{!o.builtIn && <IconButton icon="close" label={`Stop counting ${o.name} as yours`} onClick={() => void trust.removeAccount(o.name, o.host)}/>}</span>)} · <button type="button" className="link-button" onClick={() => setAdding(true)}>Add an account…</button></p>
    </section>}
    {adding && trust && <AddAccountSheet onClose={() => setAdding(false)} onAdd={async (name, host) => { setAdding(false); if (!(await trust.addAccount(name, host))) setToast({ id: Date.now(), text: 'Not added. Use a name like my-org (letters, numbers, - _ .).', undo: false }); }}/>}
    <Notice toast={toast} onUndo={() => { void undo.current?.(); undo.current = null; setToast(null); }} onDone={id => setToast(t => (t?.id === id ? null : t))}/>
    <ContextMenu menu={menu.menu} onClose={menu.close}/>
  </div>;
}

// ---------------------------------------------------------------- Access
function AccessPane({ client, tree }: { client: SessionClient; tree: import('./memory-pages-contract.js').ScopeTree | null }) {
  const access = useOnce(() => new MemoryAccessController(client), [client]);
  const [scope, setScope] = useState('company');
  useEffect(() => { if (access) void access.load(scope); }, [access, scope]);
  return <div className="mem-settings-body">
    <p className="fine-print">Which agents may read and change memory. Agents inherit their department's rules; exceptions are listed here. Changes show a preview before they apply. Always true: outside senders never read private memory; an agent never gets more than the agent that gave it the task.</p>
    <label className="settings-row"><span>For</span><select value={scope} onChange={e => setScope(e.target.value)}><option value="company">The whole company</option>
      {(tree?.departments ?? []).map(d => <option key={d.id} value={`department:${d.id}`}>Department · {d.name}</option>)}
      {(tree?.projects ?? []).filter(p => !p.archived).map(p => <option key={p.slug} value={`project:${p.slug}`}>Project · {p.name}</option>)}</select></label>
    {access && <AccessView c={access} scope={scope} tree={tree}/>}
  </div>;
}

// ---------------------------------------------------------------- Schedule
function SchedulePane({ client, disc, health }: { client: SessionClient; disc: DiscoveryController; health: MemoryHealthController }) {
  const ds = use(disc); const hs = use(health);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => { if (hs?.phase === 'idle') void health.load('company'); }, [health]);
  const v = ds?.view; const id = hs?.importDraft;
  return <div className="mem-settings-body">
    <p className="fine-print">One place for everything Girru does on its own. (Was set in three places before: Health, Project files, Found on this computer.)</p>
    <label className="settings-row"><span>Read this computer again<span className="fine-print">finds new and changed files; imports nothing on its own</span></span>
      <select value={v ? (v.settings.watch ? v.settings.intervalMinutes : 0) : 0} disabled={!v} onChange={e => { const n = Number(e.target.value); void disc.setWatch(n > 0, (n || v!.settings.intervalMinutes) as 15 | 30 | 60); }}>
        <option value={0}>Only when I scan</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every 60 minutes</option></select></label>
    <AutomaticMemoryImport client={client}/>
    <label className="settings-row"><span>Import from other agents' conversations</span>
      <select value={id ? (id.enabled ? id.intervalMinutes : 0) : 0} disabled={!id} onChange={e => { const n = Number(e.target.value); health.editImport(n ? { enabled: true, intervalMinutes: n as 15 | 30 | 60 } : { enabled: false }); void health.saveRules().then(() => setNote('Saved.')); }}>
        <option value={0}>Off</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every 60 minutes</option></select></label>
    <p className="fine-print">The weekly summary time is in Rules.</p>
    {(note || ds?.result) && <p className="fine-print" role="status">{note ?? ds?.result}</p>}
  </div>;
}


type AutomaticSettings = {
  enabled: boolean; intervalMinutes: 15 | 30 | 60; status?: string;
  lastImported?: number; lastProposed?: number; notice?: string;
};

function AutomaticMemoryImport({ client }: { client: SessionClient }) {
  const [settings, setSettings] = useState<AutomaticSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (busy) return;
    let live = true;
    async function load() {
      try {
        const response = await client.request({ method: 'GET', path: '/api/memory/import/local/automatic' } as never);
        if (!live) return;
        if (response.status !== 200) { setError('Automatic import settings are unavailable.'); return; }
        setSettings((response.body as { settings: AutomaticSettings }).settings);
        setError(null);
      } catch { if (live) setError('Cannot connect to automatic import.'); }
    }
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => { live = false; clearInterval(timer); };
  }, [client, busy]);
  async function save(value: number) {
    if (!settings || busy) return;
    setBusy(true); setSaveError(null);
    try {
      const response = await client.request({ method: 'PUT', path: '/api/memory/import/local/automatic', body: {
        enabled: value > 0, intervalMinutes: value || settings.intervalMinutes,
      } } as never);
      if (response.status === 200) setSettings((response.body as { settings: AutomaticSettings }).settings);
      else setSaveError('Not saved. Your previous setting is unchanged.');
    } catch { setSaveError('Not saved. Check the connection and try again.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Automatic memory import">
    <label className="settings-row"><span>Automatically import memory files<span className="fine-print">Find recognized memory and project notes across accessible folders and connected drives, including hidden coding-app folders. Save memory automatically; project notes use the local model. Source files stay unchanged.</span></span>
      <select disabled={!settings || busy} value={settings?.enabled ? settings.intervalMinutes : 0} onChange={e => void save(Number(e.target.value))}>
        <option value={0}>Off</option><option value={15}>Every 15 minutes</option><option value={30}>Every 30 minutes</option><option value={60}>Every 60 minutes</option>
      </select></label>
    <p className="fine-print">Skills, MCP connections and SSH identities are discovered separately. Importing memory does not enable them or copy private SSH keys.</p>
    <p className="fine-print" role="status">{saveError ?? error ?? (settings ? settings.notice || (settings.enabled ? `Automatic import: ${settings.status ?? 'idle'}.` : 'Automatic import is off.') : 'Loading automatic import settings…')}</p>
  </section>;
}

const JOB_LABEL: Readonly<Record<string, { icon: 'database' | 'history'; label: string }>> = {
  vectors: { icon: 'database', label: 'Faster memory search (smaller stored vectors)' },
  sources: { icon: 'history', label: 'Where each memory came from' },
};
/**
 * STORE-MAP-01 P3 (FD4d): long data jobs after an update run in the background
 * and never block Girru; one quiet part here while any is not done.
 */
function DataJobs({ client }: { client: SessionClient }) {
  const p3 = useStoreP3(client);
  const [jobs, setJobs] = useState<Array<{ id: string; done: number; total: number }> | null>(null);
  useEffect(() => {
    if (!p3) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const r = await client.request({ method: 'GET', path: '/api/memory/scopes/jobs' } as never);
        if (!live) return;
        const list = r.status === 200 ? (r.body as { jobs: Array<{ id: string; done: number; total: number }> }).jobs : [];
        setJobs(list);
        if (list.some(j => j.done < j.total)) timer = setTimeout(() => void read(), 5000);
      } catch { /* shown as nothing */ }
    };
    void read();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [client, p3]);
  if (!p3 || !jobs?.length || jobs.every(j => j.done >= j.total)) return null;
  return <section className="mem-jobs" aria-label="Data jobs after the update"><h4>Data jobs after the update</h4>
    <ul>{jobs.map(j => <li key={j.id}><UiIcon name={JOB_LABEL[j.id]?.icon ?? 'database'} size={14}/><span>{JOB_LABEL[j.id]?.label ?? j.id}</span>
      <span className="fine-print">{j.done >= j.total ? 'Done' : `${j.total ? Math.floor((j.done / j.total) * 100) : 0} % · resumes after a restart`}</span></li>)}</ul>
    <p className="fine-print">Girru works normally meanwhile; a job reads the old layout until it finishes.</p></section>;
}

/** REPO-TRUST-01: an account (or group) whose repositories count as the owner's own. */
function AddAccountSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string, host: string) => void }) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('github.com');
  const ok = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,4}$/.test(name.trim()) && !name.includes('..') && /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host.trim());
  return <Sheet title="An account of yours" onClose={onClose} actions={<><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary" disabled={!ok} onClick={() => onAdd(name.trim(), host.trim().toLowerCase())}>Add</button></>}>
    <label className="dk-field">Account or group<input autoFocus value={name} placeholder="my-org" onChange={e => setName(e.target.value)}/></label>
    <label className="dk-field">Site<input value={host} onChange={e => setHost(e.target.value)}/></label>
    <p className="fine-print">Repositories of this account on this site count as yours: they are not put on Outside projects.</p>
  </Sheet>;
}


function MemoryEncryptionStatus({client}:{client:SessionClient}){
 const [status,setStatus]=useState<'loading'|'unavailable'|'prepared'|'locked'>('loading');
 const [ids,setIds]=useState<string[]>([]),[review,setReview]=useState<{id:string;kind:'addition'|'conflict'|'import';entries?:Array<{content:string;type:string;importance:number}>;before:string|null;reviewHash:string;content:string;type:string;importance:number}|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const [importText,setImportText]=useState('');
 const [graphMemories,setGraphMemories]=useState<Array<{id:string;label:string}>>([]);
 const revision=useRef(0);useEffect(()=>()=>{revision.current++;},[client]);
 const request=async(path:string,body?:unknown)=>{const at=++revision.current;setBusy(true);setNotice('');try{const response=await client.request((body===undefined?{method:'GET',path}:{method:'POST',path,body}) as never);if(at!==revision.current)return;if(response.status!==200)throw Error('Unavailable');if(path.endsWith('/decision')){const result=response.body as {memoryId?:string;memoryIds?:string[]};const accepted=result.memoryIds??(result.memoryId?[result.memoryId]:[]);if(accepted.length)setGraphMemories(accepted.map((id,index)=>({id,label:(review?.entries?.[index]?.content??review?.content??'Approved memory').replace(/\s+/g,' ').slice(0,120)})));setReview(null);setIds(current=>current.filter(id=>!path.includes('/'+id+'/')));setNotice('Decision saved.');}else if(path.endsWith('/import')){setImportText('');setReview(null);setIds(current=>[...new Set([...current,(response.body as {proposalId:string}).proposalId])]);setNotice('Encrypted import queued. Open the proposal and review all additions.');}else if(path.endsWith('/proposals')){setReview(null);setIds((response.body as {ids:string[]}).ids);}else setReview(response.body as NonNullable<typeof review>);}catch{if(at===revision.current){setReview(null);setNotice('Review unavailable. Reload the proposal before deciding.');}}finally{if(at===revision.current)setBusy(false);}};
 useEffect(()=>{let live=true;setStatus('loading');setImportText('');setGraphMemories([]);setIds([]);setReview(null);setNotice('');setBusy(false);void client.request({method:'GET',path:'/api/memory/encryption/status'} as never).then(response=>{
  if(!live)return;const body=response.body as {state?:string;activationReady?:boolean};
  setStatus(response.status!==200||body.activationReady!==false?'unavailable':body.state==='ready'?'prepared':'locked');
 }).catch(()=>{if(live)setStatus('unavailable');});return()=>{live=false;};},[client]);
 return <section className="mem-jobs" aria-label="Memory encryption"><h4>Memory encryption</h4><NativeMemoryProfiles client={client}/><BackgroundMemoryConsent client={client}/><p className="fine-print">{status==='loading'?'Reading encryption availability…':status==='prepared'?'Prepared on the explicitly selected profile. Activation is not available yet.':status==='locked'?'The selected encrypted memory session is locked or unavailable.':'Encryption is not available for this profile yet.'}</p>
  {status==='prepared'&&<><EncryptedDocumentStatus client={client}/><EncryptedDocumentImport client={client}/><label>Import text for encrypted review<textarea aria-label="Text for encrypted memory review" value={importText} maxLength={512*1024} disabled={busy} onChange={event=>setImportText(event.target.value)}/></label><button type="button" disabled={busy||!importText.trim()} onClick={()=>void request('/api/memory/encryption/import',{text:importText,format:'text',drawer:'owner'})}>Queue text for review</button><button type="button" className="link-button" disabled={busy} onClick={()=>void request('/api/memory/encryption/proposals')}>Review pending memories</button>
   {ids.length>0&&<ul>{ids.map(id=><li key={id}><button type="button" className="link-button" disabled={busy} onClick={()=>void request('/api/memory/encryption/proposals/'+encodeURIComponent(id))}>Open proposal {id}</button></li>)}</ul>}
   {review&&<section aria-label="Reviewed memory change">{review.kind==='conflict'&&<><h5>Existing memory</h5><p style={{whiteSpace:'pre-wrap'}}>{review.before}</p><h5>Proposed memory</h5></>}{review.kind==='import'?<><h5>{review.entries?.length} imported additions</h5>{review.entries?.map((entry,index)=><div key={index}><p className="fine-print">{entry.type} · Importance {entry.importance}</p><p style={{whiteSpace:'pre-wrap'}}>{entry.content}</p></div>)}</>:<><p className="fine-print">{review.type} · Importance {review.importance}</p><p style={{whiteSpace:'pre-wrap'}}>{review.content}</p></>}
    <button type="button" disabled={busy} onClick={()=>void request('/api/memory/encryption/proposals/'+encodeURIComponent(review.id)+'/decision',{decision:'approve',reviewHash:review.reviewHash})}>{review.kind==='conflict'?'Keep proposed memory':review.kind==='import'?'Approve all imported additions':'Approve addition'}</button>{' '}
    <button type="button" disabled={busy} onClick={()=>void request('/api/memory/encryption/proposals/'+encodeURIComponent(review.id)+'/decision',{decision:'reject',reviewHash:review.reviewHash})}>{review.kind==='conflict'?'Keep existing memory':review.kind==='import'?'Reject import':'Reject addition'}</button>
   </section>}
   {graphMemories.length>0&&<EncryptedGraphReview client={client} memories={graphMemories}/>}
  </>}{notice&&<p role="status" className="fine-print">{notice}</p>}</section>;
}


function NativeMemoryProfiles({client}:{client:SessionClient}){
 const [profiles,setProfiles]=useState<NativeMemoryProfile[]>([]),[source,setSource]=useState<{sourceId:string;name:string;mode:string}|null>(null),[prepared,setPrepared]=useState<(NativeMemoryProfile&{reviewNonce:string})|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[available,setAvailable]=useState<boolean|null>(null);const revision=useRef(0);
 const invoke=async(action:'profiles'|'select-source-copy'|'prepare-new-profile'|'activate-profile',body?:unknown)=>{const response=await client.request((action==='profiles'?{method:'GET',path:'/api/memory/encryption/native/profiles'}:{method:'POST',path:'/api/memory/encryption/native/'+action,body}) as never);if(response.status!==200)throw Error('Native preparation unavailable');return response.body;};
 const refresh=async()=>{const at=++revision.current;setBusy(true);setNotice('');try{const rows=await invoke('profiles');if(at!==revision.current)return;if(!Array.isArray(rows))throw Error('Invalid profile list');setProfiles(rows as NativeMemoryProfile[]);setAvailable(true);}catch{if(at===revision.current){setAvailable(false);setNotice('Native encrypted-profile preparation is unavailable on this host.');}}finally{if(at===revision.current)setBusy(false);}};
 useEffect(()=>{setProfiles([]);setSource(null);setPrepared(null);setAvailable(null);void refresh();return()=>{revision.current++;};},[client]);
 const choose=async()=>{const at=++revision.current;setBusy(true);setNotice('');setSource(null);setPrepared(null);try{const selected=await invoke('select-source-copy',{}) as {sourceId:string;name:string;mode:string};if(at===revision.current){setSource(selected);setAvailable(true);setNotice('Copy selected. Preparation still requires a new private destination and native confirmation.');}}catch{if(at===revision.current)setNotice('No verified copy was selected. Existing profiles were not enrolled.');}finally{if(at===revision.current)setBusy(false);}};
 const prepare=async(sourceId:string|null)=>{const at=++revision.current;setBusy(true);setNotice('');setPrepared(null);try{const result=await invoke('prepare-new-profile',{sourceId}) as NativeMemoryProfile&{reviewNonce:string};if(at===revision.current){setPrepared(result);setProfiles(rows=>[...rows.filter(row=>row.profileId!==result.profileId),result]);setAvailable(true);setNotice('Profile prepared. Review and activate it separately; preparation does not switch the current workspace.');}}catch{if(at===revision.current)setNotice('Preparation did not complete. The profile remains unavailable until native verification succeeds.');}finally{if(at===revision.current)setBusy(false);}};
 const activate=async(profile:NativeMemoryProfile&{reviewNonce:string}|null=prepared)=>{if(!profile)return;const at=++revision.current,request={profileId:profile.profileId,reviewNonce:profile.reviewNonce};setBusy(true);setNotice('');setPrepared(null);try{const result=await invoke('activate-profile',request) as {profileId:string;state:'active'};if(at===revision.current){setProfiles(rows=>rows.map(row=>row.profileId===result.profileId?{...row,state:'active',activationReady:true,reviewNonce:undefined}:row));setNotice('Encrypted profile activated after native verification.');}}catch{if(at===revision.current)setNotice('Activation was refused or interrupted. The one-use review must be renewed in native preparation.');}finally{if(at===revision.current)setBusy(false);}};
 return <section aria-label="Encrypted profile preparation"><h5>Private encrypted profiles</h5><p className="fine-print">Prepare a new empty profile or select an explicitly prepared copy. The desktop chooses private folders and asks for confirmation. Existing profiles are not selected automatically.</p><button type="button" className="link-button" disabled={busy} onClick={()=>void refresh()}>{busy?'Working…':'Refresh profiles'}</button>{available&&<><button type="button" disabled={busy} onClick={()=>void prepare(null)}>Prepare empty profile</button>{' '}<button type="button" disabled={busy} onClick={()=>void choose()}>Choose prepared copy</button>{source&&<p className="fine-print">Selected copy: {source.name} · {source.mode==='plaintext-fresh-owner-reimport'?'New-content reimport requires owner approval':'Current encrypted authority and custody must be preserved'} <button type="button" disabled={busy} onClick={()=>void prepare(source.sourceId)}>Prepare from this copy</button></p>}</>}{profiles.length>0&&<ul>{profiles.map(profile=><li key={profile.profileId}>{profile.name} · {profile.state==='requires-native-revalidation'?'Requires native revalidation':profile.state}{profile.state==='requires-native-revalidation'&&profile.reviewNonce&&<button type="button" disabled={busy} onClick={()=>void activate({...profile,reviewNonce:profile.reviewNonce!})}>Review and resume</button>}{profile.profileId===prepared?.profileId&&<button type="button" disabled={busy} onClick={()=>void activate()}>Review and activate</button>}</li>)}</ul>}{notice&&<p role="status" className="fine-print">{notice}</p>}</section>;
}


function EncryptedDocumentStatus({client}:{client:SessionClient}){
 const [value,setValue]=useState<{documentsNeedOwnerReimport:boolean;pendingImports:number;sources:Array<{id:string;kind:string;refId:string;files:number;chunks:number;documentsNeedOwnerReimport:boolean;invalidatedFileCount:number;invalidatedChunkCount:number}>}|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');const revision=useRef(0);
 const refresh=async()=>{const at=++revision.current;setBusy(true);setValue(null);setNotice('');try{const response=await client.request({method:'GET',path:'/api/memory/encryption/documents/status'} as never);if(at!==revision.current)return;if(response.status!==200)throw Error('Unavailable');setValue(response.body as NonNullable<typeof value>);}catch{if(at===revision.current)setNotice('Document review status is unavailable.');}finally{if(at===revision.current)setBusy(false);}};
 useEffect(()=>{void refresh();return()=>{revision.current++;};},[client]);
 return <section aria-label="Encrypted document review status"><h5>Indexed documents</h5>{value?.documentsNeedOwnerReimport&&<p role="status">Documents need a new owner review. Forgetting a memory cleared their derived index and earlier import approvals. Source files were kept.</p>}{value&&<><p className="fine-print">{value.pendingImports} document imports waiting for review. Documents are indexed only after an explicit new-content approval.</p>{value.sources.some(source=>source.documentsNeedOwnerReimport)&&<ul>{value.sources.filter(source=>source.documentsNeedOwnerReimport).map(source=><li key={source.id}>{source.kind}: {source.refId} · {source.invalidatedFileCount} files and {source.invalidatedChunkCount} chunks need review</li>)}</ul>}</>}<button type="button" className="link-button" disabled={busy} onClick={()=>void refresh()}>{busy?'Reading document status…':'Refresh document status'}</button>{notice&&<p role="status" className="fine-print">{notice}</p>}</section>;
}


type EncryptedDocumentPreview={admissionId:string;reviewHash:string;state:string;file:string;bytes:number;pages:number|null;unreadable:string|null;contents:Array<{heading:string|null;page:number|null;text:string}>;confirmation:string};
function EncryptedDocumentImport({client}:{client:SessionClient}){
 const [preview,setPreview]=useState<EncryptedDocumentPreview|null>(null),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false),[notice,setNotice]=useState('');const revision=useRef(0);
 useEffect(()=>()=>{revision.current++;},[client]);
 const request=async(path:string,body:unknown)=>{const result=await client.request({method:'POST',path,body} as never);if(result.status!==200)throw Error('Unavailable');return result.body;};
 const choose=async()=>{const at=++revision.current;setBusy(true);setPreview(null);setConfirmed(false);setNotice('');try{const picked=await request('/api/memory/encryption/native/pick-document',{}) as {fileId:string;name:string};if(at!==revision.current)return;const result=await request('/api/memory/encryption/document-imports',{fileId:picked.fileId}) as EncryptedDocumentPreview;if(at===revision.current)setPreview(result);}catch{if(at===revision.current)setNotice('Document selection or preview did not complete. No document was indexed.');}finally{if(at===revision.current)setBusy(false);}};
 const decide=async(decision:'approve'|'reject')=>{if(!preview||decision==='approve'&&!confirmed)return;const at=++revision.current,selected=preview;setBusy(true);setNotice('');try{await request('/api/memory/encryption/document-imports/'+encodeURIComponent(selected.admissionId)+'/decision',{decision,reviewHash:selected.reviewHash,...(decision==='approve'?{confirmation:selected.confirmation}:{})});if(at===revision.current){setPreview(null);setConfirmed(false);setNotice(decision==='approve'?'The reviewed document snapshot was indexed. Later file changes require another review.':'Document import rejected.');}}catch{if(at===revision.current){setPreview(null);setConfirmed(false);setNotice('Document decision was refused. Select the file again to obtain a current review.');}}finally{if(at===revision.current)setBusy(false);}};
 return <section aria-label="Import an encrypted document"><h5>Review a document snapshot</h5><p className="fine-print">Choose a project or agent and a document in the desktop dialog. Only the approved snapshot is imported; existing files are not indexed automatically.</p><button type="button" disabled={busy} onClick={()=>void choose()}>{busy?'Working…':'Choose document'}</button>{preview&&<><h5>{preview.file}</h5><p className="fine-print">{preview.bytes} bytes{preview.pages!==null?' · '+preview.pages+' pages':''}</p>{preview.unreadable&&<p role="status">The document could not be extracted: {preview.unreadable}</p>}<div style={{maxHeight:320,overflow:'auto'}}>{preview.contents.map((chunk,index)=><article key={index}>{chunk.heading&&<h6>{chunk.heading}</h6>}{chunk.page!==null&&<p className="fine-print">Page {chunk.page}</p>}<p style={{whiteSpace:'pre-wrap'}}>{chunk.text}</p></article>)}</div><label><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)}/> Import this displayed content as new owner content. Earlier forget decisions are not reversed.</label><button type="button" disabled={busy||!confirmed||preview.unreadable!==null} onClick={()=>void decide('approve')}>Approve document snapshot</button>{' '}<button type="button" disabled={busy} onClick={()=>void decide('reject')}>Reject</button></>}{notice&&<p role="status" className="fine-print">{notice}</p>}</section>;
}


function EncryptedGraphReview({client,memories}:{client:SessionClient;memories:Array<{id:string;label:string}>}){
 const [review,setReview]=useState<{memoryId:string;reviewHash:string;entities:Array<{name:string;kind:string;aliases?:string[]}>;links:Array<{from:string;to:string;type:string}>}|null>(null),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 const generation=useRef(0);useEffect(()=>{generation.current++;setReview(null);setNotice('');setBusy(false);return()=>{generation.current++;};},[client,memories]);
 const request=async(id:string,decision?:'approve'|'reject')=>{const at=++generation.current,selected=review;setBusy(true);setNotice('');try{
  if(decision&&(!selected||selected.memoryId!==id))throw Error('Review required');const path='/api/memory/encryption/graph/'+encodeURIComponent(id)+(decision?'/decision':'');
  const response=await client.request((decision?{method:'POST',path,body:{decision,reviewHash:selected!.reviewHash}}:{method:'GET',path}) as never);if(at!==generation.current)return;if(response.status!==200)throw Error('Unavailable');
  if(decision){setReview(null);setNotice(decision==='approve'?'Relationships approved for encrypted recall.':'Relationships excluded from encrypted recall.');}else setReview(response.body as NonNullable<typeof review>);
 }catch{if(at===generation.current){setReview(null);setNotice('Relationship review unavailable. Open it again before deciding.');}}finally{if(at===generation.current)setBusy(false);}};
 return <section aria-label="Encrypted relationship review"><h5>Review memory relationships</h5><p className="fine-print">Only relationships you approve are used by the encrypted graph search.</p>
  <ul>{memories.map(memory=><li key={memory.id}><button type="button" className="link-button" disabled={busy} onClick={()=>void request(memory.id)}>{memory.label||'Approved memory'}</button></li>)}</ul>
  {review&&<><ul>{review.entities.map(entity=><li key={entity.name}>{entity.name} · {entity.kind}{entity.aliases?.length?' · Also named: '+entity.aliases.join(', '):''}</li>)}</ul><ul>{review.links.map((link,index)=><li key={index}>{link.from} → {link.type.replace(/_/g,' ')} → {link.to}</li>)}</ul>
   <button type="button" disabled={busy} onClick={()=>void request(review.memoryId,'approve')}>Approve displayed relationships</button>{' '}<button type="button" disabled={busy} onClick={()=>void request(review.memoryId,'reject')}>Exclude relationships</button>
  </>}{notice&&<p className="fine-print" role="status">{notice}</p>}
 </section>;
}

function BackgroundMemoryConsent({client}:{client:SessionClient}){
 const [choices,setChoices]=useState<Array<{kind:'task'|'agent-cron';id:string;label:string}>>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[ready,setReady]=useState(false);const revision=useRef(0);
 useEffect(()=>()=>{revision.current++;},[]);
 const request=async(method:'GET'|'POST',suffix:string,body?:unknown)=>{const response=await client.request({method,path:'/api/memory/encryption/native/'+suffix,...(body===undefined?{}:{body})} as never);if(response.status!==200)throw Error('Background consent unavailable');return response.body as BackgroundMemoryConsentResponse;};
 const status=(result:BackgroundMemoryConsentResponse)=>{if(result.state==='waiting-owner-unlock')return 'Unlock the selected encrypted profile before reviewing background access.';if(result.state==='unsupported-legacy-layout')return 'Background access is unavailable for this profile layout. Prepare or resume a supported private profile first.';return '';};
 const refresh=async()=>{const at=++revision.current;setBusy(true);setReady(false);setNotice('');setChoices([]);setSelected('');try{const result=await request('GET','background-definitions');if(at!==revision.current)return;if(result.state==='ready'){setChoices(result.definitions);setReady(true);setNotice(result.definitions.length?'Choose an existing task or agent schedule to review.':'No eligible local task or agent schedule is available.');}else setNotice(status(result));}catch{if(at===revision.current)setNotice('Background access is unavailable. No permission was granted.');}finally{if(at===revision.current)setBusy(false);}};
 const approve=async()=>{const choice=choices.find(row=>row.kind+':'+row.id===selected);if(!choice)return;const at=++revision.current;setBusy(true);setNotice('');try{const result=await request('POST','background-approve',{kind:choice.kind,id:choice.id});if(at!==revision.current)return;setNotice(result.state==='approved'?`Background access approved while the profile stays unlocked.${'bound' in result&&'waiting' in result?` ${result.bound} queued runs linked; ${result.waiting} still need review.`:''} Locking or switching profiles revokes key access.`:status(result));}catch{if(at===revision.current)setNotice('Review was cancelled, expired, or refused. No new permission was granted.');}finally{if(at===revision.current)setBusy(false);}};
 return <section aria-label="Background memory access"><h5>Background memory access</h5><p className="fine-print">Review an existing local task or agent schedule. The desktop shows its current scope and asks for explicit consent. This permission does not unlock a locked profile or approve unknown content as new memory.</p><button type="button" className="link-button" disabled={busy} onClick={()=>void refresh()}>{busy?'Working…':'Load eligible tasks and schedules'}</button>{ready&&choices.length>0&&<><label>Task or schedule <select disabled={busy} value={selected} onChange={event=>setSelected(event.target.value)}><option value="">Choose…</option>{choices.map(choice=><option key={choice.kind+':'+choice.id} value={choice.kind+':'+choice.id}>{choice.label} · {choice.kind==='task'?'Task':'Agent schedule'}</option>)}</select></label><button type="button" disabled={busy||!selected} onClick={()=>void approve()}>Review background access</button></>}{notice&&<p role="status" className="fine-print">{notice}</p>}</section>;
}
