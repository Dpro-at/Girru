import { DepartmentBadge } from './DepartmentBadge';
// CHAT-BUILD-01 stage 3 (CH3, CH5): the composer's controls and the project picker/sheet.
// Left of the box: + (files, long editor) and Mode — how the team works. Right: who answers,
// what it answers with (provider · model · thinking). Everything else is a key, a popover or a menu.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { ConversationsController, ModelOption } from './conversations';
import { canThink } from './conversations';
import type { ChatMode, ChatThinking } from './conversation-contract.js';
import { ProjectFolderPicker } from './ProjectFolderPicker';
import { Sheet } from './desktop-ui';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import { ClaudeCodeIcon, CodexIcon, GeminiIcon } from './brand-icons';
import { modelDisplayName } from './model-names';

export const MODES: readonly { id: ChatMode; name: string; note: string; icon: UiIconName; key: string }[] = [
  { id: 'auto', name: 'Auto', note: 'Everyday work runs; anything risky asks you (the agent’s rules)', icon: 'shield', key: '1' },
  { id: 'ask', name: 'Ask me', note: 'Anything that changes something asks first', icon: 'lock', key: '2' },
  { id: 'accept_edits', name: 'Accept edits', note: 'File edits in this chat’s folders run; the rest asks', icon: 'pencil', key: '3' },
  { id: 'plan', name: 'Plan first', note: 'The team writes a plan; it runs after you approve it', icon: 'list', key: '4' },
];
export const THINKING: readonly { id: ChatThinking; name: string }[] = [{ id: 'quick', name: 'Quick' }, { id: 'normal', name: 'Normal' }, { id: 'deep', name: 'Deep' }];
export const COMPOSER_KEYS: readonly [string, string][] = [['Send', 'Enter'], ['New line', '⇧ Enter'], ['Stop', 'Esc'], ['Edit my last message', '↑'], ['New chat', '⌘N'], ['New chat in this project', '⌥⌘N'],['Search chats', '⌘F'], ['Commands', '⌘K'],
  ['Who answers', '⌘J'], ['Answers with', '⇧⌘M'], ['Mode', '⇧⌘P'], ['Add files', '⌘U'], ['Long message editor', '⇧⌘E'], ['Redo the last undone file change', '⇧⌘Z'],['Dictate (hold)', '⌥Space'], ['Keys', '⌘/']];
export const SLASH: readonly { c: string; d: string }[] = [{ c: '/board', d: 'Add this chat to the board' }, { c: '/remember', d: 'Remember the last answer' }, { c: '/export', d: 'Save the chat as a Markdown file' }, { c: '/note', d: 'Edit "Where we left off"' }, { c: '/agent', d: 'Who answers' }, { c: '/model', d: 'Answers with' }];
const APPS = [{ id: 'subscription:claude', name: 'Claude Code', Icon: ClaudeCodeIcon }, { id: 'subscription:codex', name: 'Codex', Icon: CodexIcon }, { id: 'subscription:gemini', name: 'Gemini', Icon: GeminiIcon }] as const;

/** A small menu above a composer button; Esc or a click outside closes it. Arrows move, Enter picks.
 * Drawn in the window shell (a portal), so the composer box never clips it; kept inside the window. */
function Pop({ open, onClose, label, children, wide }: { open: boolean; onClose: () => void; label: string; children: ReactNode; wide?: boolean }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => { if (open) setHost(anchor.current?.closest<HTMLElement>('.app-shell') ?? null); }, [open]);
  useLayoutEffect(() => {
    if (!open || !host || !ref.current || !anchor.current?.parentElement) return;
    const r = anchor.current.parentElement.getBoundingClientRect(), h = host.getBoundingClientRect();
    const w = ref.current.offsetWidth;
    const left = Math.max(8, Math.min(r.left, h.right - w - 8)) - h.left;
    setPlace({ position: 'absolute', left, bottom: h.bottom - r.top + 6, maxHeight: Math.max(160, r.top - h.top - 16) });
  }, [open, host]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[data-pop-anchor]')) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    window.addEventListener('mousedown', close, true); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('mousedown', close, true); window.removeEventListener('keydown', key, true); };
  }, [open, onClose]);
  useEffect(() => { if (open && host) (ref.current?.querySelector<HTMLElement>('input') ?? ref.current?.querySelector<HTMLElement>('[aria-checked="true"], button'))?.focus(); }, [open, host]);
  const move = (e: ReactKeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
    const i = all.indexOf(document.activeElement as HTMLElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
  };
  const menu = <div ref={ref} className="composer-pop" style={place} data-wide={wide || undefined} role="dialog" aria-label={label} onKeyDown={move}>{children}</div>;
  return <span ref={anchor} hidden>{open && (host ? createPortal(menu, host) : null)}</span>;
}

/** + : add files, or write a long message in the editor. */
export function PlusButton({ onFiles, onLong }: { onFiles: () => void; onLong: () => void }) {
  const [open, setOpen] = useState(false);
  return <span className="composer-anchor" data-pop-anchor>
    <button type="button" className="tool composer-attach" aria-label="Add" title="Add files (⌘U) · Long message editor (⇧⌘E)" aria-expanded={open} onClick={() => setOpen(v => !v)}><UiIcon name="plus" size={16}/></button>
    <Pop open={open} onClose={() => setOpen(false)} label="Add">
      <button type="button" className="pop-row" onClick={() => { setOpen(false); onFiles(); }}><UiIcon name="file" size={14}/><span>Add files</span><kbd>⌘U</kbd></button>
      <button type="button" className="pop-row" onClick={() => { setOpen(false); onLong(); }}><UiIcon name="expand" size={14}/><span>Long message editor</span><kbd>⇧⌘E</kbd></button>
    </Pop>
  </span>;
}

/** Mode (⇧⌘P): how freely the team works in this chat. Amber when looser (Accept edits). */
export function ModeButton({ value, onChange, open, setOpen }: { value: ChatMode; onChange: (m: ChatMode) => void; open: boolean; setOpen: (v: boolean) => void }) {
  const mode = MODES.find(m => m.id === value) ?? MODES[0];
  // 1-4 pick a mode while the menu is open, wherever the focus is.
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { const m = MODES.find(x => x.key === e.key); if (m && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); onChange(m.id); setOpen(false); } };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [open, onChange, setOpen]);
  return <span className="composer-anchor" data-pop-anchor>
    <button type="button" className="composer-pill" data-looser={value === 'accept_edits' || undefined} aria-label={`Mode: ${mode.name}`} title="Mode (⇧⌘P)" aria-expanded={open} onClick={() => setOpen(!open)}>
      <UiIcon name={mode.icon} size={13}/><span>{mode.name}</span><span className="pill-chev" aria-hidden="true"><UiIcon name="chevron" size={11}/></span></button>
    <Pop open={open} onClose={() => setOpen(false)} label="Mode" wide>
      <p className="pop-title">Mode</p>
      <div role="radiogroup" aria-label="Mode">
        {MODES.map(m => <button key={m.id} type="button" role="radio" aria-checked={m.id === value} className="pop-row tall" data-looser={m.id === 'accept_edits' || undefined} onClick={() => { onChange(m.id); setOpen(false); }}>
          <UiIcon name={m.icon} size={15}/><span className="pop-text"><b>{m.name}</b><small>{m.note}</small></span><kbd>{m.key}</kbd></button>)}
      </div>
      <p className="pop-note">Always asks, in every mode: sending to people, money, deleting for good, installing software. A mode is never looser than the agent’s own permissions.</p>
    </Pop>
  </span>;
}

export type Who = { id: string; name: string; note?: string; department?: string | null };
/** Who answers (⌘J): the team (the main agent leads and hands parts out) or one agent. */
export function WhoButton({ team, agents, value, label, onChange, open, setOpen }: { team: Who; agents: readonly Who[]; value: string; label: string; onChange: (id: string) => void; open: boolean; setOpen: (v: boolean) => void }) {
  const [q, setQ] = useState('');
  const current = value ? agents.find(a => a.id === value) ?? { id: value, name: label } : team;
  const shown = agents.filter(a => !q || a.name.toLowerCase().includes(q.toLowerCase()));
  const pick = (id: string) => { onChange(id); setOpen(false); setQ(''); };
  return <span className="composer-anchor" data-pop-anchor>
    <button type="button" className="composer-pill" aria-label={`Who answers: ${current.name}`} title="Who answers (⌘J)" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="composer-face" aria-hidden="true">{current.name.slice(0, 1).toUpperCase()}</span><span>{value ? current.name : 'Team'}</span>{value && current.department !== undefined && <DepartmentBadge department={current.department} compact/>}<span className="pill-chev" aria-hidden="true"><UiIcon name="chevron" size={11}/></span></button>
    <Pop open={open} onClose={() => { setOpen(false); setQ(''); }} label="Who answers" wide>
      <input className="pop-search" placeholder="Search agents…" aria-label="Search agents" value={q} onChange={e => setQ(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); pick(shown[0].id); } }}/>
      {!q && <><p className="pop-title">Team</p>
        <button type="button" role="radio" aria-checked={!value} className="pop-row tall" onClick={() => pick('')}><span className="composer-face" aria-hidden="true">{team.name.slice(0, 1).toUpperCase()}</span><span className="pop-text"><b>Team</b><small>{team.name} leads and hands out parts</small></span></button></>}
      {shown.length > 0 && <p className="pop-title">One agent</p>}
      {shown.map(a => <button key={a.id} type="button" role="radio" aria-checked={a.id === value} className="pop-row tall" onClick={() => pick(a.id)}>
        <span className="composer-face" aria-hidden="true">{a.name.slice(0, 1).toUpperCase()}</span><span className="pop-text"><b>{a.name}</b>{a.department !== undefined && <DepartmentBadge department={a.department}/>}{a.note && <small>{a.note}</small>}</span></button>)}
      {q && !shown.length && <p className="pop-note">No agent is called “{q}”.</p>}
    </Pop>
  </span>;
}

/** What the model button says: "Auto", "qwen3 8b", "Claude Code · Sonnet · Deep" (the thinking word only for a model that can think). */
export function answersLabel(model: string, models: readonly ModelOption[], thinking: ChatThinking): string {
  const t = thinking === 'normal' || !canThink(model, models) ? '' : ` · ${THINKING.find(x => x.id === thinking)!.name}`;
  if (model === 'auto') return 'Auto';
  if (!model) return 'Each agent’s own';
  const [base, variant = ''] = model.split('/');
  const app = APPS.find(a => base === a.id || base.startsWith(`${a.id}:`));
  if (app) {
    const v = variant ? models.find(m => m.id === app.id)?.variants?.find(x => x.id === variant)?.label ?? variant : '';
    return `${app.name}${base !== app.id ? ' · previous session' : ''}${v ? ` · ${v}` : ''}${t}`;
  }
  return `${models.find(m => m.id === model)?.label ?? modelDisplayName(model)}${t}`;
}

/** Answers with (⇧⌘M): Auto, each agent's own, then each provider with its models; how deeply it thinks. */
export function ModelButton({ controller, open, setOpen }: { controller: ConversationsController; open: boolean; setOpen: (v: boolean) => void }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { if (open) void controller.loadModels(true); }, [controller, open]);
  const local = s.models.filter(m => m.provider === 'ollama' || m.provider === 'lmstudio');
  const claude = s.models.filter(m => m.provider === 'claude');
  const apps = APPS.map(a => ({ ...a, model: s.models.find(m => m.id === a.id && m.provider === 'subscription') })).filter(a => a.model);
  const pick = (id: string) => { controller.selectModel(id); setOpen(false); };
  const on = (id: string) => s.model === id || (!!id && s.model.split('/')[0] === id && !s.model.includes('/'));
  const label = answersLabel(s.model, s.models, s.thinking), base = answersLabel(s.model, s.models, 'normal');
  const thinks = canThink(s.model, s.models), think = s.thinking === 'normal' || !thinks ? '' : THINKING.find(x => x.id === s.thinking)!.name;
  const app = APPS.find(a => s.model.startsWith(a.id));
  return <span className="composer-anchor" data-pop-anchor>
    <button type="button" className="composer-pill" aria-label={`Answers with: ${label}`} title={s.model.startsWith('subscription:') ? 'Answers with (⇧⌘M) · uses your signed-in coding app; Girru tools follow the agent’s grants and approvals; Stop cancels it' : 'Answers with (⇧⌘M)'} aria-expanded={open} onClick={() => setOpen(!open)}>
      {app ? <app.Icon size={14}/> : <UiIcon name={s.model === 'auto' ? 'sparkle' : 'cpu'} size={13}/>}<span>{base}</span>{think && <span className="pill-muted">{think}</span>}<span className="pill-chev" aria-hidden="true"><UiIcon name="chevron" size={11}/></span></button>
    <Pop open={open} onClose={() => setOpen(false)} label="Answers with" wide>
      <button type="button" role="radio" aria-checked={s.model === 'auto'} className="pop-row tall" onClick={() => pick('auto')}><UiIcon name="sparkle" size={15}/><span className="pop-text"><b>Auto</b><small>The lead agent picks the best model for each part of the work</small></span></button>
      <button type="button" role="radio" aria-checked={!s.model} className="pop-row tall" onClick={() => pick('')}><UiIcon name="users" size={15}/><span className="pop-text"><b>Each agent’s own</b><small>What is set on each agent page</small></span></button>
      {local.length > 0 && <><p className="pop-title"><UiIcon name="cpu" size={12}/>This computer<span>free · private</span></p>
        {local.map(m => <button key={m.id} type="button" role="radio" aria-checked={on(m.id)} className="pop-row" onClick={() => pick(m.id)}><span className="pop-text"><b>{m.label}</b><small>{m.provider === 'lmstudio' ? 'LM Studio' : 'Ollama'}{m.size ? ` · ${m.size}` : ''}</small></span></button>)}</>}
      {apps.map(a => <div key={a.id}><p className="pop-title"><a.Icon size={12}/>{a.name}<span>your plan</span></p>
        <button type="button" role="radio" aria-checked={on(a.id)} className="pop-row" onClick={() => pick(a.id)}><span className="pop-text"><b>Default</b></span></button>
        {(a.model?.variants ?? []).map(v => <button key={v.id} type="button" role="radio" aria-checked={s.model === `${a.id}/${v.id}`} className="pop-row" onClick={() => pick(`${a.id}/${v.id}`)}><span className="pop-text"><b>{v.label}</b>{v.note && <small>{v.note}</small>}</span></button>)}</div>)}
      {claude.length > 0 && <><p className="pop-title"><ClaudeCodeIcon size={12}/>Claude (API key)<span>paid</span></p>
        {claude.map(m => <button key={m.id} type="button" role="radio" aria-checked={on(m.id)} className="pop-row" onClick={() => pick(m.id)}><span className="pop-text"><b>{m.label}</b></span></button>)}</>}
      {thinks && <div className="pop-think"><span>How deeply it thinks</span>
        <span className="segmented" role="radiogroup" aria-label="How deeply it thinks">{THINKING.map(t => <button key={t.id} type="button" role="radio" aria-checked={s.thinking === t.id} onClick={() => void controller.setThinking(t.id)}>{t.name}</button>)}</span></div>}
      <p className="pop-note">{thinks ? 'Deep is slower and uses more of your plan. ' : 'This model answers without thinking longer. '}Coding apps use your own plan; Girru’s permissions still apply to their tools.</p>
    </Pop>
  </span>;
}

/** ⌘/ : the chat's keys. */
export function KeysSheet({ onClose }: { onClose: () => void }) {
  return <Sheet title="Keys" onClose={onClose} actions={<button type="button" className="primary" onClick={onClose}>Done</button>}>
    <dl className="keys-list">{COMPOSER_KEYS.map(([t, k]) => <div key={t}><dt>{t}</dt><dd><kbd>{k}</kbd></dd></div>)}</dl>
    <p className="fine-print">On Windows ⌘ is Ctrl and ⌥ is Alt.</p>
  </Sheet>;
}

/** CH5: projects ordered by their newest chat (most recently used first); never-used ones follow by name. */
export function projectsByUse<P extends { id: string; name: string }>(projects: readonly P[], conversations: readonly { projectId: string | null; updatedAt: string }[]): P[] {
  const last = new Map<string, string>();
  for (const c of conversations) if (c.projectId && (last.get(c.projectId) ?? '') < c.updatedAt) last.set(c.projectId, c.updatedAt);
  return [...projects].sort((a, b) => (last.get(b.id) ?? '').localeCompare(last.get(a.id) ?? '') || a.name.localeCompare(b.name));
}
/** CH5 picker groups: the three most recently used on top; "This computer" shows one more and folds the rest under More. */
export function projectGroups<P extends { id: string; name: string }>(ordered: readonly P[], more: boolean) {
  const rest = ordered.slice(3);
  return { recent: ordered.slice(0, 3), local: more ? rest : rest.slice(0, 1), hidden: more ? 0 : Math.max(0, rest.length - 1) };
}

/** The project chip of a new chat (until the first message): recent projects (✓ on the current one), no project,
 * a folder on this computer (the folder picker; a folder no project uses opens New project… with it filled in) or New project…. */
export function ProjectChip({ controller, onNewProject }: { controller: ConversationsController; onNewProject: (folder?: string) => void }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [more, setMore] = useState(false);
  const [picking, setPicking] = useState(false);
  const current = s.projects.find(p => p.id === s.projectFilter);
  const ordered = useMemo(() => projectsByUse(s.projects, s.conversations), [s.projects, s.conversations]);
  const shown = ordered.filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase()));
  const groups = projectGroups(ordered, more);
  const close = () => { setOpen(false); setQ(''); setMore(false); };
  const pick = (id: string) => { controller.filterProject(id); close(); };
  const folderPicked = (path: string) => {
    setPicking(false);
    const known = s.projects.find(p => p.folder === path);
    if (known) controller.filterProject(known.id); else onNewProject(path);
  };
  // The desktop app opens its own folder chooser; the browser uses the folder picker of the project sheet.
  const chooseFolder = async () => {
    close();
    const bridge = typeof window === 'undefined' ? undefined : (window as unknown as { dproApp?: { chooseProjectFolders?: () => Promise<string[]> } }).dproApp;
    if (!bridge?.chooseProjectFolders) { setPicking(true); return; }
    try { const [first] = await bridge.chooseProjectFolders(); if (first) folderPicked(first); } catch { setPicking(true); }
  };
  if (s.access === 'denied') return null;
  const row = (p: (typeof ordered)[number]) => <button key={p.id} type="button" role="radio" aria-checked={p.id === s.projectFilter} className="pop-row" title={p.folder ?? ''} onClick={() => pick(p.id)}>
    <UiIcon name="folder" size={14}/><span className="pop-text"><b>{p.name}</b></span>{p.id === s.projectFilter && <span className="pop-check" aria-hidden="true">✓</span>}</button>;
  return <span className="composer-anchor" data-pop-anchor>
    <button type="button" className="composer-chip" aria-label={`Project: ${current?.name ?? 'No project'}`} title={current?.folder ?? 'Choose a project for this chat'} aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>
      <UiIcon name="folder" size={12}/><span>{current?.name ?? 'No project'}</span><UiIcon name="chevron" size={10}/></button>
    <Pop open={open} onClose={close} label="Project" wide>
      {!q && groups.recent.map(row)}
      {!q && <button type="button" role="radio" aria-checked={!s.projectFilter} className="pop-row" onClick={() => pick('')}><UiIcon name="message" size={14}/><span className="pop-text"><b>No project</b><small>A chat without a folder</small></span>{!s.projectFilter && <span className="pop-check" aria-hidden="true">✓</span>}</button>}
      <hr/>
      <input className="pop-search" placeholder="Search projects…" aria-label="Search projects" value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && shown[0]) { e.preventDefault(); pick(shown[0].id); } }}/>
      {q ? <>{shown.map(row)}{!shown.length && <p className="pop-note">No project is called “{q}”.</p>}</> : <>
        <p className="pop-title">This computer</p>
        <button type="button" className="pop-row" title="Choose a folder on this computer" onClick={() => void chooseFolder()}><UiIcon name="folder" size={14}/><span className="pop-text"><b>A folder…</b></span></button>
        {groups.local.map(row)}
        {groups.hidden > 0 && <button type="button" className="pop-row" aria-expanded={false} onClick={() => setMore(true)}><UiIcon name="arrow-down" size={14}/><span className="pop-text"><b>More</b></span><kbd>{groups.hidden} ›</kbd></button>}</>}
      <hr/>
      <button type="button" className="pop-row" onClick={() => { close(); onNewProject(); }}><UiIcon name="plus" size={14}/><span className="pop-text"><b>New project…</b></span><kbd>⇧⌘N</kbd></button>
    </Pop>
    {picking && <ProjectFolderPicker controller={controller} onClose={() => setPicking(false)} onSelect={folderPicked}/>}
  </span>;
}

/** New project / Folders and variables…: name, folders (main + added, read only or read and write) and encrypted variables. */
export function ProjectSheet({ controller, id, folder, onClose }: { controller: ConversationsController; id: string | null; folder?: string; onClose: () => void }) {
  const s = controller.getSnapshot();
  const current = id ? s.projects.find(p => p.id === id) : undefined;
  const folderName = (p: string) => p.split(/[\\/]/).filter(Boolean).at(-1) ?? p;
  // CH5: "A folder…" in the project chip opens New project… with the chosen folder (and its name) filled in.
  const [name, setName] = useState(current?.name ?? (folder ? folderName(folder).slice(0, 80) : ''));
  const [main, setMain] = useState(current?.folder ?? folder ?? '');
  const [folders, setFolders] = useState<{ path: string; write: boolean }[]>(current?.folders ?? []);
  const [picking, setPicking] = useState<'main' | 'add' | null>(null);
  const [vars, setVars] = useState<string[] | null>(id ? null : []);
  const [draftVars, setDraftVars] = useState<{ name: string; value: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => { if (id) void controller.variables(id).then(v => setVars(v ?? [])); }, [controller, id]);
  const [saved, setSaved] = useState<string | null>(id);
  const save = async () => {
    setBusy(true); setError(null);
    const input = { name, folder: main, repoUrl: current?.repoUrl ?? '', folders };
    // Once created, the sheet edits that project (a second Save never makes a copy).
    const err = saved ? await controller.editProject(saved, input) : await controller.createProject(input);
    if (err) { setBusy(false); setError(err); return; }
    const pid = saved ?? controller.lastCreatedProject;
    if (pid) setSaved(pid);
    for (const v of draftVars.filter(v => v.name && v.value)) {
      const verr = pid ? await controller.setVariable(pid, v.name.trim().toUpperCase(), v.value) : 'The project was saved, but its variables were not.';
      if (verr) { setBusy(false); setError(verr); return; }
    }
    setBusy(false); onClose();
  };
  return <Sheet title={id ? `${current?.name ?? 'Project'} · folders and variables` : 'New project'} onClose={onClose} wide actions={<>
    {id && (confirmDelete
      ? <span className="project-delete">Delete the project? Its chats stay. <button type="button" className="link-button danger" disabled={busy} onClick={async () => { setBusy(true); await controller.removeProject(id); setBusy(false); onClose(); }}>Delete</button></span>
      : <button type="button" className="link-button danger" onClick={() => setConfirmDelete(true)}>Delete project…</button>)}
    <span className="dk-spacer"/>
    <button type="button" onClick={onClose}>Cancel</button>
    <button type="button" className="primary" disabled={busy || !name.trim() || !main} onClick={() => void save()}>{id ? 'Save' : 'Create project'}</button></>}>
    <label className="sheet-field"><span>Name</span><input autoFocus value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="Project name"/></label>
    <div className="sheet-field"><span>Folders <button type="button" className="link-button" onClick={() => setPicking('add')} disabled={!main}><UiIcon name="plus" size={11}/>Add</button></span>
      <div className="sheet-folders">
        <div className="sheet-folder"><UiIcon name="folder" size={14}/><span className="pop-text"><b>{main ? `${folderName(main)} · main folder` : 'Main folder'}</b><small dir="ltr">{main || 'Choose the folder this project works in'}</small></span>
          <button type="button" className="link-button" onClick={() => setPicking('main')}>{main ? 'Change…' : 'Choose…'}</button></div>
        {folders.map((f, i) => <div key={f.path} className="sheet-folder"><UiIcon name="folder" size={14}/><span className="pop-text"><b>{folderName(f.path)}</b><small dir="ltr">{f.path}</small></span>
          <select aria-label={`Access to ${folderName(f.path)}`} value={f.write ? 'write' : 'read'} onChange={e => setFolders(folders.map((x, j) => (j === i ? { ...x, write: e.target.value === 'write' } : x)))}>
            <option value="read">Read only</option><option value="write">Read and write</option></select>
          <button type="button" className="row-tool" aria-label={`Remove ${folderName(f.path)}`} onClick={() => setFolders(folders.filter((_, j) => j !== i))}><UiIcon name="close" size={12}/></button></div>)}
      </div>
      <small className="fine-print">The git repo is found from the folder by itself.</small></div>
    <div className="sheet-field"><span>Variables <button type="button" className="link-button" onClick={() => setDraftVars([...draftVars, { name: '', value: '' }])}><UiIcon name="plus" size={11}/>Add</button></span>
      <small className="fine-print">{(vars?.length ?? 0) + draftVars.filter(v => v.name).length} saved, encrypted · given only to commands and the terminal in this project · never shown to a model</small>
      {vars?.map(v => <div key={v} className="sheet-folder"><UiIcon name="key" size={13}/><span className="pop-text"><b dir="ltr">{v}</b><small>••••••</small></span>
        <button type="button" className="row-tool" aria-label={`Delete ${v}`} onClick={async () => { if (id && await controller.deleteVariable(id, v)) setVars(vars.filter(x => x !== v)); }}><UiIcon name="trash" size={12}/></button></div>)}
      {draftVars.map((v, i) => <div key={i} className="sheet-var"><input aria-label="Variable name" placeholder="NAME" dir="ltr" value={v.name} maxLength={64} onChange={e => setDraftVars(draftVars.map((x, j) => (j === i ? { ...x, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') } : x)))}/>
        <input aria-label="Variable value" type="password" placeholder="Value" value={v.value} maxLength={8000} autoComplete="off" onChange={e => setDraftVars(draftVars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}/>
        <button type="button" className="row-tool" aria-label="Remove" onClick={() => setDraftVars(draftVars.filter((_, j) => j !== i))}><UiIcon name="close" size={12}/></button></div>)}
    </div>
    {error && <p className="project-error" role="alert">{error}</p>}
    {picking && <ProjectFolderPicker controller={controller} onClose={() => setPicking(null)} onSelect={p => {
      if (picking === 'main') { setMain(p); if (!name.trim()) setName(folderName(p).slice(0, 80)); }
      else if (p !== main && !folders.some(f => f.path === p) && folders.length < 8) setFolders([...folders, { path: p, write: false }]);
      setPicking(null);
    }}/>}
  </Sheet>;
}

/** Slash commands typed at the start of the box. */
export function SlashList({ query, onPick, index }: { query: string; onPick: (c: string) => void; index: number }) {
  const list = useMemo(() => SLASH.filter(x => x.c.startsWith(query)), [query]);
  if (!list.length) return null;
  return <ul className="mention-list slash-list" role="listbox" aria-label="Chat commands">{list.map((x, i) =>
    <li key={x.c} role="option" aria-selected={i === Math.min(index, list.length - 1)}><button type="button" onMouseDown={e => { e.preventDefault(); onPick(x.c); }}><b>{x.c}</b><span>{x.d}</span></button></li>)}</ul>;
}
export const slashMatches = (query: string) => SLASH.filter(x => x.c.startsWith(query));
