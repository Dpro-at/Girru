// CHAT-BUILD-01 stage 4 (CH8): the chat's side panel. One status line on top (how full the chat is,
// tokens by model, who works now), then only the parts that have something, in the person's order:
// Place (folders, schedule) · Team (who works, with their model; Stop) · Results (changes, files made)
// · From memory · MCP connections. Each part folds (a one-line summary stays) and moves (drag or ⌥↑/⌥↓);
// folds and order are saved per person. Hidden, the panel becomes a thin rail of icons with dots.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ServiceLogo, serviceMark } from './ServiceLogo';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { ConversationsController } from './conversations';
import type { SessionClient } from './session';
import type { ChatRecallController } from './chat-recall';
import { ContextCard } from './ChatRecall';
import { UiIcon } from './ui-icons';
import type { UiIconName } from './ui-icons';
import { ContextMenu, useMenu } from './desktop-ui';
import type { MenuItem } from './desktop-ui';
import { turnOutputs } from './turns';
import { canRevealFolder, revealFolder } from './chat-actions';
import { answersLabel } from './ChatComposerControls';
import { ClaudeCodeIcon, CodexIcon, GeminiIcon } from './brand-icons';

export type PanelPart = 'place' | 'team' | 'results' | 'memory' | 'mcp';
export const PANEL_PARTS: readonly { id: PanelPart; name: string; icon: UiIconName }[] = [
  { id: 'place', name: 'Place', icon: 'folder' }, { id: 'team', name: 'Team', icon: 'users' }, { id: 'results', name: 'Results', icon: 'diff' },
  { id: 'memory', name: 'From memory', icon: 'brain' }, { id: 'mcp', name: 'MCP connections', icon: 'tool' },
];
export type PanelPrefs = { order: PanelPart[]; folded: PanelPart[] };
export const DEFAULT_PANEL: PanelPrefs = { order: PANEL_PARTS.map(p => p.id), folded: [] };
export const PANEL_PATH = '/api/chat/panel';
const isPart = (x: unknown): x is PanelPart => typeof x === 'string' && PANEL_PARTS.some(p => p.id === x);
export function readPanel(raw: unknown): PanelPrefs {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const order = [...new Set((Array.isArray(v.order) ? v.order as unknown[] : []).filter(isPart))];
  for (const p of DEFAULT_PANEL.order) if (!order.includes(p)) order.push(p);
  return { order, folded: [...new Set((Array.isArray(v.folded) ? v.folded as unknown[] : []).filter(isPart))] };
}
export function movePart(order: readonly PanelPart[], id: PanelPart, by: -1 | 1): PanelPart[] {
  const i = order.indexOf(id), j = i + by;
  if (i < 0 || j < 0 || j >= order.length) return [...order];
  const next = [...order]; [next[i], next[j]] = [next[j], next[i]]; return next;
}

export type Usage = { model: string; tokensIn: number; tokensOut: number; replies: number };
export type Delegation = { agentId: string; agentName: string; model: string; status: 'started' | 'answered' | 'waiting_approval' | 'failed'; at: string };
export type Schedule = { every: 'hourly' | 'daily' | 'weekly'; at: string; weekday: number | null; message: string; paused: boolean; nextRun: string };
export type Connection = { id: string; name: string; about: string; enabled: boolean; needsYou: boolean };
/** A coding app (Claude Code, Codex, Gemini) doing a part for an agent of this chat, while it runs. */
export type CodingApp = { id: string; app: string; agentName: string | null; about: string; startedAt: string };
type Live = { usage: Usage[]; team: Delegation[]; apps: CodingApp[]; schedule: Schedule | null; connections: Connection[] | null };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const scheduleWords = (s: Schedule) => s.every === 'hourly' ? `Runs every hour at :${s.at.slice(3)}` : s.every === 'daily' ? `Runs every day at ${s.at}` : `Runs every ${WEEKDAYS[s.weekday ?? 0]} at ${s.at}`;
const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
/** How long something has run, from its start time: 0:42, 12:05, 1:02:09 (empty for a bad or future time). */
export function elapsed(since: string, now: number): string {
  const s = Math.floor((now - Date.parse(since)) / 1000);
  if (!Number.isFinite(s) || s < 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
/** The newest reply whose file changes can still be undone (its message id carries the checkpoint). */
export function undoTarget(turns: readonly { key: string; role: string; changes?: { undone?: boolean } }[]): string | null {
  for (let i = turns.length - 1; i >= 0; i--) { const t = turns[i]; if (t.role === 'assistant' && t.changes) return t.changes.undone ? null : t.key; }
  return null;
}
const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => undefined); };
const localModel = (m: string) => !/^(claude-|subscription:)/.test(m);

/** CH12: the app that answers for a model id (its mark is drawn from brand-icons; a model on this computer gets the chip). */
export type ModelApp = { id: 'subscription:claude' | 'subscription:codex' | 'subscription:gemini' | 'claude' | 'local'; name: string };
export function modelApp(model: string): ModelApp | null {
  if (!model || model === 'auto') return null;
  for (const [id, name] of [['subscription:claude', 'Claude Code'], ['subscription:codex', 'Codex'], ['subscription:gemini', 'Gemini']] as const) if (model === id || model.startsWith(`${id}/`) || model.startsWith(`${id}:`)) return { id, name };
  return /^claude-/.test(model) ? { id: 'claude', name: 'Claude' } : { id: 'local', name: 'On this computer' };
}
export function AppMark({ app, size = 12 }: { app: ModelApp; size?: number }) {
  return app.id === 'subscription:codex' ? <CodexIcon size={size}/> : app.id === 'subscription:gemini' ? <GeminiIcon size={size}/> : app.id === 'local' ? <UiIcon name="cpu" size={size}/> : <ClaudeCodeIcon size={size}/>;
}
export type ModelUse = { app: ModelApp; agents: { name: string; label: string }[]; tokens: number };
/** CH12: which apps and models worked in this chat: each app once, with the agents that used it and its tokens. */
export function modelsUsed(people: readonly { name: string; model: string }[], usage: readonly Usage[], label: (model: string) => string): ModelUse[] {
  const out = new Map<string, ModelUse>();
  for (const p of people) {
    const app = modelApp(p.model); if (!app) continue;
    const u = out.get(app.id) ?? { app, agents: [], tokens: 0 };
    if (!u.agents.some(a => a.name === p.name)) u.agents.push({ name: p.name, label: label(p.model) });
    out.set(app.id, u);
  }
  for (const x of usage) { const u = out.get(modelApp(x.model)?.id ?? ''); if (u) u.tokens += x.tokensIn + x.tokensOut; }
  return [...out.values()];
}

/** The chat's live data for the panel (usage, delegations, schedule, connections); quiet on failure. */
function useLive(client: SessionClient | undefined, chatId: string | null, owner: boolean, tick: number, agentId: string | null, pulse = 0): Live {
  const [live, setLive] = useState<Live>({ usage: [], team: [], apps: [], schedule: null, connections: null });
  useEffect(() => {
    if (!client || !chatId) { setLive({ usage: [], team: [], apps: [], schedule: null, connections: null }); return; }
    let on = true;
    const get = async (path: string) => { try { const r = await client.request({ method: 'GET', path } as never); return r.status === 200 ? r.body as Record<string, unknown> : null; } catch { return null; } };
    void (async () => {
      const [u, t, s, c] = await Promise.all([get(`/api/chat/conversations/${chatId}/usage`), get(`/api/chat/conversations/${chatId}/team`), owner ? get(`/api/chat/conversations/${chatId}/schedule`) : null, owner ? get('/api/mcp/servers') : null]);
      // MCP-ONE-01: a chat uses the connections of the agent it talks to, so only those show here.
      const g = owner && agentId ? await get(`/api/agents/${encodeURIComponent(agentId)}/tool-grants`) : null;
      const granted = Array.isArray(g?.grants) ? (g!.grants as { tool?: unknown }[]).map(x => String(x.tool ?? '')) : null;
      if (!on) return;
      setLive({
        usage: Array.isArray(u?.usage) ? u!.usage as Usage[] : [],
        team: Array.isArray(t?.team) ? t!.team as Delegation[] : [],
        apps: Array.isArray(t?.apps) ? t!.apps as CodingApp[] : [],
        schedule: (s?.schedule as Schedule) ?? null,
        connections: Array.isArray(c?.servers) && granted ? (c!.servers as Record<string, unknown>[]).filter(x => granted.some(t => t.startsWith(`mcp__${String(x.name)}__`) || t.startsWith(`mcp:${String(x.name)}:`))).map(x => ({ id: String(x.id), name: String(x.name ?? x.id), about: typeof x.description === 'string' ? x.description.trim() : '', enabled: x.enabled === true, needsYou: x.enabled === true && (!!x.lastError || x.active === false) })) : null,
      });
    })();
    return () => { on = false; };
  }, [client, chatId, owner, tick, agentId]);
  // CHAT-LIVE-01 (LW6): while a reply runs only Team is read again (coding apps an agent starts); usage, schedule and connections wait for the next turn.
  useEffect(() => {
    if (!client || !chatId || !pulse) return;
    let on = true;
    void (async () => { try { const r = await client.request({ method: 'GET', path: `/api/chat/conversations/${chatId}/team` } as never); const t = r.status === 200 ? r.body as Record<string, unknown> : null;
      if (on && t) setLive(l => ({ ...l, team: Array.isArray(t.team) ? t.team as Delegation[] : l.team, apps: Array.isArray(t.apps) ? t.apps as CodingApp[] : l.apps })); } catch { /* the next pulse tries again */ } })();
    return () => { on = false; };
  }, [client, chatId, pulse]);
  return live;
}

export function ChatDetails({ controller, client, recall, memoryCard, placeExtra, resultsExtra, onOpenPane, onSettings, onClose, onStop, onSchedule, onAddFolder, onChooseFolder, onOpenMemory, onContinue, onSignIn, focusPart, switcher }: {
  switcher?: ReactNode; onSignIn?: () => void; onContinue?: () => void; focusPart?: { id: PanelPart; n: number } | null;
  onChooseFolder?: () => void; onOpenMemory?: () => void;
  controller: ConversationsController; client?: SessionClient; recall?: ChatRecallController | null; memoryCard?: ReactNode; placeExtra?: ReactNode; resultsExtra?: ReactNode;
  onOpenPane: (pane: 'changes' | 'files' | 'terminal', file?: string) => void; onSettings?: () => void; onClose: () => void; onStop: () => void;
  onSchedule: () => void; onAddFolder: () => void;
}) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const owner = client?.getSnapshot().user?.role === 'owner';
  const [prefs, setPrefsState] = useState<PanelPrefs>(DEFAULT_PANEL);
  const [more, setMore] = useState<Set<PanelPart>>(new Set());
  const [byModel, setByModel] = useState(false);
  const [card, setCard] = useState<string | null>(null);
  const [drag, setDrag] = useState<PanelPart | null>(null);
  const menu = useMenu();
  // While a reply runs, look again every few seconds so coding apps an agent starts show up (and leave) in Team.
  const [pulse, setPulse] = useState(0);
  useEffect(() => { if (!s.runId) return; const t = setInterval(() => setPulse(p => p + 1), 4000); return () => clearInterval(t); }, [s.runId]);
  const [scheduleRevision, setScheduleRevision] = useState(0);
  const chatAgent = s.conversations.find(c => c.id === s.activeId)?.agentId ?? s.agentId ?? s.agents.find(a => a.primary)?.id ?? null;
  const live = useLive(client, s.activeId, owner, s.turns.length + (s.runId ? 1 : 0) + scheduleRevision, chatAgent, pulse);
  const subs = s.activeId ? (s.conversations as readonly (typeof s.conversations[number] & { running?: boolean; waiting?: number })[]).filter(c => c.parentId === s.activeId) : [];
  // CH8: running times (1:12) tick once a second while an agent or a coding app works for this chat.
  const [now, setNow] = useState(() => Date.now());
  const ticking = live.team.some(d => d.status === 'started') || live.apps.length > 0;
  useEffect(() => { if (!ticking) return; setNow(Date.now()); const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [ticking]);
  const [notice, setNotice] = useState('');
  const pause = async (paused: boolean) => {
    const sc = live.schedule; if (!sc || !s.activeId) return;
    try {
      const r = await client?.request({ method: 'PUT', path: `/api/chat/conversations/${s.activeId}/schedule`, body: { every: sc.every, at: sc.at, weekday: sc.weekday, message: sc.message, paused } } as never);
      setNotice(r?.status === 200 ? '' : 'The schedule did not change. Try again.');
    } catch { setNotice('No connection. Try again.'); }
    setScheduleRevision(v => v + 1);
  };
  const folderItems = (path: string): MenuItem[] => [
    ...(canRevealFolder() ? [{ label: navigator.platform.startsWith('Win') ? 'Show in Explorer' : 'Show in Finder', icon: 'open' as const, run: () => revealFolder(path) }] : []),
    { label: 'Copy path', icon: 'copy', run: () => copy(path) }];
  const undoId = undoTarget(s.turns);
  const undo = async () => {
    if (!undoId || !s.activeId) return;
    try {
      const r = await client?.request({ method: 'POST', path: `/api/chat/conversations/${s.activeId}/messages/${undoId}/undo`, body: {} } as never);
      setNotice(r?.status === 200 ? '' : r?.status === 409 ? 'Some of these files changed since, so nothing was undone.' : 'It did not work. Try again.');
      if (r?.status === 200) { void controller.refreshGit(); void controller.refreshActive(); }
    } catch { setNotice('No connection. Try again.'); }
  };
  const stopApp = (id: string) => { if (!s.activeId) return; void client?.request({ method: 'POST', path: `/api/chat/conversations/${s.activeId}/apps/${id}/stop` } as never).catch(() => undefined).finally(() => setPulse(p => p + 1)); };
  useEffect(() => { void (async () => { try { const r = await client?.request({ method: 'GET', path: PANEL_PATH } as never); if (r?.status === 200) setPrefsState(readPanel((r.body as any)?.panel)); } catch { /* the usual order */ } })(); }, [client]);
  const setPrefs = (p: PanelPrefs) => { setPrefsState(p); void client?.request({ method: 'PUT', path: PANEL_PATH, body: p } as never).catch(() => undefined); };
  const project = controller.activeProject();
  const conv = s.conversations.find(c => c.id === s.activeId);
  const nameOf = (id: string | null | undefined) => (id ? s.agents.find(a => a.id === id)?.name : s.agents.find(a => a.primary)?.name) ?? 'Main agent';
  const lead = nameOf(conv?.agentId ?? s.agentId);
  const running = s.turns.find(t => t.role === 'assistant' && t.status === 'running');
  const writers = [...new Set(s.turns.filter(t => t.role === 'assistant').map(t => t.agentId ?? conv?.agentId ?? ''))];
  const working = [...(running ? [nameOf(running.agentId ?? conv?.agentId)] : []), ...live.team.filter(d => d.status === 'started').map(d => d.agentName), ...live.apps.map(a => a.app)];
  const waits = (conv?.waiting ?? 0) + live.team.filter(d => d.status === 'waiting_approval').length;
  const trace = recall?.latest(s.turns.filter(t => t.role === 'assistant').map(t => t.key));
  const ctx = trace?.context.numCtx && trace.context.promptTokens ? Math.min(100, Math.round(trace.context.promptTokens / trace.context.numCtx * 100)) : null;
  const tokens = live.usage.reduce((n, u) => n + u.tokensIn + u.tokensOut, 0);
  const outputs = turnOutputs(s.turns);
  const changed = s.git?.files ?? 0;
  const conns = (live.connections ?? []).filter(c => c.enabled);
  // CH12: the lead answers with the chat's choice (or, on Auto, the one model its replies used); each helper with the model its hand-off really ran on.
  const leadModel = s.model && s.model !== 'auto' ? s.model : live.usage.length === 1 ? live.usage[0].model : '';
  const helpers = [...new Map(live.team.map(d => [d.agentId, d])).values()];
  const used = modelsUsed([{ name: lead, model: leadModel }, ...helpers.map(d => ({ name: d.agentName, model: d.model }))], live.usage, m => answersLabel(m, s.models, 'normal'));
  const people = 1 + writers.filter(w => w && w !== (conv?.agentId ?? '')).length + helpers.length;
  const teamTitle = `${people} ${people === 1 ? 'agent' : 'agents'}${used.length ? ` · ${used.length} ${used.length === 1 ? 'model' : 'models'}` : ''}`;
  const signedOut = (model: string) => s.modelsLoaded && model.startsWith('subscription:') && !s.models.some(m => m.provider === 'subscription' && model.split('/')[0] === m.id);
  const answers = (model: string) => { const app = modelApp(model), words = answersLabel(model, s.models, 'normal'); return app ? <><span className="details-app" aria-hidden="true"><AppMark app={app} size={10}/></span>{app.id === 'local' ? `On this computer · ${words}` : words}</> : words; };

  // Each part: does it have something, its one-line summary, and its body.
  const parts: Record<PanelPart, { has: boolean; summary: string; tone?: 'work' | 'needs'; side?: ReactNode; body: ReactNode; more?: ReactNode }> = {
    place: { has: true, summary: [project?.folder ?? 'No folder yet', live.schedule && !live.schedule.paused ? scheduleWords(live.schedule).replace('Runs ', '') : ''].filter(Boolean).join(' · '),
      side: owner && project ? <button type="button" className="link-button" onClick={onAddFolder}><UiIcon name="plus" size={11}/>Add a folder</button> : undefined,
      body: <>
        {project?.folder ? <Row icon="folder" name={project.folder} sub={`Main folder${s.git?.branch ? ` · ${s.git.branch}` : ''}${s.turns.length ? ' · fixed since the first message' : ''}`} ltr items={folderItems(project.folder)} onMenu={menu.at}/>
          : <><p className="panel-quiet">No folder yet. A chat without a folder works in a private folder of its own.</p>
            {owner && onChooseFolder && !s.turns.length && <button type="button" className="link-button panel-add" onClick={onChooseFolder}><UiIcon name="folder" size={12}/>Choose a folder</button>}</>}
        {project?.folders?.map(f => { const remove = () => void controller.editProject(project.id, { name: project.name, folder: project.folder ?? '', repoUrl: project.repoUrl ?? '', folders: (project.folders ?? []).filter(x => x.path !== f.path) });
          return <Row key={f.path} icon="folder" name={f.path} sub={`Added · ${f.write ? 'read and write' : 'read only'}`} ltr onMenu={menu.at}
            items={[...folderItems(f.path), ...(owner ? ['sep' as const, { label: 'Remove from this chat', icon: 'trash' as const, run: remove }] : [])]}
            end={owner ? <button type="button" className="link-button" title="Remove this added folder (the files stay)" onClick={remove}>Remove</button> : undefined}/>; })}
        {owner && onContinue && s.activeId && s.turns.length > 0 && <button type="button" className="link-button panel-add" onClick={onContinue}><UiIcon name="folder" size={12}/>Continue in another folder…</button>}
        {live.schedule ? <Row icon="clock" name={scheduleWords(live.schedule)} sub={live.schedule.paused ? 'Schedule · paused' : `Schedule · next ${new Date(live.schedule.nextRun).toLocaleString('en', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
          onMenu={menu.at} items={owner ? [{ label: 'Change…', icon: 'pencil', run: onSchedule }, { label: live.schedule.paused ? 'Resume' : 'Pause', icon: live.schedule.paused ? 'play' : 'pause', run: () => void pause(!live.schedule!.paused) }] : undefined}
          end={owner ? <span className="panel-end"><button type="button" className="link-button" onClick={onSchedule}>Change</button> <button type="button" className="link-button" onClick={() => void pause(!live.schedule!.paused)}>{live.schedule.paused ? 'Resume' : 'Pause'}</button></span> : undefined}/>
          : owner && s.activeId ? <button type="button" className="link-button panel-add" onClick={onSchedule}><UiIcon name="clock" size={12}/>Run this chat on a schedule…</button> : null}
      </>, more: placeExtra },
    team: { has: writers.length > 0 || !!running || live.team.length > 0 || live.apps.length > 0 || subs.length > 0, summary: working.length ? `${working.length} working` : waits ? `${waits} waits for you` : teamTitle, tone: working.length ? 'work' : waits ? 'needs' : undefined,
      side: <small className="details-sum">{teamTitle}</small>,
      body: <>
        <Row face={lead} badge={modelApp(leadModel)} name={lead} sub={<>Leads · {answers(leadModel)}{leadModel === s.model ? answersLabel(s.model, s.models, s.thinking).slice(answersLabel(s.model, s.models, 'normal').length) : ''}</>} end={running && !running.agentId ? <span className="panel-end">{running.startedAt ? elapsed(new Date(running.startedAt).toISOString(), now) : ''} <StopButton onStop={onStop}/></span> : <span className="panel-end">{running ? 'Working' : 'Ready'}</span>}
          onMenu={menu.at} items={[...(running ? [{ label: 'Stop', icon: 'stop' as const, run: onStop }] : []), { label: 'Copy name', icon: 'copy', run: () => copy(lead) }]}/>
        {writers.filter(w => w && w !== (conv?.agentId ?? '')).map(w => <Row key={w} face={nameOf(w)} name={nameOf(w)} sub="Wrote a reply here" end={running?.agentId === w ? <StopButton onStop={onStop}/> : undefined}
          onMenu={menu.at} items={[...(running?.agentId === w ? [{ label: 'Stop', icon: 'stop' as const, run: onStop }] : []), { label: 'Copy name', icon: 'copy', run: () => copy(nameOf(w)) }]}/>)}
        {live.team.slice(0, more.has('team') ? 50 : 3).map((d, i) => <Row key={`${d.agentId}-${i}`} face={d.agentName} badge={modelApp(d.model)} name={d.agentName} sub={<>Handed a part · {answers(d.model)}{signedOut(d.model) ? ' · not signed in' : ''}</>} indent
          onMenu={menu.at} items={[...(d.status === 'started' ? [{ label: 'Stop', icon: 'stop' as const, run: onStop }] : []), { label: 'Copy name', icon: 'copy', run: () => copy(d.agentName) }]}
          end={d.status === 'started' ? <span className="panel-end">{elapsed(d.at, now)} <StopButton onStop={onStop}/></span> : signedOut(d.model) && onSignIn ? <button type="button" className="link-button" title="Sign in to this app in Settings › Replies" onClick={onSignIn}>Sign in…</button> : <span className="panel-end" data-tone={d.status === 'waiting_approval' ? 'needs' : d.status === 'failed' ? 'error' : undefined}>{d.status === 'waiting_approval' && <span className="details-needs-dot" aria-hidden="true"/>}{d.status === 'answered' ? 'Done' : d.status === 'waiting_approval' ? 'Waits for you' : d.status === 'failed' ? 'Failed' : ''}</span>}/>)}
        {live.apps.map(a => <Row key={a.id} icon="terminal" name={a.app} indent sub={[a.agentName ? `Working for ${a.agentName}` : 'Working', a.about].filter(Boolean).join(' · ')}
          onMenu={menu.at} items={[{ label: `Stop ${a.app}`, icon: 'stop', run: () => stopApp(a.id) }]}
          end={<span className="panel-end">{elapsed(a.startedAt, now)} <button type="button" className="row-tool details-stop" aria-label={`Stop ${a.app}`} title={`Stop ${a.app} (only this part)`} onClick={() => stopApp(a.id)}><UiIcon name="stop" size={10}/></button></span>}/>)}
        {/* CHAT-ORCH-01 (LW4 §5): this chat's sub-sessions, live; select one to open it. */}
        {subs.length > 0 && <p className="fine-print details-subs">Sessions · {subs.length}</p>}
        {subs.slice(0, 8).map(c => <Row key={c.id} face={nameOf(c.agentId ?? '')} name={c.title || 'Session'} indent sub={`${nameOf(c.agentId ?? '')} · ${c.waiting ? 'Needs you' : c.running ? 'Working' : 'Done'}`} tone={c.waiting ? 'needs' : undefined} onClick={() => void controller.open(c.id)}
          end={c.running ? <button type="button" className="row-tool details-stop" aria-label={`Stop ${c.title || 'the session'}`} title="Stop this session (what it did is kept)" onClick={e => { e.stopPropagation(); void controller.stopChat(c.id); }}><UiIcon name="stop" size={10}/></button> : undefined}/>)}
      </>, more: live.team.length > 3 && !more.has('team') ? <ShowMore n={live.team.length - 3} onClick={() => setMore(new Set([...more, 'team']))}/> : undefined },
    results: { has: changed > 0 || outputs.length > 0 || !!resultsExtra, summary: changed ? `+${s.git?.added ?? 0} −${s.git?.removed ?? 0}` : `${outputs.length} ${outputs.length === 1 ? 'file' : 'files'}`,
      side: changed ? <button type="button" className="link-button" onClick={() => onOpenPane('changes')}>Review</button> : undefined,
      body: <>
        {changed > 0 && <Row icon="diff" name={`${changed} ${changed === 1 ? 'file' : 'files'} changed`} sub={`${s.git?.branch ?? 'Working folder'} · not committed`} end={<span className="panel-end"><span className="plus">+{s.git?.added ?? 0}</span> <span className="minus">−{s.git?.removed ?? 0}</span></span>} onClick={() => onOpenPane('changes')}
          onMenu={menu.at} items={[{ label: 'Review changes', icon: 'diff', run: () => onOpenPane('changes') }, ...(undoId ? [{ label: 'Undo these changes', icon: 'undo' as const, run: () => void undo() }] : [])]}/>}
        {changed > 0 && undoId && <button type="button" className="link-button panel-add" title="Puts back the files as they were before the last reply that changed them" onClick={() => void undo()}><UiIcon name="undo" size={12}/>Undo these changes</button>}
        {outputs.slice(-(more.has('results') ? 50 : 3)).reverse().map(o => <Row key={o.path} icon={o.kind === 'edit' ? 'pencil' : 'file'} name={o.path.split('/').at(-1) ?? o.path} sub={o.kind === 'edit' ? 'Changed here' : 'Made in this chat'} onClick={() => onOpenPane('files', o.path)}
          onMenu={menu.at} items={[{ label: 'Open in Files', icon: 'folder', run: () => onOpenPane('files', o.path) }, { label: 'Copy path', icon: 'copy', run: () => copy(o.path) }]}/>)}
        {resultsExtra}
      </>, more: outputs.length > 3 && !more.has('results') ? <ShowMore n={outputs.length - 3} onClick={() => setMore(new Set([...more, 'results']))}/> : undefined },
    memory: { has: !!memoryCard || !!trace, summary: trace?.items?.length ? `${trace.items.length} used` : 'Saved from this chat',
      side: onOpenMemory ? <button type="button" className="link-button" onClick={onOpenMemory}>Open Memory</button> : undefined,
      body: <>{trace && recall ? <ContextCard trace={trace} c={recall}/> : null}{memoryCard}</> },
    mcp: { has: conns.length > 0, summary: conns.some(c => c.needsYou) ? `${conns.filter(c => c.needsYou).length} needs you` : `${conns.length} on`, tone: conns.some(c => c.needsYou) ? 'needs' : undefined,
      side: onSettings ? <button type="button" className="link-button" onClick={onSettings}><UiIcon name="plus" size={11}/>Add</button> : undefined,
      // CH8: each connection with its real mark (vendored, never loaded from the internet) and an amber dot when it needs you.
      body: <><p className="fine-print details-mcp-who">The connections {lead} may use</p>{conns.slice(0, 3).map(c => <Row key={c.id} icon="tool" logo={serviceMark(c.name) ? <ServiceLogo id={c.name} size={13}/> : undefined} name={c.name} sub={c.needsYou ? 'Needs you' : c.about || 'On'} tone={c.needsYou ? 'needs' : undefined}
        onMenu={onSettings ? menu.at : undefined} items={onSettings ? [{ label: 'Open in Settings', icon: 'gear', run: onSettings }] : undefined}
        end={c.needsYou ? <span className="details-needs-dot" aria-label="Needs you"/> : undefined}/>)}</>,
      more: onSettings ? <button type="button" className="link-button panel-more" onClick={onSettings}>{conns.length > 3 ? `View all (${conns.length}) in Settings` : 'View all in Settings'}</button> : undefined },
  };
  const shown = prefs.order.filter(id => parts[id].has);
  // CH8c: a rail icon opens the panel at its part (unfolded, in view).
  useEffect(() => {
    if (!focusPart) return;
    if (prefs.folded.includes(focusPart.id)) setPrefs({ ...prefs, folded: prefs.folded.filter(x => x !== focusPart.id) });
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.chat-details .details-part[data-part="${focusPart.id}"]`)?.scrollIntoView({ block: 'start' }));
  }, [focusPart?.n]);
  const fold = (id: PanelPart) => setPrefs({ ...prefs, folded: prefs.folded.includes(id) ? prefs.folded.filter(x => x !== id) : [...prefs.folded, id] });
  const headerItems: MenuItem[] = [
    { label: 'Fold all', icon: 'chevron', run: () => setPrefs({ ...prefs, folded: [...PANEL_PARTS.map(p => p.id)] }) },
    { label: 'Open all', icon: 'chevron', run: () => setPrefs({ ...prefs, folded: [] }) },
    { label: 'Reset order', icon: 'undo', run: () => setPrefs({ ...prefs, order: DEFAULT_PANEL.order }) },
  ];
  const headerKey = (e: ReactKeyboardEvent, id: PanelPart) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); setPrefs({ ...prefs, order: movePart(prefs.order, id, e.key === 'ArrowUp' ? -1 : 1) }); }
    else if (e.key === ' ') { e.preventDefault(); fold(id); }
    else if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') menu.at(e, headerItems);
  };
  return <aside className="chat-panel chat-details" aria-label="Conversation details" onKeyDown={e => { if (e.key === 'Escape') onClose(); }}>
    {switcher}
    <div className="details-status" role="status">
      <button type="button" className="details-context" aria-expanded={byModel} title="Tokens by model" onClick={() => setByModel(v => !v)}>
        <span className="details-context-line">Context<b>{ctx === null ? '—' : `${ctx}%`}</b></span>
        {tokens > 0 && <small>{kTokens(tokens)} tokens · by model ›</small>}
        <meter min={0} max={100} value={ctx ?? 0} aria-label="How full this chat is"/></button>
      <span className="details-divider" aria-hidden="true"/>
      <span className="details-who">{working.length ? <><Faces names={working}/>{working.length} working</> : waits ? <span className="details-waits">{waits} {waits === 1 ? 'waits' : 'wait'} for you</span> : <>Ready</>}</span>
    </div>
    {used.length > 0 && <div className="details-models" aria-label="Models in this chat">
      <span className="details-models-name">Models</span>
      {used.map(u => <span key={u.app.id} className="details-model-anchor" onMouseEnter={() => setCard(u.app.id)} onMouseLeave={() => setCard(c => c === u.app.id ? null : c)}>
        <button type="button" className="details-model" aria-describedby={card === u.app.id ? 'details-model-card' : undefined} aria-label={`${u.app.name}: ${u.agents.length} ${u.agents.length === 1 ? 'agent' : 'agents'}`}
          onFocus={() => setCard(u.app.id)} onBlur={() => setCard(c => c === u.app.id ? null : c)} onKeyDown={e => { if (e.key === 'Escape' && card) { e.stopPropagation(); setCard(null); } }} onClick={() => { setCard(null); setByModel(true); }}>
          <AppMark app={u.app} size={12}/>{u.agents.length}</button>
        {card === u.app.id && <span className="details-model-card" id="details-model-card" role="tooltip">
          <b><AppMark app={u.app} size={12}/>{[...new Set(u.agents.map(a => a.label))].join(', ')}</b>
          <span>Used by {u.agents.map(a => a.name).join(', ')}</span>
          {u.tokens > 0 && <span>{kTokens(u.tokens)} tokens{u.app.id === 'local' ? ' · free' : ''}</span>}
          <small>Click to see it in Context.</small></span>}
      </span>)}
    </div>}
    {byModel && <div className="details-usage">{live.usage.length ? live.usage.map(u => <div key={u.model}><span>{answers(u.model)}</span><span>{kTokens(u.tokensIn + u.tokensOut)}{localModel(u.model) ? ' · free' : ''}</span></div>) : <p className="panel-quiet">Tokens show here after the first reply.</p>}</div>}
    {shown.length === 1 && !s.turns.length && <p className="panel-quiet">Work, files and helpers show here while the team works.</p>}
    {shown.map(id => {
      const p = parts[id], meta = PANEL_PARTS.find(x => x.id === id)!, folded = prefs.folded.includes(id);
      return <section key={id} className="details-part" data-part={id} aria-label={meta.name} data-drag={drag === id || undefined}
        onDragOver={e => { e.preventDefault(); if (drag && drag !== id) setPrefsState(pr => { const order = pr.order.filter(x => x !== drag); order.splice(order.indexOf(id) + (pr.order.indexOf(drag) < pr.order.indexOf(id) ? 1 : 0), 0, drag); return { ...pr, order }; }); }}
        onDrop={() => { setDrag(null); setPrefs(prefs); }}>
        <header className="details-head" draggable onDragStart={() => setDrag(id)} onDragEnd={() => { setDrag(null); setPrefs(prefs); }}
          onContextMenu={(e: ReactMouseEvent) => menu.at(e, headerItems)}>
          <button type="button" className="details-fold" aria-expanded={!folded} onClick={() => fold(id)} onKeyDown={e => headerKey(e, id)} title="Fold or open (Space) · move (⌥↑ ⌥↓)">
            <span className="chat-project-chevron" data-open={!folded || undefined}><UiIcon name="chevron" size={11}/></span>{meta.name}</button>
          {folded ? <small className="details-sum" data-tone={p.tone}>{p.summary}</small> : p.side}
          <span className="details-grip" aria-hidden="true" title="Drag to move"><UiIcon name="grip" size={12}/></span>
        </header>
        {!folded && <div className="details-body">{p.body}{p.more}</div>}
      </section>;
    })}
    {notice && <p className="panel-quiet" role="alert">{notice}</p>}
    <ContextMenu menu={menu.menu} onClose={menu.close}/>
  </aside>;
}

/** CH8c: the hidden panel as a thin rail: one icon per part that has something, with a dot. */
export function DetailsRail({ controller, client, onOpen }: { controller: ConversationsController; client?: SessionClient; onOpen: (part: PanelPart) => void }) {
  const s = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const conv = s.conversations.find(c => c.id === s.activeId);
  const project = controller.activeProject();
  const running = s.turns.some(t => t.role === 'assistant' && t.status === 'running');
  // The MCP icon needs the owner's connection list (the same read the open panel makes).
  const owner = client?.getSnapshot().user?.role === 'owner';
  const [conns, setConns] = useState<{ on: number; needs: number }>({ on: 0, needs: 0 });
  useEffect(() => {
    if (!client || !owner) return;
    let on = true;
    void client.request({ method: 'GET', path: '/api/mcp/servers' } as never).then(r => {
      const list = r.status === 200 && Array.isArray((r.body as any)?.servers) ? ((r.body as any).servers as Record<string, unknown>[]).filter(x => x.enabled === true) : [];
      if (on) setConns({ on: list.length, needs: list.filter(x => !!x.lastError || x.active === false).length });
    }).catch(() => undefined);
    return () => { on = false; };
  }, [client, owner, s.activeId]);
  const items: { id: PanelPart; dot?: 'work' | 'needs'; label: string }[] = [
    { id: 'place', label: `Place${project?.folder ? ` · ${project.name}` : ''}` },
    ...(s.turns.length ? [{ id: 'team' as const, label: running ? 'Team · working' : 'Team', dot: running ? 'work' as const : conv?.waiting ? 'needs' as const : undefined }] : []),
    ...((s.git?.files ?? 0) > 0 || turnOutputs(s.turns).length ? [{ id: 'results' as const, label: 'Results' }] : []),
    ...(s.turns.some(t => t.role === 'assistant') ? [{ id: 'memory' as const, label: 'From memory' }] : []),
    ...(conns.on ? [{ id: 'mcp' as const, label: conns.needs ? 'MCP connections · needs you' : 'MCP connections', dot: conns.needs ? 'needs' as const : undefined }] : []),
  ];
  return <nav className="details-rail" aria-label="Side panel (hidden)">
    {items.map(i => <button key={i.id} type="button" className="row-tool" aria-label={i.label} title={`${i.label} (⌥⌘I)`} onClick={() => onOpen(i.id)}>
      <UiIcon name={PANEL_PARTS.find(p => p.id === i.id)!.icon} size={14}/>{i.dot && <span className="details-rail-dot" data-tone={i.dot}/>}</button>)}
  </nav>;
}

function Row({ icon, logo, face, badge, name, sub, end, onClick, indent, ltr, tone, items, onMenu }: { icon?: UiIconName; logo?: ReactNode; face?: string; badge?: ModelApp | null; name: string; sub?: ReactNode; end?: ReactNode; onClick?: () => void; indent?: boolean; ltr?: boolean; tone?: 'needs';
  /** CH8: right-click (or the menu key) on a row: open, copy, show in Finder, stop, remove from this chat. */
  items?: MenuItem[]; onMenu?: (e: ReactMouseEvent | ReactKeyboardEvent, items: MenuItem[]) => void }) {
  const context = items?.length && onMenu ? (e: ReactMouseEvent) => onMenu(e, items) : undefined;
  const inner = <>{face ? <span className="details-face" aria-hidden="true"><span className="composer-face">{face.slice(0, 1).toUpperCase()}</span>{badge && <span className="details-face-app" data-app={badge.id}><AppMark app={badge} size={8}/></span>}</span> : logo ? <span className="details-icon">{logo}</span> : icon ? <span className="details-icon"><UiIcon name={icon} size={13}/></span> : null}
    <span className="pop-text"><b dir={ltr ? 'ltr' : 'auto'} title={name}>{name}</b>{sub && <small data-tone={tone}>{sub}</small>}</span>{end}</>;
  return onClick ? <button type="button" className="details-row" data-indent={indent || undefined} onClick={onClick} onContextMenu={context}
      onKeyDown={context && onMenu && items ? e => { if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') onMenu(e, items); } : undefined}>{inner}</button>
    : <div className="details-row" data-indent={indent || undefined} onContextMenu={context}>{inner}</div>;
}
function StopButton({ onStop }: { onStop: () => void }) { return <button type="button" className="row-tool details-stop" aria-label="Stop" title="Stop (also stops the helpers it handed work to)" onClick={onStop}><UiIcon name="stop" size={10}/></button>; }
function ShowMore({ n, onClick }: { n: number; onClick: () => void }) { return <button type="button" className="link-button panel-more" onClick={onClick}>Show {n} more</button>; }
function Faces({ names }: { names: readonly string[] }) { return <span className="details-faces" aria-hidden="true">{names.slice(0, 3).map((n, i) => <span key={i} className="composer-face">{n.slice(0, 1).toUpperCase()}</span>)}</span>; }
