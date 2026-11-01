// CHAT-REBUILD-01: the chat page's state. Saved conversations (list, open,
// rename, pin, delete), sending a message as a run, following the run's
// events (and re-attaching after a dropped connection or a reload), Stop,
// and a queue of messages typed while the agent is still working.
import { SessionFailure } from './session-failure';
import type { SessionClient } from './session';
import { MAX_IMAGES, MAX_IMAGE_CHARS, MAX_MESSAGE, MAX_MESSAGE_BYTES, SIDEBAR_PATH, validRunId } from './conversation-contract.js';
import { DEFAULT_PREFS, readPrefs } from './chat-sidebar-prefs';
import { notifyDone } from './ChatMoments';
import type { SidebarPrefs } from './chat-sidebar-prefs';
import type { ChatMode, ChatThinking } from './conversation-contract.js';
import type { RunEvent, WireConversation, WireGit, WireMessage, WireProject } from './conversation-contract.js';
import { applyEvent, fromWire, liveTurn, userTurn } from './turns';
import { exportConversation } from './chat-export';
import type { ExportResult } from './chat-export';
import type { Turn } from './turns';

export type Conversation = WireConversation;
export type Project = WireProject;
/** about: the first words of the agent's description ("Frontend developer"), shown after its name; subAgentOf: whose sub-agent it is. */
export type AgentChoice = Readonly<{ id: string; name: string; department?: string | null; primary?: boolean; about?: string; subAgentOf?: string }>;
export type ModelOption = Readonly<{ id: string; provider: 'ollama' | 'claude' | 'lmstudio' | 'subscription'; label: string; size: string; think?: boolean; variants?: readonly Readonly<{ id: string; label: string; note?: string }>[] }>;
/** CH3: the Thinking choice applies (Auto and each agent's own pass it where the model can; Claude Code / Codex sessions; a listed model marked think). */
export const canThink = (model: string, models: readonly ModelOption[]): boolean => {
  if (model === 'auto' || !model) return true;
  const base = model.split('/')[0];
  return /^subscription:(?:claude|codex):[a-f0-9]{32}$/.test(base) || models.some(m => m.id === base && m.think === true);
};
export type ConversationsState = Readonly<{
  access: 'ready' | 'denied';
  listPhase: 'idle' | 'loading' | 'ready' | 'error';
  conversations: readonly Conversation[];
  activeId: string | null;
  meetingRevision?: number;
  threadPhase: 'empty' | 'loading' | 'ready' | 'error';
  turns: readonly Turn[];
  draft: string;
  agentId: string;
  /** CHAT-PRO-02 I: the agent writing the next reply in an open conversation ('' = the conversation's agent). */
  replyAgent: string;
  agents: readonly AgentChoice[];
  /** Models the owner can pick for the next reply ('' = the agent's own model). */
  models: readonly ModelOption[];
  /** True once the installed models were read (owner only): an empty list then means no model is ready. */
  modelsLoaded?: boolean;
  model: string;
  /** Projects (owner only) and the one the list is filtered to ('' = all chats). */
  projects: readonly Project[];
  projectFilter: string;
  /** Git state of the open conversation's project folder. */
  git: WireGit | null;
  runId: string | null;
  starting: boolean;
  stopping: boolean;
  reconnecting: boolean;
  queue: readonly { key: string; text: string }[];
  /** Text files attached to the next message (read in the browser). */
  attachments: readonly { name: string; text: string }[];
  /** CHAT-GAPS-01: images waiting to be sent with the next message (base64, checked again on the server). */
  images: readonly { key: string; name: string; type: string; data: string }[];
  /** After Stop the queue waits for the owner (Send now) instead of going on its own. */
  queuePaused: boolean;
  /** CH5 small state: the running reply was started in another window or tab; this one follows it and queues. */
  elsewhere: boolean;
  /** CHAT-PRO-02 D: a message to scroll to and highlight once (from search); `n` changes per request. */
  focus: Readonly<{ messageId: string; n: number }> | null;
  /** CHAT-BUILD-01: older messages are not loaded yet (long conversations open one page at a time). */
  hasEarlier: boolean;
  loadingEarlier: boolean;
  /** CHAT-BUILD-01 stage 2 (CH9): which sidebar sections show, their order and folded projects. */
  sidebar: SidebarPrefs;
  /** CHAT-BUILD-01 stage 3 (CH3): Mode and Thinking of the open chat (or the next new one). */
  mode: ChatMode;
  thinking: ChatThinking;
  notice?: string;
}>;

const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const RETRY_MS = [500, 1000, 2000, 4000, 8000];
/** CHAT-BUILD-01: messages per page when a conversation opens or shows earlier messages. */
export const PAGE_LIMIT = 100;
/** Retries of one send after a lost answer: the same runId, so the server never makes a second turn. */
const SEND_RETRY_MS = [600, 1500];
/** After an approval is decided, when the open chat looks again for the run the server continues it in (it may start a moment later). */
export const CONTINUE_RETRY_MS = [0, 300, 700, 1500, 3000, 5000];
const NOTICES: Record<string, (e: { waitSec?: number; model?: string }) => string> = {
  rate_limited: e => `The model provider asked to slow down. Waiting ${e.waitSec ?? 30} seconds, then the reply continues.`,
  claude_key_missing: e => `No Claude key is set, so this reply uses the local model${e.model ? ` (${e.model})` : ''}.`,
  local_model_slow: () => 'The local model stopped answering. The reply was ended; try again or pick another model.',
};
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;
export const ATTACH_FILE_CHARS = 60_000;
export const ATTACH_TOTAL_CHARS = 90_000;
const LANG: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', php: 'php', sh: 'bash', zsh: 'bash', sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml', md: 'markdown', html: 'html', css: 'css', csv: 'csv', xml: 'xml', toml: 'toml' };
/** The message text with each attached file as a fenced block. */
export function withAttachments(message: string, files: readonly { name: string; text: string }[]): string {
  if (!files.length) return message;
  // CHAT-BUILD-01: control characters in a file (not tab or line breaks) are dropped, so the message is never refused for them.
  const blocks = files.map(f => { const ext = f.name.split('.').at(-1)?.toLowerCase() ?? ''; const body = f.text.replace(CONTROL_CHARS, ''); const fence = body.includes('```') ? '~~~~' : '```'; return `Attached file \`${f.name.replace(CONTROL_CHARS, '')}\`:\n${fence}${LANG[ext] ?? ''}\n${body}\n${fence}`; });
  return [message || 'Please look at the attached files.', ...blocks].join('\n\n');
}


/** The typed text of a sent message and the files attached to it (withAttachments puts each file after the text). */
export function splitAttached(content: string): { text: string; files: { name: string; kb: number }[] } {
  const files: { name: string; kb: number }[] = [];
  const re = /\n\nAttached file `([^`\n]{1,200})`:\n(```|~~~~)[^\n]*\n([\s\S]*?)\n\2(?=\n\nAttached file `|$)/g;
  const first = content.search(/\n\nAttached file `[^`\n]{1,200}`:\n(```|~~~~)/);
  if (first < 0) return { text: content, files };
  for (const m of content.slice(first).matchAll(re)) files.push({ name: m[1], kb: Math.max(1, Math.ceil(m[3].length / 1024)) });
  return files.length ? { text: content.slice(0, first), files } : { text: content, files: [] };
}

const emptyState = (): ConversationsState => Object.freeze({
    access: 'ready', meetingRevision: 0, listPhase: 'idle', conversations: [], activeId: null, threadPhase: 'empty', turns: [], draft: '', agentId: '', replyAgent: '', agents: [], models: [], model: 'auto', projects: [], projectFilter: '', git: null,
    runId: null, starting: false, stopping: false, reconnecting: false, queue: [], queuePaused: false, elsewhere: false, attachments: [], images: [], focus: null, hasEarlier: false, loadingEarlier: false, sidebar: DEFAULT_PREFS, mode: 'auto', thinking: 'normal',
});

export class ConversationsController {
  #state: ConversationsState = emptyState();
  #listeners = new Set<() => void>();
  #unsubscribe: () => void;
  #epoch: number;
  #follow?: AbortController;
  #openSeq = 0;
  #pickSeq = 0;
  #disposed = false;
  #history: string[] = [];
  #replyRoundId: string | null = null;

  constructor(private readonly client: SessionClient, private readonly newId: () => string = () => crypto.randomUUID(), private readonly now: () => number = Date.now) {
    this.#epoch = client.getSnapshot().epoch;
    if (!this.allowed()) this.#state = Object.freeze({ ...this.#state, access: 'denied' });
    this.#unsubscribe = client.subscribe(() => { if (this.#epoch !== client.getSnapshot().epoch || !this.allowed()) this.clear(); });
  }
  private allowed() { const s = this.client.getSnapshot(); return s.phase === 'authenticated' && s.user?.role !== 'guest'; }
  private live() { return !this.#disposed && this.allowed() && this.#epoch === this.client.getSnapshot().epoch; }
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  private publish(patch: Partial<ConversationsState>) { if (this.#disposed) return; this.#state = Object.freeze({ ...this.#state, ...patch }); this.#listeners.forEach(fn => fn()); }
  private clear() {
    this.#follow?.abort();
    this.#openSeq++;
    this.#history = [];
    this.#modelsAt = 0;
    this.#modelSaveFailures.clear();
    this.publish({ ...emptyState(), access: 'denied', notice: undefined });
  }
  dispose() { this.#follow?.abort(); this.#unsubscribe(); this.#disposed = true; this.#listeners.clear(); }

  edit(draft: string) { this.publish({ draft: draft.slice(0, MAX_MESSAGE), ...(draft.length > MAX_MESSAGE ? { notice: `A message can be at most ${MAX_MESSAGE.toLocaleString('en')} characters. The rest was not added.` } : {}) }); }
  selectAgent(agentId: string) { if (!this.#state.activeId) this.publish({ agentId }); }
  /** In an open conversation: which agent writes the next replies ('' = the conversation's own agent). */
  setReplyAgent(agentId: string) { if (agentId === '' || this.#state.agents.some(a => a.id === agentId)) this.publish({ replyAgent: agentId }); }
  /** A paged meeting roster may include an invited agent outside the loaded chat picker page. */
  setMeetingReplyAgent(agent: AgentChoice) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agent.id) || !agent.name || agent.name.length > 200) return;
    const agents = this.#state.agents.some(a => a.id === agent.id) ? this.#state.agents.map(a => a.id === agent.id ? { ...a, name: agent.name, department: agent.department } : a) : [...this.#state.agents, { id: agent.id, name: agent.name, department: agent.department }];
    this.publish({ agents, replyAgent: agent.id });
  }

  /** The agent an "@Name" in the text points to (longest name wins), if any. */
  mentioned(text: string): AgentChoice | undefined {
    const lower = text.toLowerCase();
    return [...this.#state.agents].sort((a, b) => b.name.length - a.name.length)
      .find(a => { const i = lower.indexOf(`@${a.name.toLowerCase()}`); const next = lower[i + a.name.length + 1]; return i >= 0 && (i === 0 || /\s/.test(lower[i - 1])) && (next === undefined || !/[\p{L}\p{N}_]/u.test(next)); });
  }
  /** Adds text files to the next message; refuses files that are too big or not text. */
  attach(files: readonly { name: string; text: string }[]): string | null {
    const next = [...this.#state.attachments];
    for (const f of files) {
      if(next.some(x=>x.name===f.name.slice(0,120)))return `${f.name} is already attached. Remove it before adding another file with the same name.`;
      if (f.text.length > ATTACH_FILE_CHARS) return `${f.name} is too big (more than ${ATTACH_FILE_CHARS / 1000}k characters).`;
      if (/\u0000/.test(f.text)) return `${f.name} is not a text file.`;
      next.push({ name: f.name.slice(0, 120), text: f.text });
    }
    if (next.reduce((n, f) => n + f.text.length, 0) > ATTACH_TOTAL_CHARS) return 'Attached files are too big together.';
    this.publish({ attachments: next });
    return null;
  }
  detach(name: string) { this.publish({ attachments: this.#state.attachments.filter(f => f.name !== name) }); }
  /** CHAT-GAPS-01: images for the next message (PNG, JPEG, GIF, WebP; up to 4, 5 MB each). */
  attachImages(files: readonly { name: string; type: string; data: string }[]): string | null {
    const next = [...this.#state.images];
    for (const f of files) {
      if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.type)) return `${f.name}: only PNG, JPEG, GIF and WebP images can be attached.`;
      if (f.data.length > MAX_IMAGE_CHARS) return `${f.name} is too big (an image can be up to 5 MB).`;
      if (next.length >= MAX_IMAGES) return `Up to ${MAX_IMAGES} images go with one message.`;
      next.push({ key: this.newId(), name: f.name.slice(0, 120), type: f.type, data: f.data });
    }
    this.publish({ images: next });
    return null;
  }
  detachImage(key: string) { this.publish({ images: this.#state.images.filter(i => i.key !== key) }); }

  /** The last sent message (↑ in an empty composer). */
  recall(): string | undefined { return this.#history.at(-1); }

  private async call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    if (!this.live()) return { status: 403, body: null };
    const r = await this.client.request(body === undefined ? { method, path } as never : { method, path, body } as never);
    return this.live() ? r : { status: 403, body: null };
  }

  async load() {
    if (!this.live() || this.#state.listPhase === 'loading') return;
    this.publish({ listPhase: 'loading' });
    try {
      const r = await this.call('GET', '/api/chat/conversations');
      if (!this.live()) return;
      if (r.status !== 200 || !record(r.body) || !Array.isArray(r.body.conversations)) { this.publish({ listPhase: 'error' }); return; }
      this.publish({ listPhase: 'ready', conversations: r.body.conversations as Conversation[] });
    } catch { if (this.live()) this.publish({ listPhase: 'error' }); }
    void this.loadAgents();
    void this.loadModels();
    void this.loadProjects();
    void this.call('GET', '/api/chat/settings').then(r => { if (r.status === 200 && record(r.body) && record(r.body.settings)) this.#notifyDone = r.body.settings.notifyDone !== false; }).catch(() => undefined);
  }
  /** CH10: Settings › General can turn off the notice when long work ends in the background. */
  #notifyDone = true;

  /** The team for the agent picker (owner only; others talk to the primary agent). */
  #modelsAt = 0;
  /**
   * Installed models for the picker (owner only; others use the agent's model):
   * whatever runs on this computer right now (Ollama, LM Studio) plus Claude
   * with a key. `refresh` asks again (at most every 5 s), so a local server
   * started later shows up when the picker is opened.
   */
  async loadModels(refresh = false) {
    if (!this.live() || this.client.getSnapshot().user?.role !== 'owner' || (this.#state.models.length && !refresh)) return;
    if (refresh && Date.now() - this.#modelsAt < 5000) return;
    this.#modelsAt = Date.now();
    try {
      const r = await this.client.request({ method: 'GET', path: '/api/models' } as never);
      if (!this.live() || r.status !== 200 || !record(r.body) || !Array.isArray(r.body.models)) return;
      const models = r.body.models as ModelOption[];
      // A picked model that is gone (its server stopped) stays picked: the reply then says why it failed.
      this.publish({ modelsLoaded: true, models: this.#state.model && !models.some(m => m.id === this.#state.model) ? [...models, ...this.#state.models.filter(m => m.id === this.#state.model)] : models });
    } catch { /* the picker stays as it was */ }
  }
  async loadProjects() {
    if (!this.live() || this.client.getSnapshot().user?.role !== 'owner') return;
    try {
      const r = await this.call('GET', '/api/chat/projects');
      if (this.live() && r.status === 200 && record(r.body) && Array.isArray(r.body.projects)) this.publish({ projects: r.body.projects as Project[] });
    } catch { /* projects stay hidden */ }
  }
  /** Shows only one project's conversations ('' = all); a new chat goes into it. */
  filterProject(id: string) { if (id === '' || this.#state.projects.some(p => p.id === id)) this.publish({ projectFilter: id }); }
  async browseProjectFolders(path?:string):Promise<{path:string;parent:string|null;selectable:boolean;truncated:boolean;entries:{name:string;path:string}[]}>{
    const r=await this.call('POST','/api/chat/project-folders',path?{path}:{});
    if(r.status!==200)throw Error('Folder unavailable');return r.body as never;
  }
  /** Creates a project; resolves with an error message for the form, or null on success. */
  async createProject(input: { name: string; folder: string; repoUrl: string; folders?: { path: string; write: boolean }[] }): Promise<string | null> {
    const body: Record<string, unknown> = { name: input.name.trim(), ...(input.folders?.length ? { folders: input.folders } : {}) };
    if (input.folder.trim()) body.folder = input.folder.trim();
    if (input.repoUrl.trim()) body.repoUrl = input.repoUrl.trim();
    if (!body.name) return 'Give the project a name.';
    if (!body.folder) return 'Choose a working folder for this project, or use General chat.';
    try {
      const r = await this.call('POST', '/api/chat/projects', body);
      if ((r.status === 201 || r.status === 200) && record(r.body) && record(r.body.project)) {
        const p = r.body.project as Project;
        this.lastCreatedProject = p.id;
        this.publish({ projects: [...this.#state.projects, p].sort((a, b) => a.name.localeCompare(b.name)), projectFilter: p.id });
        this.newChat();
        return null;
      }
      return r.status === 400 ? 'Check the folder: it must be a full path to an existing folder (not the whole disk or your home folder). The repo must be an https or git@ address.' : 'The project was not created.';
    } catch { return 'The project was not created (no connection).'; }
  }
  /** Renames a project or changes its folder or repo (empty folder/repo clears it). */
  async editProject(id: string, input: { name: string; folder: string; repoUrl: string; folders?: { path: string; write: boolean }[] }): Promise<string | null> {
    const name = input.name.trim();
    if (!name) return 'Give the project a name.';
    try {
      const r = await this.call('PUT', `/api/chat/projects/${id}`, { name, folder: input.folder.trim() || null, repoUrl: input.repoUrl.trim() || null, ...(input.folders ? { folders: input.folders } : {}) });
      if (r.status === 200 && record(r.body) && record(r.body.project)) {
        const p = r.body.project as Project;
        this.publish({ projects: this.#state.projects.map(x => (x.id === id ? p : x)).sort((a, b) => a.name.localeCompare(b.name)) });
        void this.loadGit();
        return null;
      }
      return r.status === 400 ? 'Check the folder: it must be a full path to an existing folder (not the whole disk or your home folder). The repo must be an https or git@ address.' : 'The project was not saved.';
    } catch { return 'The project was not saved (no connection).'; }
  }
  async removeProject(id: string) {
    const r = await this.call('DELETE', `/api/chat/projects/${id}`);
    if (!this.live() || r.status !== 200) return;
    this.publish({ projects: this.#state.projects.filter(p => p.id !== id), projectFilter: this.#state.projectFilter === id ? '' : this.#state.projectFilter,
      conversations: this.#state.conversations.map(c => (c.projectId === id ? { ...c, projectId: null } : c)) });
  }
  /** Moves a conversation into a project (or out with ''). */
  async moveToProject(conversationId: string, projectId: string) {
    const r = await this.call('PUT', `/api/chat/conversations/${conversationId}`, { projectId: projectId || null });
    if (this.live() && r.status === 200 && record(r.body) && record(r.body.conversation)) { this.replace(r.body.conversation as Conversation); if (conversationId === this.#state.activeId) void this.loadGit(); }
    // CH5: a chat that already worked in its folder stays there.
    else if (this.live() && r.status === 409) this.publish({ notice: 'This chat already worked in its folder. Continue in another folder… starts a new chat there.' });
  }
  /** The open conversation's project (if any). */
  activeProject(): Project | undefined {
    const c = this.#state.conversations.find(x => x.id === this.#state.activeId);
    const id = c?.projectId ?? (this.#state.activeId ? null : this.#state.projectFilter || null);
    return id ? this.#state.projects.find(p => p.id === id) : undefined;
  }
  #codeDrafts: Map<string, Pick<ConversationsState, 'draft' | 'attachments' | 'images'>> | null = null;
  private codeDraftFor(next: string) {
    if (!this.#codeDrafts || next === this.#state.activeId) return {};
    this.#codeDrafts.set(this.#state.activeId ?? '_new', { draft: this.#state.draft, attachments: this.#state.attachments, images: this.#state.images });
    return this.#codeDrafts.get(next) ?? {draft:'',attachments:[],images:[]};
  }
  /** Code uses an ordinary project chat, while a meeting and its unsent draft remain separate. */
  async ensureCodeConversation(): Promise<string | null> {
    const current=this.#state.conversations.find(c=>c.id===this.#state.activeId);
    if(current&&!current.meeting)return current.id;
    const projectId=current?.projectId??this.#state.projectFilter??'';
    let target=this.#state.conversations.find(c=>!c.meeting&&(c.projectId??'')===(projectId??''));
    if(!target){
      try {
        const response=await this.call('POST','/api/chat/conversations',{title:'Code',...(projectId?{projectId}:{}),...(current?.agentId?{agentId:current.agentId}:{})});
        if(response.status!==201||!record(response.body))return null;
        target=response.body.conversation as Conversation;this.publish({conversations:[target,...this.#state.conversations.filter(c=>c.id!==target!.id)]});
      }catch{return null;}
    }
    this.#codeDrafts??=new Map();
    const freshDraft=!current?{draft:this.#state.draft,attachments:this.#state.attachments,images:this.#state.images}:null;
    if(freshDraft)this.#codeDrafts.set(target.id,freshDraft);
    await this.open(target.id);
    if(freshDraft)this.#codeDrafts.delete('_new');
    return this.#state.activeId===target.id&&this.#state.threadPhase==='ready'?target.id:null;
  }
  async editorDirectory(): Promise<string | null> {
    const id = this.#state.activeId;
    if (!id || !this.live()) return null;
    try {
      const r = await this.call('POST', `/api/chat/conversations/${id}/editor-directory`);
      if (this.#state.activeId !== id) return null;
      return r.status === 200 && record(r.body) && typeof r.body.folder === 'string' ? r.body.folder : null;
    } catch { this.publish({notice:'Could not open this chat folder in Code.'}); return null; }
  }
  /** Reloads the project's git state (branch, changes, ahead/behind). */
  refreshGit() { return this.loadGit(); }
  private async loadGit() {
    const p = this.activeProject();
    if (!p?.folder) { this.publish({ git: null }); return; }
    try {
      const r = await this.call('GET', `/api/chat/projects/${p.id}/git`);
      if (this.live() && r.status === 200 && record(r.body)) this.publish({ git: r.body.git as WireGit });
    } catch { this.publish({ git: null }); }
  }

  resumeCodingSession(id:string,source:'claude-code'|'codex'){
    const project=this.activeProject();if(!this.live()||!project?.folder||!/^[a-f0-9]{32}$/.test(id))return;
    const model='subscription:'+(source==='claude-code'?'claude':'codex')+':'+id;this.filterProject(project.id);this.newChat();
    this.publish({model,models:[...this.#state.models.filter(m=>m.id!==model),{id:model,provider:'subscription',label:(source==='codex'?'Codex':'Claude Code')+' · previous session',size:''}]});
  }
  #modelWrites: Promise<void> = Promise.resolve();
  #pendingModelWrites = 0;
  #modelSaveFailures = new Set<string>();
  /** CORE-PICKER-02: a listed coding app (or this chat's previous session of it) with one of the app's own models. */
  #appModel(model:string):boolean{
    const m=/^(subscription:(claude|codex|gemini))(:[a-f0-9]{32})?(?:\/([a-z0-9][a-z0-9.-]{0,40}))?$/.exec(model);if(!m||(m[2]==='gemini'&&m[3]))return false;
    const app=this.#state.models.find(x=>x.id===m[1]&&x.provider==='subscription');if(!app)return false;
    if(m[3]&&!this.#state.model.startsWith(m[1]+m[3]))return false;
    return !m[4]||!!app.variants?.some(v=>v.id===m[4]);
  }
  selectModel(model: string) {
    if(!this.live() || !(model===''||model==='auto'||this.#state.models.some(m=>m.id===model)||this.#appModel(model)))return;
    this.publish({model});const id=this.#state.activeId;if(!id)return;
    this.#pendingModelWrites++;
    this.#modelWrites=this.#modelWrites.then(async()=>{
      if(!this.live())return;
      try{const r=await this.call('PUT',`/api/chat/conversations/${id}`,{model});
        if(r.status!==200||!record(r.body)||!record(r.body.conversation))throw Error();
        this.#modelSaveFailures.delete(id);if(this.live())this.replace(r.body.conversation as Conversation);
      }catch{if(!this.live())return;this.#modelSaveFailures.add(id);if(this.live()&&this.#state.activeId===id)this.publish({notice:'The model choice was not saved. Choose it again before sending.'});}
    }).finally(()=>{this.#pendingModelWrites--;});
  }

  async loadAgents() {
    if (!this.live() || this.client.getSnapshot().user?.role !== 'owner' || this.#state.agents.length) return;
    try {
      const r = await this.client.request({ method: 'GET', path: '/api/agents' });
      if (!this.live() || r.status !== 200 || !record(r.body) || !Array.isArray(r.body.agents)) return;
      const about = (d: unknown) => { const t = typeof d === 'string' ? d.split(/[.\n]/)[0].trim() : ''; return t && t.length <= 64 ? t : ''; };
      this.publish({ agents: (r.body.agents as { id: string; name?: string; department?: string | null; isPrimary?: boolean; description?: string; subAgentOf?: string | null }[]).map(a => ({ id: a.id, name: a.name ?? a.id, department: typeof a.department === 'string' ? a.department : null, ...(a.isPrimary ? { primary: true } : {}), ...(about(a.description) ? { about: about(a.description) } : {}), ...(typeof a.subAgentOf === 'string' && a.subAgentOf ? { subAgentOf: a.subAgentOf } : {}) })) });
    } catch { /* the picker stays on the primary agent */ }
  }

  /** CH11: the chat that is open is kept on the server, so the next sign-in opens it again. */
  #last: string | null | undefined;
  private rememberLast(id: string | null) {
    if (this.#last === id || !this.live()) return;
    this.#last = id;
    void this.call('PUT', '/api/chat/last', { last: id }).catch(() => undefined);
  }
  /** Open the chat that was open last time, if it still exists and nothing else was opened meanwhile. */
  async restoreLast() {
    try {
      const r = await this.call('GET', '/api/chat/last');
      const id = r.status === 200 && record(r.body) && typeof r.body.last === 'string' ? r.body.last : null;
      if (id && this.live() && !this.#state.activeId && this.#state.conversations.some(c => c.id === id)) await this.open(id);
    } catch { /* a new chat then */ }
  }

  /** A blank conversation (created on the first message). */
  newChat() {
    this.#follow?.abort(); this.#openSeq++;
    this.rememberLast(null);
    this.publish({ ...this.codeDraftFor('_new'), activeId: null, model: 'auto', turns: [], threadPhase: 'empty', runId: null, starting: false, stopping: false, reconnecting: false, queue: [], queuePaused: false, elsewhere: false, notice: undefined, agentId: '', replyAgent: '', git: null, focus: null, hasEarlier: false, loadingEarlier: false, mode: 'auto', thinking: 'normal' });
    void this.loadGit();
  }

  /** "New chat here" (sidebar) and ⌥⌘N: a blank conversation in a project ('' = no project). */
  newChatIn(projectId: string) { this.filterProject(projectId); this.newChat(); }

  async open(id: string) {
    if (!this.live()) return;
    this.#follow?.abort();
    this.rememberLast(id);
    const seq = ++this.#openSeq;
    const known = this.#state.conversations.find(c => c.id === id);
    this.publish({ ...this.codeDraftFor(id), activeId: id, turns: [], threadPhase: 'loading', runId: null, starting: false, stopping: false, reconnecting: false, queue: [], queuePaused: false, elsewhere: false, notice: undefined, agentId: known?.agentId ?? '', model: known?.model ?? '', replyAgent: '', focus: null, hasEarlier: false, loadingEarlier: false });
    try {
      await this.#modelWrites;if(!this.live()||seq!==this.#openSeq)return;
      const r = await this.call('GET', `/api/chat/conversations/${id}/messages?limit=${PAGE_LIMIT}`);
      if (!this.live() || seq !== this.#openSeq) return;
      if (r.status === 404) { this.publish({ threadPhase: 'error', notice: 'This conversation no longer exists.', conversations: this.#state.conversations.filter(c => c.id !== id) }); return; }
      if (r.status !== 200 || !record(r.body)) { this.publish({ threadPhase: 'error', notice: 'The conversation could not be loaded.' }); return; }
      const messages = r.body.messages as WireMessage[];
      const roundAgent = this.readReplyRound(r.body);
      const active = r.body.activeRunId as string | null;
      // A running turn is rebuilt from its events, not from a stored row.
      const turns = messages.map(fromWire);
      if (active) turns.push(liveTurn(active, this.now(), roundAgent));
      const conversation=r.body.conversation as Conversation;this.replace(conversation);
      // CHAT-BUILD-01 stage 3: messages that waited when the window closed wait again (Send now sends them).
      const waiting = conversation.queued ?? [];
      this.publish({ turns, threadPhase: 'ready', runId: active, model: conversation.model ?? '', hasEarlier: r.body.hasMore === true,
        mode: conversation.mode ?? 'auto', thinking: conversation.thinking ?? 'normal', queue: waiting, queuePaused: waiting.length > 0 && !active, elsewhere: !!active });
      void this.loadGit();
      if (active) void this.follow(active, seq);
      else if (this.#replyRoundId) void this.finished(seq);
    } catch { if (this.live() && seq === this.#openSeq) this.publish({ threadPhase: 'error', notice: 'The conversation could not be loaded.' }); }
  }

  /** CHAT-BUILD-01: picks up a turn the server started by itself (the chat continuing after an approval). */
  /** True when it showed something new (a running reply it now follows, or saved messages). */
  async refreshActive(): Promise<boolean> {
    const id = this.#state.activeId;
    if (!this.live() || !id || this.#state.runId || this.#state.starting || this.#state.threadPhase !== 'ready') return false;
    const seq = this.#openSeq;
    try {
      const r = await this.call('GET', `/api/chat/conversations/${id}/messages?limit=${PAGE_LIMIT}`);
      if (!this.live() || seq !== this.#openSeq || this.#state.runId || this.#state.starting || r.status !== 200 || !record(r.body) || !Array.isArray(r.body.messages)) return false;
      const page = (r.body.messages as WireMessage[]).map(fromWire);
      const roundAgent = this.readReplyRound(r.body);
      const active = r.body.activeRunId as string | null;
      const shown = new Set(this.#state.turns.map(t => t.key));
      if (!active && page.every(t => shown.has(t.key))) { if (this.#replyRoundId) void this.finished(seq); return !!this.#replyRoundId; }
      const fresh = new Set(page.map(t => t.key));
      const runs = new Set(page.map(t => t.runId).filter(Boolean));
      const kept = this.#state.turns.filter(t => !fresh.has(t.key) && !t.key.startsWith('run:') && !t.key.startsWith('pending:') && !(t.runId && runs.has(t.runId)));
      this.publish({ turns: [...kept, ...page, ...(active ? [liveTurn(active, this.now(), roundAgent)] : [])], runId: active });
      if (active) void this.follow(active, seq);
      else if (this.#replyRoundId) void this.finished(seq);
      return true;
    } catch { return false; /* the next refresh tries again */ }
  }

  /** An approval of the open chat was decided (in the chat or on the Approvals page): the server continues the chat in a
   * new run, maybe a moment after it answered. Looks again a few times (bounded) and follows that run like opening the chat. */
  async pickUpContinuation(delays: readonly number[] = CONTINUE_RETRY_MS) {
    const id = this.#state.activeId, seq = this.#openSeq, mine = ++this.#pickSeq;
    if (!id) return;
    for (const ms of delays) {
      if (ms) await new Promise(r => setTimeout(r, ms));
      if (!this.live() || seq !== this.#openSeq || id !== this.#state.activeId || mine !== this.#pickSeq) return;
      // A reply still shown as running ends first; the continuation starts only after it.
      if (!this.#state.runId && await this.refreshActive()) return;
    }
  }

  /** CHAT-BUILD-01: loads the page of messages before the oldest one shown. */
  async loadEarlier() {
    const id = this.#state.activeId;
    const oldest = this.#state.turns.find(t => !t.key.startsWith('pending:') && !t.key.startsWith('run:') && !t.key.startsWith('user:'));
    if (!this.live() || !id || !this.#state.hasEarlier || this.#state.loadingEarlier || !oldest) return;
    const seq = this.#openSeq;
    this.publish({ loadingEarlier: true });
    try {
      const r = await this.call('GET', `/api/chat/conversations/${id}/messages?limit=${PAGE_LIMIT}&before=${encodeURIComponent(oldest.key)}`);
      if (!this.live() || seq !== this.#openSeq) return;
      if (r.status !== 200 || !record(r.body) || !Array.isArray(r.body.messages)) { this.publish({ loadingEarlier: false, notice: 'Earlier messages could not be loaded.' }); return; }
      const shown = new Set(this.#state.turns.map(t => t.key));
      const older = (r.body.messages as WireMessage[]).map(fromWire).filter(t => !shown.has(t.key));
      this.publish({ turns: [...older, ...this.#state.turns], hasEarlier: r.body.hasMore === true, loadingEarlier: false });
    } catch { if (this.live() && seq === this.#openSeq) this.publish({ loadingEarlier: false, notice: 'Earlier messages could not be loaded.' }); }
  }

  /** Opens a conversation (if it is not open yet) and asks the view to show one message (search hit). */
  async openAt(id: string, messageId: string | null) {
    if (!this.live()) return;
    if (this.#state.activeId !== id || this.#state.threadPhase === 'error') await this.open(id);
    if (!this.live() || this.#state.activeId !== id || !messageId) return;
    this.publish({ focus: { messageId, n: (this.#state.focus?.n ?? 0) + 1 } });
  }
  clearFocus() { if (this.#state.focus) this.publish({ focus: null }); }

  /** Sends the draft (or `text`); while the agent works, the message waits in the queue. */
  async send(text?: string, frame?: { name: string; type: string; data: string }) {
    if (frame && (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(frame.type) || frame.data.length > MAX_IMAGE_CHARS)) { this.publish({ notice: 'The meeting frame is not a supported image or is too large. Nothing was sent.' }); return; }
    const files = text === undefined ? this.#state.attachments : [];
    const images = frame ? [{ ...frame, name: frame.name.slice(0,120), key: this.newId() }] : text === undefined ? this.#state.images : [];
    const typed = text ?? this.#state.draft;
    const message = withAttachments((text ?? this.#state.draft).trim() || (images.length ? `(${images.length === 1 ? 'An image' : `${images.length} images`} attached)` : ''), files);
    if (!this.live() || !message) return;
    // CHAT-BUILD-01: never refuse silently; say why and keep the text in the box.
    if (message.length > MAX_MESSAGE || new TextEncoder().encode(JSON.stringify(message)).length > MAX_MESSAGE_BYTES) {
      this.publish({ notice: files.length ? 'The message with its attached files is too long to send. Remove a file or shorten the text.' : 'The message is too long to send. Shorten it or attach it as a file.' });
      return;
    }
    if(this.#pendingModelWrites)await this.#modelWrites;if(!this.live())return;
    if(this.#state.activeId&&this.#modelSaveFailures.has(this.#state.activeId)){this.publish({notice:'The model choice was not saved. Choose it again before sending.'});return;}
    const attendanceControl = !!this.#state.conversations.find(c=>c.id===this.#state.activeId)?.meeting && !images.length && /(?:يحضر|تحضر|احضر|حضروا|انضم|يدخل|استدع|ادعو|تخرج|يخرج|يطلع|انسحب|ينسحب|يبقى|يبقون|خلي|فقط|قسم|\binvite\b|\bdismiss\b|\bkeep\b|\bleave\b|\bonly\b)/iu.test(message);
    if ((this.#state.runId || this.#state.starting) && images.length) { this.publish({ notice: 'Images go with a message once the team is done with this one. Send them after the reply.' }); return; }
    if ((this.#state.runId || this.#state.starting) && (!attendanceControl || this.#state.starting)) {
      this.publish({ queue: [...this.#state.queue, { key: this.newId(), text: message }], ...(text === undefined ? { draft: '' } : {}) });
      this.#saveQueue(this.#state.activeId, this.#state.queue);
      return;
    }
    const seq = this.#openSeq;
    this.#history.push(message);
    let runId: string;
    try { runId = `run-${this.newId()}`; } catch { this.publish({ notice: 'A secure id is not available here. Nothing was sent.' }); return; }
    if (!validRunId(runId)) return;
    const optimistic = userTurn(`pending:${runId}`, message, runId, true);
    this.publish({ starting: true, notice: undefined, turns: [...this.#state.turns, optimistic], threadPhase: 'ready', ...(text === undefined ? { draft: '', attachments: [], images: [] } : {}) });
    try {
      let id = this.#state.activeId;
      const named = this.mentioned(message)?.id;
      if (!id) {
        const c = await this.call('POST', '/api/chat/conversations', { ...(this.#state.model?{model:this.#state.model}:{}), ...(this.#state.mode !== 'auto' ? { mode: this.#state.mode } : {}), ...(this.#state.thinking !== 'normal' && canThink(this.#state.model, this.#state.models) ? { thinking: this.#state.thinking } : {}), ...((named ?? this.#state.agentId) ? { agentId: named ?? this.#state.agentId } : {}), ...(this.#state.projectFilter ? { projectId: this.#state.projectFilter } : {}) });
        if (!this.live() || seq !== this.#openSeq) return;
        if ((c.status !== 201 && c.status !== 200) || !record(c.body) || !record(c.body.conversation)) throw new SessionFailure('unavailable');
        const conv = c.body.conversation as Conversation;
        id = conv.id;
        this.publish({ activeId: id, conversations: [conv, ...this.#state.conversations.filter(x => x.id !== id)] });
        this.rememberLast(id);
      }
      // CHAT-PRO-02 I: "@Name" or the reply picker chooses who writes this reply.
      const convAgent = this.#state.conversations.find(x => x.id === id)?.agentId ?? (this.#state.agentId || null);
      const writer = named ?? (this.#state.replyAgent || undefined);
      const agentForRun = writer && writer !== convAgent ? writer : undefined;
      if (named && named !== this.#state.replyAgent && this.#state.activeId) this.publish({ replyAgent: named === convAgent ? '' : named });
      // CHAT-GAPS-01: images are saved with the chat first; the message names them.
      const imageIds: string[] = [];
      for (const img of images) {
        const u = await this.call('POST', `/api/chat/conversations/${id}/images`, { data: img.data, name: img.name });
        if (!this.live() || seq !== this.#openSeq) return;
        if (u.status !== 201 || !record(u.body) || !record(u.body.image) || typeof u.body.image.id !== 'string') {
          this.publish({ starting: false, turns: this.#state.turns.filter(t => t !== optimistic), draft: this.#state.draft || typed, attachments: files, images: frame ? this.#state.images : images,
            notice: `${img.name} could not be attached${record(u.body) && typeof u.body.error === 'string' ? `: ${u.body.error}` : '.'} Nothing was sent.` });
          return;
        }
        imageIds.push(u.body.image.id);
      }
      const body = { runId, message, ...(this.#state.model ? { model: this.#state.model } : {}), ...(agentForRun ? { agentId: agentForRun } : {}), ...(imageIds.length ? { images: imageIds } : {}) };
      // CHAT-BUILD-01: a lost answer is retried with the same runId; the server returns the accepted turn instead of a second one.
      let r: Awaited<ReturnType<typeof this.call>> | undefined;
      for (let attempt = 0; !r; attempt++) {
        try { r = await this.call('POST', `/api/chat/conversations/${id}/runs`, body); }
        catch (error) {
          if (attempt >= SEND_RETRY_MS.length || !(error instanceof SessionFailure) || error.code !== 'unavailable' || !this.live() || seq !== this.#openSeq) throw error;
          await new Promise(res => setTimeout(res, SEND_RETRY_MS[attempt]));
        }
      }
      if (!this.live() || seq !== this.#openSeq) return;
      if (r.status === 409 && record(r.body) && r.body.code === 'conversation_busy' && typeof r.body.runId === 'string') {
        // Another tab is still answering here: wait in the queue and follow that run.
        this.publish({ starting: false, turns: this.#state.turns.filter(t => t !== optimistic), queue: [{ key: runId, text: message }, ...this.#state.queue], runId: r.body.runId, elsewhere: true, notice: undefined });
        this.#saveQueue(id, this.#state.queue);
        this.publish({ turns: [...this.#state.turns, liveTurn(r.body.runId, this.now())] });
        void this.follow(r.body.runId, seq);
        return;
      }
      if (r.status !== 202 || !record(r.body)) {
        const code = record(r.body) ? r.body.code : undefined;
        this.publish({ starting: false, turns: this.#state.turns.filter(t => t !== optimistic), draft: this.#state.draft || message,
          notice: code === 'attendance_needs_scope' ? 'Specify the department and whether to invite, dismiss or keep its participants.' : code === 'group_too_large' ? 'Choose up to 20 speakers here, or use a meeting round for a larger group.' : code === 'ambiguous_group_mentions' ? 'Two agents share a mentioned name. Choose the intended agent before sending.' : code === 'group_paused' ? 'The group paused before starting. Send a new request when you are ready.' : code === 'rate_limited' ? 'Too many conversations are answering right now. Your message is back in the box; send it again in a moment.' : r.status === 413 ? 'The message is too long to send. Shorten it or attach it as a file.' : 'The message was not sent. It is back in the box.' });
        return;
      }
      if (r.body.completed === true && record(r.body.assistantMessage)) { this.publish({ starting:false, runId:null, meetingRevision:(this.#state.meetingRevision??0)+1, turns:this.#state.turns.filter(t=>t!==optimistic) });await this.open(id);void this.refreshList();return; }
      this.readReplyRound(r.body);
      const roundSpeaker = record(r.body.replyRound) && record(r.body.replyRound.speaker) && typeof r.body.replyRound.speaker.id === 'string' ? r.body.replyRound.speaker.id : agentForRun;
      const stored = record(r.body.userMessage) ? fromWire(r.body.userMessage as WireMessage) : userTurn(`user:${runId}`, message, runId);
      this.publish({ starting: false, runId, elsewhere: false, turns: [...this.#state.turns.filter(t => t !== optimistic), stored, liveTurn(runId, this.now(), roundSpeaker)] });
      void this.follow(runId, seq);
      void this.refreshList(); // the first message names the conversation
    } catch {
      if (this.live() && seq === this.#openSeq) this.publish({ starting: false, turns: this.#state.turns.filter(t => t !== optimistic), draft: this.#state.draft || message, notice: 'The message was not sent (no connection). It is back in the box.' });
    }
  }

  /** Follows a run until its end event, re-attaching after drops with the last sequence number. */
  private async follow(runId: string, openSeq: number) {
    this.#follow?.abort();
    const controller = new AbortController(); this.#follow = controller;
    let after = this.#state.turns.find(t => t.runId === runId && t.role === 'assistant')?.lastSeq ?? 0;
    let failures = 0;
    const current = () => !controller.signal.aborted && this.live() && openSeq === this.#openSeq;
    while (current()) {
      const began = Date.now();
      try {
        const { last, ended } = await this.client.runEvents(runId, after, e => this.onEvent(runId, e), controller.signal);
        if (!current()) return;
        const progressed = last > after;
        if (progressed) failures = 0;
        after = last;
        if (this.#state.reconnecting) this.publish({ reconnecting: false });
        if (ended) { await this.finished(openSeq); return; }
        // A reader that closed with nothing new waits a moment before re-attaching (never a tight loop).
        if (!progressed && Date.now() - began < 2000) { if (++failures > RETRY_MS.length * 4) throw new SessionFailure('unavailable'); await new Promise(r => setTimeout(r, 400)); }
      } catch (error) {
        if (!current()) return;
        if (error instanceof SessionFailure && error.code === 'cancelled') return;
        // A restarted backend no longer has this in-memory SSE run. Read the
        // saved turn before retrying the stream; never resend the user message.
        const id = this.#state.activeId;
        if (id) {
          try {
            const saved = await this.call('GET', `/api/chat/conversations/${id}/messages?limit=${PAGE_LIMIT}`);
            if (!current()) return;
            if (saved.status === 200 && record(saved.body) && Array.isArray(saved.body.messages)
              && !saved.body.activeRunId && saved.body.messages.some((m: WireMessage) => m.role === 'assistant' && m.runId === runId)) {
              const page = (saved.body.messages as WireMessage[]).map(fromWire);
              // Older loaded turns stay; the page replaces the newest ones (and the live turn).
              const fresh = new Set(page.map(t => t.key));
              const first = this.#state.turns.findIndex(t => fresh.has(t.key));
              const kept = (first < 0 ? this.#state.turns : this.#state.turns.slice(0, first)).filter(t => !fresh.has(t.key) && t.runId !== runId && t.status !== 'running');
              const turns = [...kept, ...page];
              this.publish({ turns, runId: null, stopping: false, reconnecting: false, elsewhere: false, queuePaused: this.#state.queue.length > 0,
                notice: turns.some(t => t.runId === runId && t.code === 'run_interrupted') ? 'Work interrupted by restart. Review the saved checkpoints, then continue safely.' : undefined });
              return;
            }
          } catch { /* A transient outage keeps the bounded reconnect path. */ }
        }
        if (failures >= RETRY_MS.length) {
          // CHAT-BUILD-01: waiting messages never get stuck: they wait for Send now.
          this.publish({ reconnecting: false, runId: null, elsewhere: false, queuePaused: this.#state.queue.length > 0, notice: 'Lost the connection to this reply. Reopen the conversation to check its saved state before retrying.' });
          this.finishLive('error');
          return;
        }
        this.publish({ reconnecting: true });
        await new Promise(r => setTimeout(r, RETRY_MS[failures++]));
      }
    }
  }

  private onEvent(runId: string, e: RunEvent) {
    if (e.type === 'notice') this.publish({ notice: NOTICES[e.code]?.(e) });
    const turns = this.#state.turns.map(t => (t.role === 'assistant' && t.runId === runId ? applyEvent(t, e, this.now()) : t));
    this.publish({ turns });
  }

  private finishLive(status: 'error') {
    this.publish({ turns: this.#state.turns.map(t => (t.status === 'running' ? { ...t, status } : t)) });
  }

  private readReplyRound(body: Record<string, unknown>) {
    const round = record(body.replyRound) ? body.replyRound : null;
    this.#replyRoundId = round?.state === 'active' && typeof round.id === 'string' ? round.id : null;
    if (round && record(round.speaker) && typeof round.speaker.id === 'string' && typeof round.speaker.name === 'string') {
      const speaker = { id: round.speaker.id, name: round.speaker.name, department: typeof round.speaker.department === 'string' ? round.speaker.department : null };
      this.publish({ agents: this.#state.agents.some(a => a.id === speaker.id) ? this.#state.agents.map(a => a.id === speaker.id ? { ...a, ...speaker } : a) : [...this.#state.agents, speaker] });
      return speaker.id;
    }
  }

  /** Follow saved participant runs, including the short handoff between two writers. */
  private async followReplyRound(endedRun: string | null, seq: number): Promise<'following' | 'paused' | 'complete'> {
    const id = this.#state.activeId, roundId = this.#replyRoundId;
    if (!id || !roundId) return 'complete';
    for (let attempt = 0; attempt < 100; attempt++) {
      if (!this.live() || seq !== this.#openSeq || id !== this.#state.activeId) return 'paused';
      if (attempt) await new Promise(resolve => setTimeout(resolve, 300));
      const r = await this.call('GET', `/api/chat/conversations/${id}/messages?limit=${PAGE_LIMIT}`);
      if (!this.live() || seq !== this.#openSeq || id !== this.#state.activeId) return 'paused';
      if (r.status !== 200 || !record(r.body) || !Array.isArray(r.body.messages)) throw Error('round unavailable');
      const round = record(r.body.replyRound) ? r.body.replyRound : null;
      this.readReplyRound(r.body);
      const page = (r.body.messages as WireMessage[]).map(fromWire), fresh = new Set(page.map(t => t.key));
      const savedRuns = new Set(page.map(t => t.runId).filter(Boolean));
      const kept = this.#state.turns.filter(t => !fresh.has(t.key) && !t.key.startsWith('run:') && !t.key.startsWith('pending:') && !(t.runId && savedRuns.has(t.runId)));
      const active = typeof r.body.activeRunId === 'string' && r.body.activeRunId !== endedRun ? r.body.activeRunId : null;
      const speaker = round && record(round.speaker) && typeof round.speaker.id === 'string' ? round.speaker.id : undefined;
      this.publish({ turns: [...kept, ...page, ...(active ? [liveTurn(active, this.now(), speaker)] : [])] });
      if (active) { this.publish({ runId: active, stopping: false, notice: undefined }); void this.follow(active, seq); return 'following'; }
      if (!round || round.id !== roundId || round.state === 'complete') return 'complete';
      if (round.state === 'paused') { this.publish({ notice: 'The group replies paused. Review the last reply before asking the remaining participants to continue.' }); return 'paused'; }
    }
    this.publish({ notice: 'The group is still preparing its next reply. Reopen this chat to check its saved progress.' });
    return 'paused';
  }

  private async finished(seq = this.#openSeq) {
    if (this.#replyRoundId) {
      try {
        const progress = await this.followReplyRound(this.#state.runId, seq);
        if (progress === 'following' || !this.live() || seq !== this.#openSeq) return;
        if (progress === 'paused') { this.publish({ runId: null, stopping: false, reconnecting: false, queuePaused: this.#state.queue.length > 0 }); return; }
      } catch { this.publish({ runId: null, reconnecting: false, queuePaused: this.#state.queue.length > 0, notice: 'Lost the connection to the group. Reopen this chat to see its saved replies.' }); return; }
    }
    const stopped = this.#state.turns.at(-1)?.status === 'stopped';
    // CHAT-BUILD-01 stage 5 (CH10): long work that ends while the window is in the back sends a desktop notification.
    const last = this.#state.turns.at(-1);
    if (this.#notifyDone && last?.role === 'assistant' && (last.durationMs ?? 0) >= 60_000) notifyDone('Girru', `${this.#state.conversations.find(c => c.id === this.#state.activeId)?.title ?? 'A chat'}: ${last.status === 'complete' ? 'done' : last.status === 'error' ? 'stopped with an error' : 'stopped'}.`);
    this.publish({ runId: null, stopping: false, reconnecting: false, elsewhere: false, queuePaused: stopped && this.#state.queue.length > 0 });
    void this.refreshList();
    if (stopped) return;
    const [next, ...rest] = this.#state.queue;
    if (next) { this.publish({ queue: rest }); this.#saveQueue(this.#state.activeId, rest); void this.send(next.text); }
  }

  /** Sends a waiting message now (after a Stop paused the queue). */
  sendQueued(key: string) {
    const item = this.#state.queue.find(q => q.key === key);
    if (!item || this.#state.runId || this.#state.starting) return;
    this.publish({ queue: this.#state.queue.filter(q => q.key !== key), queuePaused: false });
    this.#saveQueue(this.#state.activeId, this.#state.queue);
    void this.send(item.text);
  }

  private async refreshList() {
    try {
      const r = await this.call('GET', '/api/chat/conversations');
      if (this.live() && r.status === 200 && record(r.body) && Array.isArray(r.body.conversations)) this.publish({ conversations: r.body.conversations as Conversation[] });
    } catch { /* the list refreshes on the next load */ }
  }

  /** Stops the running reply; what it wrote so far is kept. Queued messages stay queued until sent. */
  /** CHAT-BUILD-01 stage 5 (CH10 Steer now): the draft goes into the running reply at its next step. */
  async steer() {
    const runId = this.#state.runId, text = this.#state.draft.trim();
    if (!this.live() || !runId || !text) return;
    this.publish({ draft: '' });
    try {
      const r = await this.call('POST', `/api/chat/runs/${runId}/steer`, { message: text });
      if (!this.live()) return;
      if (r.status === 200) this.publish({ notice: 'Sent. The agent reads it at its next step.' });
      else { this.publish({ draft: this.#state.draft || text, notice: 'The reply already ended. Your text is back in the box.' }); }
    } catch { if (this.live()) this.publish({ draft: this.#state.draft || text, notice: 'Not sent (no connection). Your text is back in the box.' }); }
  }

  /** CHAT-BUILD-01 stage 4: stops everything in this chat — its reply and the helpers it handed work to (⌘.). */
  async stopAll() {
    const id = this.#state.activeId;
    if (!id || !this.live()) return;
    if (this.#state.runId) this.publish({ stopping: true });
    try { await this.call('POST', `/api/chat/conversations/${id}/stop`); } catch { if (this.live()) this.publish({ stopping: false, notice: 'Stop did not reach the server. Try again.' }); }
  }

  async stop() {
    const runId = this.#state.runId;
    if (!runId || this.#state.stopping || !this.live()) return;
    this.publish({ stopping: true });
    try { await this.call('POST', `/api/chat/runs/${runId}/stop`); } catch { this.publish({ stopping: false, notice: 'Stop did not reach the server. Try again.' }); }
  }

  removeQueued(key: string) { const queue = this.#state.queue.filter(q => q.key !== key); this.publish({ queue, queuePaused: this.#state.queuePaused && queue.length > 0 }); this.#saveQueue(this.#state.activeId, queue); }
  editQueued(key: string) {
    const item = this.#state.queue.find(q => q.key === key);
    if (item) { this.publish({ queue: this.#state.queue.filter(q => q.key !== key), draft: this.#state.draft ? `${this.#state.draft}\n${item.text}` : item.text }); this.#saveQueue(this.#state.activeId, this.#state.queue); }
  }

  async rename(id: string, title: string) {
    const t = title.trim().slice(0, 120);
    const r = await this.call('PUT', `/api/chat/conversations/${id}`, { title: t || null });
    if (this.live() && r.status === 200 && record(r.body) && record(r.body.conversation)) this.replace(r.body.conversation as Conversation);
  }

  async pin(id: string, pinned: boolean) {
    const r = await this.call('PUT', `/api/chat/conversations/${id}`, { pinned });
    if (this.live() && r.status === 200 && record(r.body) && record(r.body.conversation)) { this.replace(r.body.conversation as Conversation); void this.refreshList(); }
  }

  /** CHAT-PRO-02 F: saves the conversation as a Markdown file (a failure shows as the notice). */
  async exportMarkdown(id: string, tools = false): Promise<ExportResult> {
    if (!this.live()) return { ok: false, message: 'Sign in again to export this conversation.' };
    const r = await exportConversation(this.client, id, tools);
    if (!r.ok && this.live()) this.publish({ notice: r.message });
    return r;
  }

  async remove(id: string) {
    const r = await this.call('DELETE', `/api/chat/conversations/${id}`);
    if (!this.live() || (r.status !== 200 && r.status !== 404)) return;
    this.publish({ conversations: this.#state.conversations.filter(c => c.id !== id) });
    if (this.#state.activeId === id) this.newChat();
  }

  /** A changed chat from the server; its live status (working, waiting) stays until the next list. */
  private replace(c: Conversation) { this.publish({ conversations: this.#state.conversations.map(x => (x.id === c.id ? { ...(x.running ? { running: true } : {}), ...(x.waiting ? { waiting: x.waiting } : {}), ...c } : x)) }); }

  /** CHAT-BUILD-01 stage 3 (CH3): Mode and Thinking are saved for the chat (a new chat takes them on its first message). */
  async setMode(mode: ChatMode) { await this.#setChatField('mode', mode); }
  /** Only for a model that can think: the saved choice is never changed for one that would ignore it. */
  async setThinking(thinking: ChatThinking) { if (canThink(this.#state.model, this.#state.models)) await this.#setChatField('thinking', thinking); }
  /** Saved in the same queue as the model choice: a message sent right after a change waits for it (never runs in the old mode). */
  async #setChatField(field: 'mode' | 'thinking', value: string) {
    if (!this.live()) return;
    const before = this.#state[field];
    this.publish({ [field]: value } as Partial<ConversationsState>);
    const id = this.#state.activeId;
    if (!id) return;
    this.#pendingModelWrites++;
    this.#modelWrites = this.#modelWrites.then(async () => {
      if (!this.live()) return;
      try {
        const r = await this.call('PUT', `/api/chat/conversations/${id}`, { [field]: value });
        if (r.status !== 200 || !record(r.body) || !record(r.body.conversation)) throw Error();
        this.#modelSaveFailures.delete(id);
        if (this.live()) this.replace(r.body.conversation as Conversation);
      } catch {
        if (!this.live()) return;
        this.#modelSaveFailures.add(id);
        if (this.#state.activeId === id) this.publish({ [field]: before, notice: field === 'mode' ? 'The mode was not saved. Choose it again before sending.' : 'The thinking choice was not saved. Choose it again before sending.' } as Partial<ConversationsState>);
      }
    }).finally(() => { this.#pendingModelWrites--; });
    await this.#modelWrites;
  }
  /** Saves the waiting messages with the chat so a reload or a switch never loses them. */
  #queueSaves: Promise<unknown> = Promise.resolve();
  /** The id of the project createProject made last (the project sheet saves its variables there). */
  lastCreatedProject: string | null = null;
  #saveQueue(id: string | null, queue: ConversationsState['queue']) {
    if (!id || !this.live()) return;
    const body = { queued: queue.map(q => ({ key: q.key, text: q.text })) };
    // One after another, so an older list never lands after a newer one.
    this.#queueSaves = this.#queueSaves.then(() => this.call('PUT', `/api/chat/conversations/${id}`, body)).catch(() => undefined);
  }

  /** CHAT-BUILD-01 stage 3 (CH5): a project's variables (names only; values never come back). */
  async variables(projectId: string): Promise<string[] | null> {
    try { const r = await this.call('GET', `/api/chat/projects/${projectId}/variables`); return r.status === 200 && record(r.body) && Array.isArray(r.body.variables) ? r.body.variables as string[] : null; } catch { return null; }
  }
  async setVariable(projectId: string, name: string, value: string): Promise<string | null> {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name)) return 'Use capital letters, digits and _ (like API_URL).';
    try {
      const r = await this.call('PUT', `/api/chat/projects/${projectId}/variables/${name}`, { value });
      return r.status === 200 ? null : r.status === 400 ? `${name} cannot be saved: names like PATH or HOME are not allowed, and a value is 1-8000 characters.` : 'The variable was not saved.';
    } catch { return 'The variable was not saved (no connection).'; }
  }
  async deleteVariable(projectId: string, name: string): Promise<boolean> {
    try { return (await this.call('DELETE', `/api/chat/projects/${projectId}/variables/${name}`)).status === 200; } catch { return false; }
  }

  /** CHAT-BUILD-01 stage 2 (CH9): the person's sidebar layout (the usual one until it loads). */
  async loadSidebar() {
    try { const r = await this.call('GET', SIDEBAR_PATH); if (this.live() && r.status === 200 && record(r.body)) this.publish({ sidebar: readPrefs(r.body.sidebar) }); } catch { /* the usual sidebar stays */ }
  }
  /** Shows the new layout at once and saves it; on failure goes back and says so. */
  async saveSidebar(next: SidebarPrefs) {
    const before = this.#state.sidebar;
    this.publish({ sidebar: next });
    try { const r = await this.call('PUT', SIDEBAR_PATH, next); if (r.status !== 200) throw Error(); }
    catch { if (this.live()) this.publish({ sidebar: before, notice: 'The sidebar change was not saved.' }); }
  }

  /** CHAT-BUILD-01 stage 2: archive (or bring back) a chat; it stays searchable. Returns false when it did not change. */
  async archive(id: string, archived: boolean): Promise<boolean> {
    const r = await this.call('PUT', `/api/chat/conversations/${id}`, { archived });
    if (!this.live() || r.status !== 200 || !record(r.body) || !record(r.body.conversation)) { if (this.live()) this.publish({ notice: archived ? 'The chat was not archived.' : 'The chat was not brought back.' }); return false; }
    this.replace(r.body.conversation as Conversation);
    return true;
  }
}
