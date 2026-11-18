import { SessionFailure } from './session-failure';
import { BOARDS_PATH, MAX_COMMENT, MAX_DESCRIPTION, MAX_TITLE, TASK_CONTINUE_PATH, validBoardEdit, validCardEdit, validNewBoard, validNewCard } from './board-contract.js';
import type { SessionClient } from './session';
import { cardChatPath } from './chat-board-contract.js';
import type { ChatProgress } from './chat-board-contract.js';

export type RelatedTask={cardId:string;boardId:string;boardName:string;title:string;status:string;priority:string;dueDate:string|null};
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
/** Board writes (checked against board-contract.js before sending). */
export type BoardRequest = { method: 'POST' | 'PUT'; path: string; body: Record<string, unknown> };
export type Column = Readonly<{ id: string; name: string; position: number }>;
export type Card = Readonly<{
  id: string; columnId: string; title: string; description: string; priority: Priority; position: number; dueDate: string | null;
  archived: boolean; version: number; agents: readonly string[]; departments: readonly string[]; comments: number; updatedAt: string;
  type: CardType; startDate: string | null; cover: BoardColor | null; labels: readonly string[]; checklist: Readonly<{ done: number; total: number }>;
  /** CHAT-PRO-02 I step 2: the conversation this card was made from (null = made on the board). */
  conversationId?: string | null;
  /** TASKLOG-01: the card's task in a project's task file (null = a card of the board only). */
  taskFile?: TaskMark | null;
  /** TASKPAGE-03: how the task repeats (null = it does not). */
  repeat?: Repeat | null;
  /** STORE-MAP-01 P8 (D29): how many handoffs the task has (only when there is one, P8 on). */
  handoffCount?: number;
  /** STORE-MAP-01 P8 (D29): the newest handoff lists blockers (only then, P8 on). */
  blocked?: true;
}>;
export type Every = 'hourly' | 'daily' | 'weekly';
export type Repeat = Readonly<{ every: Every; at: string; weekday: number | null; nextRun: string; paused: boolean; lastResult: 'started' | 'busy' | 'failed' | null; lastRun?: string | null; agentId?: string | null; model?: string }>;
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
/** "Every day 09:00", "Every hour at :15", "Every week Mon 08:00". */
export const repeatWords = (r: Pick<Repeat, 'every' | 'at' | 'weekday'>) => r.every === 'hourly' ? `Every hour at :${r.at.slice(3)}` : r.every === 'daily' ? `Every day ${r.at}` : `Every week ${WEEKDAYS[r.weekday ?? 0]} ${r.at}`;
/** TASKLOG-01: a card's task in its project's task file (.girru/tasks.md). */
export type TaskMark = Readonly<{ no: string; projectId: string; projectName: string; problem: string | null; apps: readonly string[]; finished: boolean }>;
export type TaskDetail = TaskMark & Readonly<{
  file: string; text: string;
  /** STORE-MAP-01 P6: the task's number (only while the backend's P6 switch is on). */
  number?: string;
  task: Readonly<{ no: string; title: string; state: string; department: string; agent: string; priority: string; done: readonly string[]; left: readonly string[]; next: readonly string[] }>;
  workedOn: ReadonlyArray<Readonly<{ app: string; agent: string; date: string; at: string | null; what: string | null }>>;
  log: ReadonlyArray<Readonly<{ at: string; app: string; what: string }>>;
}>;
export type CardType = 'task' | 'idea' | 'bug' | 'milestone' | 'request';
export type Label = Readonly<{ id: string; name: string; color: BoardColor }>;
export type CheckItem = Readonly<{ id: string; text: string; done: boolean; /** TASKPAGE-02 */ owner?: Readonly<{ kind: 'user' | 'agent'; id: string }> | null; dueDate?: string | null }>;
/** TASKPAGE-02: the full task page. */
export type Role = 'asked' | 'does' | 'checks' | 'tests';
export const roleLabel: Record<Role, string> = { asked: 'asked for it', does: 'does it', checks: 'checks it', tests: 'tests it' };
export type CardRef = Readonly<{ id: string; boardId: string; title: string; done: boolean }>;
export type TaskPageData = Readonly<{
  openedBy: { kind: 'user' | 'agent'; id: string; name: string }; openedAt: string;
  people: ReadonlyArray<Readonly<{ kind: 'user' | 'agent'; id: string; name: string; role: Role }>>;
  team: ReadonlyArray<Readonly<{ id: string; name: string }>>;
  parent: CardRef | null; subtasks: readonly CardRef[]; waitsFor: readonly CardRef[]; blocks: readonly CardRef[];
  release: string | null; following: boolean; followers: number;
  chats: ReadonlyArray<Readonly<{ id: string; title: string | null }>>;
  spent: ReadonlyArray<Readonly<{ app: string; model: string; paid: boolean; tokens: number; replies: number }>>;
  files: Readonly<{ count: number; added: number; removed: number; paths: readonly string[] }>;
  development: Readonly<{ branch: string | null; pr: Readonly<{ number: number; title: string; state: string; url: string; checks: string | null }> | null }> | null;
}>;
type Who = Readonly<{ kind: 'user' | 'agent'; id: string; name: string }>;
export type ActivityItem =
  | Readonly<{ id: string; kind: 'event'; at: string; actor: Who; event: string; detail: string }>
  | Readonly<{ id: string; kind: 'comment'; at: string; actor: Who; text: string }>
  | Readonly<{ id: string; kind: 'reply'; at: string; actor: Who; app: string; model: string; chat: { id: string; title: string | null }; text: string; more: boolean; tokens: number;
      change: Readonly<{ messageId: string; files: number; added: number; removed: number; undone: boolean }> | null }>
  | Readonly<{ id: string; kind: 'log'; at: string; app: string; text: string }>;
export type FileDiff = Readonly<{ path: string; status: string; added: number; removed: number; lines: readonly string[]; more: boolean }>;
export const cardTypeLabel: Record<CardType, string> = { task: 'Task', idea: 'Idea', bug: 'Bug', milestone: 'Milestone', request: 'Request' };
export const allCardTypes: readonly CardType[] = ['task', 'idea', 'bug', 'milestone', 'request'];
export type Comment = Readonly<{ id: string; authorKind: 'user' | 'agent'; authorId: string; body: string; createdAt: string }>;
export type AgentOption = Readonly<{ id: string; name: string }>;
export type BoardColor = 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'pink' | 'teal' | 'gray';
export type BoardMeta = Readonly<{ id: string; name: string; description: string; template: string; color: BoardColor; departments: readonly string[]; kind: 'company' | 'department' | 'shared'; managedDepartment?:boolean; departmentActive?:boolean; archived: boolean; version: number }>;
export type BoardSummary = BoardMeta & Readonly<{ cards: number; open: number; /** TASKLOG-01: tasks from project files that wait in To sort. */ toSort?: number }>;
export type Template = Readonly<{ id: string; name: string; description: string; columns: readonly string[] }>;
export type NewBoard = { name: string; description?: string; template: string; color: BoardColor; departments: string[] };
export type CardDraft = Readonly<{ title: string; description: string; priority: Priority; dueDate: string; agents: readonly string[]; departments: readonly string[];
  type: CardType; startDate: string; cover: BoardColor | null; labels: readonly string[] }>;
export type BoardState = Readonly<{
  owner: boolean;
  phase: 'idle' | 'loading' | 'ready' | 'saving' | 'error' | 'denied';
  boardId?: string; name?: string; columns: readonly Column[]; cards: readonly Card[]; agents: readonly AgentOption[];
  /** BOARD-03: every board, the open board's header, the templates and colours to create new ones. */
  boards: readonly BoardSummary[]; meta?: BoardMeta; templates: readonly Template[]; colors: readonly BoardColor[];
  /** BOARD-03 step B: the open board's labels and the open card's checklist. */
  labels: readonly Label[]; checklist: readonly CheckItem[];
  /** The open card (detail panel) and its editable copy and comments. */
  open?: string; draft?: CardDraft; comments: readonly Comment[]; commentsPhase: 'idle' | 'loading' | 'ready' | 'error';
  /** CHAT-PRO-02 I step 2: the open card's conversation and the progress of the agents on it. */
  chat?: Readonly<{ conversation: { id: string; title: string | null } | null; progress: ChatProgress }>;
  /** TASKPAGE-02: the open card's page, its activity line, and the diffs opened in it. */
  page?: Readonly<{ phase: 'loading' | 'ready' | 'error'; data: TaskPageData | null }>;
  activity?: Readonly<{ phase: 'loading' | 'ready' | 'error'; items: readonly ActivityItem[]; more: boolean }>;
  diffs?: Readonly<Record<string, readonly FileDiff[] | 'loading' | 'error'>>;
  /** TASKLOG-01: the open card's task as its project's task file has it. */
  task?: Readonly<{ phase: 'loading' | 'ready' | 'error'; detail: TaskDetail | null }>;
  /** Filters: text search, one agent, one department, one app that worked on a task (TASKLOG-01). */
  filter: Readonly<{ text: string; agent: string; department: string; app?: string; kind?: 'all' | 'tasks' | 'scheduled' }>;
  /** TASKPAGE-03: the open card's schedule (null = it does not repeat). */
  schedule?: Repeat | null;
  overview?:Readonly<{tasks:RelatedTask[];total:number;limited:boolean}>; overviewError?:boolean;
  notice?: string;
}>;

export const priorityLabel: Record<Priority, string> = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
export const allPriorities: readonly Priority[] = ['low', 'normal', 'high', 'urgent'];
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const normDep = (x: string) => x.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/** Cards of a column in board order. */
export const cardsIn = (cards: readonly Card[], columnId: string) => cards.filter(c => c.columnId === columnId).sort((a, b) => a.position - b.position);

/** Does a card pass the current filters? */
export function matches(card: Card, f: BoardState['filter']): boolean {
  const t = f.text.trim().toLowerCase();
  if (t && !card.title.toLowerCase().includes(t) && !card.description.toLowerCase().includes(t)) return false;
  if (f.agent && !card.agents.includes(f.agent)) return false;
  if (f.app && !card.taskFile?.apps.some(a => a.toLowerCase() === f.app!.toLowerCase())) return false;
  if (f.kind === 'scheduled' && !card.repeat) return false;
  if (f.kind === 'tasks' && card.repeat) return false;
  return !f.department || card.departments.includes(f.department);
}

const draftOf = (c: Card): CardDraft => Object.freeze({ title: c.title, description: c.description, priority: c.priority, dueDate: c.dueDate ?? '', agents: [...c.agents], departments: [...c.departments],
  type: c.type, startDate: c.startDate ?? '', cover: c.cover, labels: [...c.labels] });

/**
 * The company task board (BOARD-01): owner only. Nothing is read on mount;
 * "Open the board" reads the board and the team (for assignees). Moves and
 * edits carry the card version; a conflict shows the current card.
 */
export class BoardController {
  #state: BoardState = Object.freeze({ owner: false, phase: 'denied', columns: [], cards: [], agents: [], boards: [], templates: [], colors: [], labels: [], checklist: [], comments: [], commentsPhase: 'idle', filter: { text: '', agent: '', department: '', app: '', kind: 'all' as const } });
  #listeners = new Set<() => void>();
  #ticket = 0; #identity = ''; #disposed = false; #unsubscribe: () => void;
  constructor(readonly client: SessionClient) { this.#unsubscribe = client.subscribe(this.#sync); this.#sync(); }
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  #publish(patch: Partial<BoardState>) { this.#state = Object.freeze({ ...this.#state, ...patch }); this.#listeners.forEach(fn => fn()); }
  #sync = () => {
    const s = this.client.getSnapshot(); const identity = `${s.mode}:${s.epoch}:${s.phase}:${s.user?.id ?? ''}:${s.user?.role ?? ''}`;
    if (identity === this.#identity) return;
    this.#identity = identity; this.#ticket++;
    const owner = s.phase === 'authenticated' && s.user?.role === 'owner';
    this.#publish({ owner, phase: owner ? 'idle' : 'denied', boardId: undefined, name: undefined, columns: [], cards: [], agents: [], boards: [], meta: undefined, templates: [], colors: [], labels: [], checklist: [], overview:undefined,overviewError:false,open: undefined, draft: undefined, comments: [], commentsPhase: 'idle',
      notice: s.phase === 'authenticated' && !owner ? 'Only the owner can use the company board.' : undefined });
  };
  dispose() { this.#disposed = true; this.#ticket++; this.#unsubscribe(); this.#publish({ owner: false, phase: 'denied', cards: [], columns: [], comments: [] }); }
  #busy() { return this.#state.phase === 'loading' || this.#state.phase === 'saving'; }
  #refused(status: number, body: unknown): boolean {
    if (status === 403 && record(body) && body.code === 'read_only_stage') { this.#publish({ phase: 'error', notice: 'This test server does not accept board changes. Nothing was saved.' }); return true; }
    if (status === 401 || status === 403) { this.#publish({ phase: 'denied', notice: 'Access denied. Sign in again as the owner.' }); return true; }
    return false;
  }
  #applyBoard(b: BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }) {
    const open = this.#state.open && b.cards.some(c => c.id === this.#state.open) ? this.#state.open : undefined;
    const { columns: _c, cards: _k, labels, ...meta } = b;
    this.#publish({ labels: Object.freeze((labels ?? []).map(l => Object.freeze(l))) });
    this.#publish({ boardId: b.id, name: b.name, meta: Object.freeze({ ...meta }), columns: Object.freeze(b.columns.map(c => Object.freeze(c))), cards: Object.freeze(b.cards.map(c => Object.freeze(c))),
      ...(open ? {} : { open: undefined, draft: undefined, comments: [], commentsPhase: 'idle' as const }) });
  }
  #replaceCard(card: Card) {
    // A card answer without its file mark (a conflict) keeps the mark the board already shows.
    const had = this.#state.cards.find(c => c.id === card.id);
    if (!card.taskFile && had?.taskFile) card = { ...card, taskFile: had.taskFile };
    const exists = !!had;
    const cards = card.archived ? this.#state.cards.filter(c => c.id !== card.id) : exists ? this.#state.cards.map(c => c.id === card.id ? Object.freeze(card) : c) : [...this.#state.cards, Object.freeze(card)];
    const last=Math.max(...this.#state.columns.map(c=>c.position));const done=this.#state.columns.find(c=>c.position===last)?.id;
    const boards=this.#state.boards.map(b=>b.id===this.#state.boardId?Object.freeze({...b,cards:cards.length,open:cards.filter(c=>c.columnId!==done).length}):b);
    this.#publish({cards:Object.freeze(cards),boards:Object.freeze(boards)});
  }

  /** Explicit read: every board (the company board is created on first use), the open board, and the team for assignees. */
  async load(boardId?: string) {
    if (!this.#state.owner || this.#busy() || this.#disposed) return;
    const ticket = ++this.#ticket;
    this.#publish({ phase: 'loading', notice: undefined,overview:undefined,overviewError:false });
    try {
      const provision=await this.client.request({method:'POST',path:BOARDS_PATH+'/sync-departments',body:{}});
      if(ticket!==this.#ticket)return;if(this.#refused(provision.status,provision.body))return;
      const syncNotice=provision.status!==200?'Department boards could not be synchronized. Existing boards are shown; reload to try again.':undefined;
      const list = await this.client.request({ method: 'GET', path: BOARDS_PATH });
      if (ticket !== this.#ticket) return;
      if (this.#refused(list.status, list.body)) return;
      const lb = list.body as { boards?: BoardSummary[]; templates?: Template[]; colors?: BoardColor[] } | null;
      if (list.status !== 200 || !lb?.boards?.length) throw Error();
      this.#publish({ boards: Object.freeze(lb.boards.map(x => Object.freeze(x))), templates: Object.freeze(lb.templates ?? []), colors: Object.freeze(lb.colors ?? []) });
      const want = boardId ?? this.#state.boardId;
      const target = lb.boards.find(x => x.id === want)?.id ?? lb.boards[0].id;
      const r = await this.client.request({ method: 'GET', path: `${BOARDS_PATH}/${target}` });
      if (ticket !== this.#ticket) return;
      if (this.#refused(r.status, r.body)) return;
      if (r.status !== 200 || !record(r.body)) throw Error();
      this.#applyBoard(r.body as never);
      if (!this.#state.agents.length) {
        const team = await this.client.request({ method: 'GET', path: '/api/agents' });
        if (ticket !== this.#ticket) return;
        const agents = team.status === 200 && record(team.body) && Array.isArray(team.body.agents)
          ? (team.body.agents as { id: string; name?: string }[]).map(a => Object.freeze({ id: a.id, name: a.name ?? a.id })) : [];
        this.#publish({ agents: Object.freeze(agents) });
      }
      this.#publish({ phase: 'ready',notice:syncNotice });
      await this.readOverview(target,ticket);
    } catch { if (ticket === this.#ticket) this.#publish({ phase: 'error', notice: 'The board could not be read. Try again.' }); }
  }

  private async readOverview(id:string,ticket=this.#ticket){
    try{const r=await this.client.request({method:'GET',path:`${BOARDS_PATH}/${id}/overview`});if(ticket!==this.#ticket||this.#state.boardId!==id)return;if(r.status!==200)throw Error();this.#publish({overview:r.body as BoardState['overview'],overviewError:false});}catch{if(ticket===this.#ticket&&this.#state.boardId===id)this.#publish({overviewError:true});}
  }
  refreshOverview(){return this.#state.boardId?this.readOverview(this.#state.boardId):Promise.resolve();}
  /** Switch to another board. */
  async openBoard(id: string) {
    if(this.hasUnsavedDraft()){this.#publish({notice:'Save or close the current task draft before switching boards.'});return;}
    if (!this.#state.boards.some(b => b.id === id) || id === this.#state.boardId) return;
    this.closeCard();
    this.#publish({ filter: Object.freeze({ text: '', agent: '', department: '', app: '', kind: this.#state.filter.kind ?? 'all' }) });
    await this.load(id);
  }

  /** A new board from a template; opens it. */
  async createBoard(input: NewBoard) {
    if(this.hasUnsavedDraft()){this.#publish({notice:'Save or close the current task draft before creating a board.'});return false;}
    const body: Record<string, unknown> = { name: input.name.normalize('NFKC').replace(/\s+/g, ' ').trim(), template: input.template, color: input.color, departments: input.departments.map(normDep).filter(Boolean) };
    const description = input.description?.trim(); if (description) body.description = description;
    if (!body.name || !validNewBoard(body)) { this.#publish({ notice: 'A board needs a name (1–80 characters); departments use letters, numbers, spaces, - or _.' }); return false; }
    let created: string | undefined;
    const ok = await this.#write<BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }>(() => this.client.request({ method: 'POST', path: BOARDS_PATH, body }), b => { created = b.id; this.#applyBoard(b); }, 'The board', true);
    if (ok && created) await this.load(created);
    return ok;
  }

  /** Rename, describe, recolour, change departments or archive the open board. */
  async updateBoard(patch: { name?: string; description?: string; color?: BoardColor; departments?: string[]; archived?: boolean }) {
    if(patch.archived&&this.hasUnsavedDraft()){this.#publish({notice:'Save or close the current task draft before archiving this board.'});return false;}
    const m = this.#state.meta; if (!m) return false;
    const body: Record<string, unknown> = { expectedVersion: m.version };
    if (patch.name !== undefined) { const n = patch.name.normalize('NFKC').replace(/\s+/g, ' ').trim(); if (n !== m.name) body.name = n; }
    if (patch.description !== undefined && patch.description.trim() !== m.description) body.description = patch.description.trim();
    if (patch.color !== undefined && patch.color !== m.color) body.color = patch.color;
    if (patch.departments !== undefined) {
      const deps = [...new Set(patch.departments.map(normDep).filter(Boolean))];
      if ([...deps].sort().join() !== [...m.departments].sort().join()) body.departments = deps;
    }
    if (patch.archived !== undefined && patch.archived !== m.archived) body.archived = patch.archived;
    if (Object.keys(body).length === 1) { this.#publish({ notice: 'Nothing changed.' }); return false; }
    if (!validBoardEdit(body)) { this.#publish({ notice: 'Check the board name (1–80 characters) and the departments.' }); return false; }
    const ok = await this.#write<BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${m.id}`, body }), b => this.#applyBoard(b), 'The board', true);
    if (ok) await this.load(patch.archived ? undefined : m.id);
    if (ok && patch.archived) this.#publish({ notice: `“${m.name}” was archived.` });
    return ok;
  }

  setFilter(patch: Partial<BoardState['filter']>) { this.#publish({ filter: Object.freeze({ ...this.#state.filter, ...patch }) }); }
  /** The signed-in person (TASKPAGE-03: Take it myself). */
  myId = () => this.client.getSnapshot().user?.id ?? null;
  commentAuthor = (kind:'user'|'agent',id:string) => kind==='agent'?this.agentName(id):id===this.client.getSnapshot().user?.id?'You':'Team member';
  agentName = (id: string) => this.#state.agents.find(a => a.id === id)?.name ?? 'Former agent';

  async #write<T>(run: () => Promise<{ status: number; body: unknown }>, onOk: (body: T) => void, what: string, boardLevel = false): Promise<boolean> {
    if (!this.#state.owner || this.#busy() || (!boardLevel && !this.#state.boardId)) return false;
    const ticket = this.#ticket;
    this.#publish({ phase: 'saving', notice: undefined });
    try {
      const r = await run();
      if (ticket !== this.#ticket) return false;
      if (this.#refused(r.status, r.body)) return false;
      const b = r.body as (Record<string, unknown> & { code?: string; card?: Card }) | null;
      if ((r.status === 200 || r.status === 201) && b) { onOk(b as T); this.#publish({ phase: 'ready' }); return true; }
      if (r.status === 409 && b?.code === 'version_conflict' && !b.card) {
        this.#publish({ phase: 'ready', notice: 'This board was changed meanwhile. It was read again; try once more.' });
        void this.load(this.#state.boardId);
        return false;
      }
      if (r.status === 409 && b?.card) {
        this.#replaceCard(b.card);
        if (this.#state.open === b.card.id) this.#publish({ draft: draftOf(b.card) });
        this.#publish({ phase: 'ready', notice: 'This card was changed meanwhile. The latest version is shown; try again.' });
        return false;
      }
      this.#publish({ phase: 'ready', notice: b?.code === 'not_found' ? `${what}: not found. Reload the board.` : `${what} was not saved. Check the fields.` });
    } catch (error) {
      if (ticket !== this.#ticket) return false;
      this.#publish({ phase: 'ready', notice: error instanceof SessionFailure && error.code === 'blocked' ? 'Nothing was sent. Check the fields.' : `${what}: the result is unknown. Reload the board to see what is stored.` });
    }
    return false;
  }

  #adds: Promise<unknown> = Promise.resolve();
  /** A new card at the end of a column (title only; details in the panel). Quick successive adds wait for each other. */
  addCard(columnId: string, title: string): Promise<boolean> {
    const run = this.#adds.then(() => this.#addCardNow(columnId, title));
    this.#adds = run.catch(() => undefined);
    return run;
  }
  async #addCardNow(columnId: string, title: string) {
    const body = { columnId, title: title.normalize('NFKC').replace(/\s+/g, ' ').trim() };
    if (!body.title || [...body.title].length > MAX_TITLE || !validNewCard(body)) { this.#publish({ notice: `A card needs a title of 1 to ${MAX_TITLE} characters.` }); return false; }
    return this.#write<Card>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${this.#state.boardId}/cards`, body }), c => this.#replaceCard(c), 'The card');
  }

  async addColumn(name: string) {
    const n = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!n || [...n].length > 60) { this.#publish({ notice: 'A column needs a name of 1 to 60 characters.' }); return false; }
    return this.#write<BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${this.#state.boardId}/columns`, body: { name: n } }), b => this.#applyBoard(b), 'The column');
  }

  async renameColumn(columnId: string, name: string) {
    const n = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!n || [...n].length > 60) { this.#publish({ notice: 'A column needs a name of 1 to 60 characters.' }); return false; }
    return this.#write<BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${this.#state.boardId}/columns/${columnId}`, body: { name: n } }), b => this.#applyBoard(b), 'The column');
  }

  /** Move a card to a column, before another card (or to the end). Optimistic in the view, confirmed by the server. */
  async move(cardId: string, columnId: string, beforeCardId: string | null) {
    const card = this.#state.cards.find(c => c.id === cardId);
    if (!card || beforeCardId === cardId) return false;
    if (card.columnId === columnId && beforeCardId === null && cardsIn(this.#state.cards, columnId).at(-1)?.id === cardId) return false;
    const body = { expectedVersion: card.version, columnId, beforeCardId };
    if (!validCardEdit(body)) return false;
    return this.#write<Card>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${this.#state.boardId}/cards/${cardId}`, body }), async c => {
      this.#replaceCard(c);
      // Other cards may have been renumbered; read the board again quietly.
      const r = await this.client.request({ method: 'GET', path: `${BOARDS_PATH}/${this.#state.boardId}` }).catch(() => null);
      if (r && r.status === 200 && record(r.body)) this.#applyBoard(r.body as never);
    }, 'The move');
  }

  // ---- Card panel ----

  hasUnsavedDraft(){const card=this.#state.cards.find(c=>c.id===this.#state.open);return !!card&&!!this.#state.draft&&JSON.stringify(this.#state.draft)!==JSON.stringify(draftOf(card));}
  async openCard(cardId: string) {
    if(this.#state.open===cardId)return;
    if(this.hasUnsavedDraft()){this.#publish({notice:'Save or close the current task draft before opening another task.'});return;}
    const card = this.#state.cards.find(c => c.id === cardId);
    if (!card || !this.#state.owner) return;
    this.#publish({ open: cardId, draft: draftOf(card), comments: [], checklist: [], commentsPhase: 'loading', notice: undefined, chat: undefined, task: card.taskFile ? { phase: 'loading', detail: null } : undefined });
    const ticket = this.#ticket;
    if (card.conversationId || card.agents.length) void this.#loadChat(cardId, ticket);
    if (card.taskFile) void this.#loadTask(cardId, ticket);
    this.#publish({ page: { phase: 'loading', data: null }, activity: { phase: 'loading', items: [], more: false }, diffs: {} });
    void this.#loadPage(cardId, ticket); void this.#loadActivity(cardId, ticket);
    try {
      const k = await this.client.request({ method: 'GET', path: `${BOARDS_PATH}/${this.#state.boardId}/cards/${cardId}/checklist` });
      const items = (k.body as { items?: CheckItem[] } | null)?.items;
      if (ticket === this.#ticket && this.#state.open === cardId && k.status === 200 && items) this.#publish({ checklist: Object.freeze(items.map(i => Object.freeze(i))) });
    } catch { /* the checklist stays empty; the comments still load */ }
    try {
      const r = await this.client.request({ method: 'GET', path: `${BOARDS_PATH}/${this.#state.boardId}/cards/${cardId}/comments` });
      if (ticket !== this.#ticket || this.#state.open !== cardId) return;
      const list = (r.body as { comments?: Comment[] } | null)?.comments;
      this.#publish(r.status === 200 && list ? { comments: Object.freeze(list.map(c => Object.freeze(c))), commentsPhase: 'ready' } : { commentsPhase: 'error' });
    } catch { if (this.#state.open === cardId) this.#publish({ commentsPhase: 'error' }); }
  }
  closeCard() { this.#publish({ open: undefined, draft: undefined, comments: [], checklist: [], commentsPhase: 'idle', notice: undefined, chat: undefined, task: undefined, page: undefined, activity: undefined, diffs: undefined, schedule: undefined }); }
  // ---- TASKPAGE-02: the full task page ----
  #cardPath(cardId = this.#state.open) { return `${BOARDS_PATH}/${this.#state.boardId}/cards/${cardId}`; }
  async #loadPage(cardId: string, ticket = this.#ticket) {
    try {
      const r = await this.client.request({ method: 'GET', path: `${this.#cardPath(cardId)}/page` });
      if (ticket !== this.#ticket || this.#state.open !== cardId) return;
      const data = r.status === 200 && record(r.body) ? (r.body.page as TaskPageData) : null;
      this.#publish({ page: { phase: data ? 'ready' : 'error', data } });
      const sc = await this.client.request({ method: 'GET', path: `${this.#cardPath(cardId)}/schedule` }).catch(() => null);
      if (ticket === this.#ticket && this.#state.open === cardId && sc?.status === 200 && record(sc.body)) this.#publish({ schedule: (sc.body.schedule as Repeat | null) ?? null });
    } catch { if (this.#state.open === cardId) this.#publish({ page: { phase: 'error', data: null } }); }
  }
  async #loadActivity(cardId: string, ticket = this.#ticket, before?: string) {
    try {
      const r = await this.client.request({ method: 'GET', path: `${this.#cardPath(cardId)}/activity${before ? `?before=${before}` : ''}` });
      if (ticket !== this.#ticket || this.#state.open !== cardId) return;
      const b = r.status === 200 && record(r.body) ? r.body as { items: ActivityItem[]; more: boolean } : null;
      if (!b) { this.#publish({ activity: { phase: 'error', items: this.#state.activity?.items ?? [], more: false } }); return; }
      const items = before ? [...b.items, ...(this.#state.activity?.items ?? [])] : b.items;
      this.#publish({ activity: { phase: 'ready', items: Object.freeze(items), more: b.more } });
    } catch { if (this.#state.open === cardId) this.#publish({ activity: { phase: 'error', items: this.#state.activity?.items ?? [], more: false } }); }
  }
  /** Read the page and its activity again (after a change, or by hand). */
  refreshPage() { const id = this.#state.open; if (id) { void this.#loadPage(id); void this.#loadActivity(id); } }
  loadOlder() { const id = this.#state.open, first = this.#state.activity?.items[0]; if (id && first) void this.#loadActivity(id, this.#ticket, first.at); }
  /** The changed lines of one reply's files. */
  async loadDiff(messageId: string) {
    const cardId = this.#state.open; if (!cardId) return;
    this.#publish({ diffs: { ...this.#state.diffs, [messageId]: 'loading' } });
    try {
      const r = await this.client.request({ method: 'GET', path: `${this.#cardPath(cardId)}/activity/${messageId}/diff` });
      if (this.#state.open !== cardId) return;
      const files = r.status === 200 && record(r.body) && Array.isArray(r.body.files) ? r.body.files as FileDiff[] : null;
      this.#publish({ diffs: { ...this.#state.diffs, [messageId]: files ?? 'error' } });
    } catch { if (this.#state.open === cardId) this.#publish({ diffs: { ...this.#state.diffs, [messageId]: 'error' } }); }
  }
  /** One field changed on the page: saved at once (no Save button). */
  async saveField(patch: Partial<CardDraft>) { this.editDraft(patch); const ok = await this.saveCard(true); if (ok) this.refreshPage(); return ok; }
  async #pageWrite(method: 'PUT' | 'POST', part: string, body: Record<string, unknown>, what: string, after?: (b: Record<string, unknown>) => void) {
    const cardId = this.#state.open; if (!cardId) return false;
    const ok = await this.#write<Record<string, unknown>>(() => this.client.request({ method, path: `${this.#cardPath(cardId)}/${part}`, body } as never), b => after?.(b), what);
    if (ok) this.refreshPage();
    return ok;
  }
  /** Put a person or an agent on the task with what they do (role null takes them off). */
  async setPerson(kind: 'user' | 'agent', id: string, role: Role | null) {
    const ok = await this.#pageWrite('PUT', 'people', { kind, id, role }, 'The person');
    if (ok && kind === 'agent') { const card = this.#state.cards.find(c => c.id === this.#state.open); if (card) this.#replaceCard({ ...card, agents: role === null ? card.agents.filter(a => a !== id) : card.agents.includes(id) ? card.agents : [...card.agents, id] }); this.#publish({ draft: card ? draftOf(this.#state.cards.find(c => c.id === card.id)!) : this.#state.draft }); }
    return ok;
  }
  setRelease(name: string | null) { return this.#pageWrite('PUT', 'release', { name: name?.trim() ? name.trim().slice(0, 60) : null }, 'The release'); }
  addSubtask(title: string) {
    const t = title.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!t) return Promise.resolve(false);
    return this.#pageWrite('POST', 'subtasks', { title: t }, 'The sub-task', b => this.#replaceCard(b as unknown as Card));
  }
  setLink(waitsFor: string, on: boolean) { return this.#pageWrite('PUT', 'links', { waitsFor, on }, 'The link'); }
  setFollow(on: boolean) { return this.#pageWrite('PUT', 'follow', { on }, 'Follow'); }
  /** How the open task repeats (null: never). Each run continues it as the chosen agent and app. */
  async setSchedule(s: { every: Every; at: string; weekday?: number | null; agentId?: string | null; model?: string; paused?: boolean } | null) {
    const cardId = this.#state.open; if (!cardId) return false;
    const body = s ? { every: s.every, at: s.at, ...(s.every === 'weekly' ? { weekday: s.weekday ?? 1 } : {}), ...(s.agentId ? { agentId: s.agentId } : {}), model: s.model ?? '', paused: !!s.paused } : { every: 'never' };
    return this.#pageWrite('PUT', 'schedule', body, 'The schedule', b => {
      const sc = (b.schedule as Repeat | null) ?? null;
      this.#publish({ schedule: sc });
      const card = this.#state.cards.find(c => c.id === cardId);
      if (card) this.#replaceCard({ ...card, repeat: sc });
    });
  }
  /** Put the files of one reply back as they were (the chat's own Undo). */
  async undoChange(chatId: string, messageId: string) {
    const ok = await this.#write<unknown>(() => this.client.request({ method: 'POST', path: `/api/chat/conversations/${chatId}/messages/${messageId}/undo`, body: {} } as never), () => undefined, 'Undo');
    if (ok) { this.refreshPage(); this.#publish({ notice: 'The files are back as they were before that reply.' }); }
    return ok;
  }
  /** TASKLOG-01: the open card's task from its project's task file. */
  async #loadTask(cardId: string, ticket = this.#ticket) {
    try {
      const r = await this.client.request({ method: 'GET', path: `${BOARDS_PATH}/${this.#state.boardId}/cards/${cardId}/task` });
      if (ticket !== this.#ticket || this.#state.open !== cardId) return;
      const detail = r.status === 200 && record(r.body) ? (r.body.task as TaskDetail | null) : undefined;
      this.#publish({ task: detail === undefined ? { phase: 'error', detail: null } : { phase: 'ready', detail } });
    } catch { if (this.#state.open === cardId) this.#publish({ task: { phase: 'error', detail: null } }); }
  }
  refreshTask() { if (this.#state.open) void this.#loadTask(this.#state.open); }
  /** TASKLOG-01: send the open card, waiting in To sort, to a department's board (written back to its file). */
  async sortTask(department: string): Promise<boolean> {
    const cardId = this.#state.open, boardId = this.#state.boardId;
    if (!cardId || !boardId) return false;
    const ok = await this.#write<{ boardId: string }>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${boardId}/cards/${cardId}/task-sort`, body: { department } }), () => undefined, 'Sending the task');
    if (!ok) return false;
    this.closeCard();
    await this.load(boardId);
    this.#publish({ notice: `Sent to the ${department} board. Its file now says so.` });
    return true;
  }
  /** TASKLOG-01: a new chat in the task's project where the chosen agent (and app) continues the open card's task. Gives the chat's id. */
  async continueTask(agentId?: string, model?: string): Promise<string | null> {
    const cardId = this.#state.open, boardId = this.#state.boardId;
    if (!cardId || !boardId || !this.#state.owner || this.#busy()) return null;
    const body: Record<string, unknown> = { boardId, cardId, ...(agentId ? { agentId } : {}), ...(model ? { model } : {}) };
    this.#publish({ phase: 'saving', notice: undefined });
    try {
      const r = await this.client.request({ method: 'POST', path: TASK_CONTINUE_PATH, body });
      const b = record(r.body) ? r.body : {};
      const id = record(b.conversation) && typeof b.conversation.id === 'string' ? b.conversation.id : null;
      const why: Record<string, string> = { conversation_busy: 'That chat is still answering.', rate_limited: 'Too many chats are working now; try again in a moment.', no_folder: 'Coding apps work only for the owner in the desktop app.', not_found: 'This task is no longer in its project’s task file.' };
      this.#publish({ phase: 'ready', notice: r.status === 201 ? undefined : `${why[String(b.code)] ?? 'The chat did not start.'}${id ? ' The chat was made; open it to try again.' : ''}` });
      if (r.status === 201 || id) void this.#loadChat(cardId);
      return id;
    } catch {
      this.#publish({ phase: 'ready', notice: 'Continue: the result is unknown. Look in Chat.' });
      return null;
    }
  }
  /** The open card's conversation and who works on it (read again on demand). */
  async #loadChat(cardId: string, ticket = this.#ticket) {
    try {
      const r = await this.client.request({ method: 'GET', path: cardChatPath(this.#state.boardId!, cardId) });
      const b = r.body as { conversation?: { id: string; title: string | null } | null; progress?: ChatProgress } | null;
      if (ticket === this.#ticket && this.#state.open === cardId && r.status === 200 && b?.progress) this.#publish({ chat: Object.freeze({ conversation: b.conversation ?? null, progress: b.progress }) });
    } catch { /* the panel works without it */ }
  }
  refreshChat() { if (this.#state.open) void this.#loadChat(this.#state.open); }
  /** Open a board and one of its cards (from a chat card block). */
  async reveal(boardId: string, cardId: string) {
    if(this.hasUnsavedDraft()){this.#publish({notice:'Save or close the current task draft before opening a related task.'});return;}
    if (!this.#state.owner) return;
    if (this.#state.boardId !== boardId || !this.#state.cards.some(c => c.id === cardId)) { this.closeCard(); await this.load(boardId); }
    if (this.#state.cards.some(c => c.id === cardId)) await this.openCard(cardId);
    else this.#publish({ notice: 'That card is archived or no longer on this board.' });
  }
  toggleLabel(id: string) {
    const d = this.#state.draft; if (!d) return;
    if (!d.labels.includes(id) && d.labels.length >= 10) return this.#publish({ notice: 'At most 10 labels on a card.' });
    this.editDraft({ labels: d.labels.includes(id) ? d.labels.filter(x => x !== id) : [...d.labels, id] });
  }

  /** A new label on the open board. */
  async addLabel(name: string, color: BoardColor) {
    const n = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!n || [...n].length > 40) { this.#publish({ notice: 'A label needs a name of 1 to 40 characters.' }); return false; }
    return this.#write<BoardMeta & { columns: Column[]; cards: Card[]; labels?: Label[] }>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${this.#state.boardId}/labels`, body: { name: n, color } }), b => this.#applyBoard(b), 'The label');
  }

  #setChecklist(cardId: string, items: CheckItem[]) {
    if (this.#state.open === cardId) this.#publish({ checklist: Object.freeze(items.map(i => Object.freeze(i))) });
    const card = this.#state.cards.find(c => c.id === cardId);
    if (card) this.#replaceCard({ ...card, checklist: { done: items.filter(i => i.done).length, total: items.length } });
  }
  async addCheckItem(text: string) {
    const s = this.#state; const t = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (!s.open || !t) return false;
    if ([...t].length > 300) { this.#publish({ notice: 'A checklist item may have at most 300 characters.' }); return false; }
    const cardId = s.open;
    return this.#write<{ items: CheckItem[] }>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${s.boardId}/cards/${cardId}/checklist`, body: { text: t } }), b => this.#setChecklist(cardId, b.items), 'The checklist item');
  }
  async updateCheckItem(itemId: string, patch: { done?: boolean; text?: string; remove?: true; owner?: { kind: 'user' | 'agent'; id: string } | null; dueDate?: string | null; beforeItemId?: string | null }) {
    const s = this.#state; if (!s.open) return false;
    const cardId = s.open;
    const body: Record<string, unknown> = {};
    if (patch.done !== undefined) body.done = patch.done;
    if (patch.owner !== undefined) body.owner = patch.owner;
    if (patch.dueDate !== undefined) body.dueDate = patch.dueDate || null;
    if (patch.beforeItemId !== undefined) body.beforeItemId = patch.beforeItemId;
    if (patch.text !== undefined) { const t = patch.text.normalize('NFKC').replace(/\s+/g, ' ').trim(); if (!t) return false; body.text = t; }
    if (patch.remove) body.remove = true;
    return this.#write<{ items: CheckItem[] }>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${s.boardId}/cards/${cardId}/checklist/${itemId}`, body }), b => this.#setChecklist(cardId, b.items), 'The checklist item');
  }
  editDraft(patch: Partial<CardDraft>) { if (this.#state.draft) this.#publish({ draft: Object.freeze({ ...this.#state.draft, ...patch }) }); }
  toggleAgent(id: string) {
    const d = this.#state.draft; if (!d) return;
    this.editDraft({ agents: d.agents.includes(id) ? d.agents.filter(x => x !== id) : [...d.agents, id] });
  }
  addDepartment(name: string) {
    const d = this.#state.draft; const dep = normDep(name);
    if (!d || !dep) return false;
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u.test(dep) || dep.length > 64) { this.#publish({ notice: 'Department: up to 64 letters, numbers, spaces, - or _.' }); return false; }
    if (!d.departments.includes(dep) && d.departments.length < 12) this.editDraft({ departments: [...d.departments, dep] });
    return true;
  }
  removeDepartment(dep: string) { const d = this.#state.draft; if (d) this.editDraft({ departments: d.departments.filter(x => x !== dep) }); }

  /** Save the panel's changes (only the fields that changed). */
  async saveCard(quiet = false) {
    const s = this.#state; const card = s.cards.find(c => c.id === s.open); const d = s.draft;
    if (!card || !d) return false;
    const title = d.title.normalize('NFKC').replace(/\s+/g, ' ').trim();
    const description = d.description.replace(/\r\n?/g, '\n').trim();
    if (!title || [...title].length > MAX_TITLE) { this.#publish({ notice: `The title needs 1 to ${MAX_TITLE} characters.` }); return false; }
    if ([...description].length > MAX_DESCRIPTION) { this.#publish({ notice: `The description may have at most ${MAX_DESCRIPTION} characters.` }); return false; }
    const body: Record<string, unknown> = { expectedVersion: card.version };
    if (title !== card.title) body.title = title;
    if (description !== card.description) body.description = description;
    if (d.priority !== card.priority) body.priority = d.priority;
    const due = d.dueDate || null; if (due !== card.dueDate) body.dueDate = due;
    if ([...d.agents].sort().join() !== [...card.agents].sort().join()) body.agents = [...d.agents];
    if ([...d.departments].sort().join() !== [...card.departments].sort().join()) body.departments = [...d.departments];
    if (d.type !== card.type) body.type = d.type;
    const start = d.startDate || null; if (start !== card.startDate) body.startDate = start;
    if (start && due && start > due) { this.#publish({ notice: 'The start date cannot be after the due date.' }); return false; }
    if (d.cover !== card.cover) body.cover = d.cover;
    if ([...d.labels].sort().join() !== [...card.labels].sort().join()) body.labels = [...d.labels];
    if (Object.keys(body).length === 1) { this.#publish({ notice: 'Nothing changed.' }); return false; }
    if (!validCardEdit(body)) { this.#publish({ notice: 'Check the fields: the date is YYYY-MM-DD and the text may not hold hidden characters.' }); return false; }
    return this.#write<Card>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${s.boardId}/cards/${card.id}`, body: body as never }), c => {
      this.#replaceCard(c); this.#publish({ draft: draftOf(c), notice: quiet ? undefined : 'Saved.' });
    }, 'The card');
  }

  async archiveCard() {
    const s = this.#state; const card = s.cards.find(c => c.id === s.open);
    if (!card) return false;
    const ok = await this.#write<Card>(() => this.client.request({ method: 'PUT', path: `${BOARDS_PATH}/${s.boardId}/cards/${card.id}`, body: { expectedVersion: card.version, archived: true } }), c => this.#replaceCard(c), 'The card');
    if (ok) this.closeCard();
    return ok;
  }

  async addComment(text: string) {
    const s = this.#state; const body = text.replace(/\r\n?/g, '\n').trim();
    if (!s.open || !body) return false;
    if ([...body].length > MAX_COMMENT) { this.#publish({ notice: `A comment may have at most ${MAX_COMMENT} characters.` }); return false; }
    const cardId = s.open;
    return this.#write<{ comments: Comment[] }>(() => this.client.request({ method: 'POST', path: `${BOARDS_PATH}/${s.boardId}/cards/${cardId}/comments`, body: { body } }), b => {
      if (this.#state.open === cardId) this.#publish({ comments: Object.freeze(b.comments.map(c => Object.freeze(c))), commentsPhase: 'ready' });
      const card = this.#state.cards.find(c => c.id === cardId);
      if (card) this.#replaceCard({ ...card, comments: b.comments.length });
      void this.#loadActivity(cardId);
    }, 'The comment');
  }
}
