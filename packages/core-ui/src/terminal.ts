import type { SessionClient } from './session';
import type { TerminalFrame, TerminalPrefs } from './terminal-contract.js';
import { DEFAULT_TERMINAL_PREFS, terminalPrefOk, terminalPrefs } from './terminal-contract.js';

export type TerminalPhase = 'idle' | 'starting' | 'open' | 'stopping' | 'exited' | 'off' | 'error';
export type TerminalState = Readonly<{ phase: TerminalPhase; id: string | null; cwd: string; shell: string; message?: string; projectId: string | null; command?: string; exitCode?: number; signal?: number; droppedOutput?: boolean; /** CP15: the read-only Agent commands tab. */ readOnly?: boolean }>;

const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** Output kept for redrawing the screen when the pane opens again. */
export const REPLAY_CHARS = 200_000;

/**
 * One shell for the chat's terminal pane. It outlives the pane (switching
 * panes keeps the shell running); keystrokes are sent in order, coalesced
 * while a send is in flight; output is replayed to a newly mounted screen.
 */
export class TerminalController {
  #state: TerminalState = Object.freeze({ phase: 'idle', id: null, cwd: '', shell: '', projectId: null });
  #listeners = new Set<() => void>();
  #output = new Set<(data: string) => void>();
  #replay = '';
  #outputSeq = 0;
  #pending = '';
  #sending = false;
  #stream: AbortController | null = null;
  #resizeTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;
  constructor(private readonly client: SessionClient) {}
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  #clearers = new Set<() => void>();
  /** Screens listening for "clear". */
  onClear(fn: () => void) { this.#clearers.add(fn); return () => { this.#clearers.delete(fn); }; }
  /** Clears the visible screen and the replay buffer (the shell keeps running). */
  clear() { this.#replay = ''; this.#clearers.forEach(fn => fn()); }
  /** Receives output; the buffered screen is replayed first. */
  onOutput(fn: (data: string) => void) { if (this.#replay) fn(this.#replay); this.#output.add(fn); return () => { this.#output.delete(fn); }; }
  private publish(p: Partial<TerminalState>) { if (this.#disposed) return; this.#state = Object.freeze({ ...this.#state, ...p }); this.#listeners.forEach(fn => fn()); }
  private emit(data: string) {
    if (this.#replay.length + data.length > REPLAY_CHARS && !this.#state.droppedOutput) this.publish({ droppedOutput: true });
    this.#replay = (this.#replay + data).slice(-REPLAY_CHARS);
    this.#output.forEach(fn => fn(data));
  }

  /** CP15: shows the read-only "Agent commands" session (what agents ran) without starting a shell. */
  attach(id: string) {
    if (this.#state.phase !== 'idle') return;
    this.publish({ phase: 'open', id, cwd: '', shell: 'Agent commands', readOnly: true, command: undefined, projectId: null });
    void this.follow(id);
  }

  /** Opens a shell in the project folder (or home without a project). */
  async open(projectId: string | null, size: { cols: number; rows: number }, command?: string) {
    if (this.#state.phase === 'starting' || this.#state.phase === 'open') return;
    this.#replay = ''; this.#pending = ''; this.#outputSeq = 0;
    this.publish({ phase: 'starting', message: undefined, projectId, id: null, command, exitCode: undefined, signal: undefined, droppedOutput: false });
    try {
      const r = await this.client.request({ method: 'POST', path: '/api/terminal/sessions', body: { cols: size.cols, rows: size.rows, ...(projectId ? { projectId } : {}), ...(command !== undefined ? { command } : {}) } } as never);
      if (r.status !== 201 || !record(r.body) || typeof r.body.id !== 'string') {
        const code = record(r.body) ? r.body.code : undefined;
        this.publish(code === 'disabled' ? { phase: 'off', message: 'The terminal is turned off on this server.' }
          : { phase: 'error', message: code === 'limit' ? 'Too many terminals are open. Close one first.' : code === 'not_loopback' ? 'The terminal works only on this computer.' : code === 'not_found' ? 'The project folder was not found.' : 'The terminal could not start.' });
        return;
      }
      this.publish({ phase: 'open', id: r.body.id, cwd: String(r.body.cwd ?? ''), shell: String(r.body.shell ?? '') });
      void this.follow(r.body.id);
    } catch { this.publish({ phase: 'error', message: 'The terminal could not start (no connection).' }); }
  }

  private async follow(id: string) {
    let last = 0;
    const ac = new AbortController(); this.#stream = ac;
    for (let tries = 0; !ac.signal.aborted && this.#state.id === id && tries < 6;) {
      const began = Date.now();
      try {
        const r = await this.client.terminalStream(id, last, (f: TerminalFrame) => {
          if (f.type === 'output') { if (f.seq > this.#outputSeq + 1) this.publish({ droppedOutput: true }); this.#outputSeq = f.seq; this.emit(f.data); }
          // A chat command shows how it ended in its own status line, not as a line of output.
          else { if (!this.#state.command) this.emit(`\r\n[process exited with ${f.signal ? `signal ${f.signal}` : `code ${f.exitCode}`}]\r\n`); this.publish({ phase: 'exited', exitCode: f.exitCode, signal: f.signal }); }
        }, ac.signal);
        const progressed = r.last > last;
        last = r.last;
        // A command stream that ends without its exit frame is a lost connection, not a finish.
        if (r.ended) { if (this.#state.command && ['open', 'stopping'].includes(this.#state.phase)) this.publish({ phase: 'error', message: 'Lost the connection to the terminal.' }); else if (this.#state.phase === 'open') this.publish({ phase: 'exited' }); return; }
        // A stream that closed with nothing new waits before re-attaching (never a tight loop).
        if (progressed || Date.now() - began >= 2000) tries = 0; else { tries++; await new Promise(res => setTimeout(res, 400 * tries)); }
      } catch {
        if (ac.signal.aborted) return;
        tries++; await new Promise(r => setTimeout(r, 500 * tries));
      }
    }
    if (!ac.signal.aborted && this.#state.id === id && ['open', 'stopping'].includes(this.#state.phase)) this.publish({ phase: 'error', message: 'Lost the connection to the terminal.' });
  }

  /** Retain the same PTY and wait for its authoritative exit frame after stopping. */
  async stop() {
    const id = this.#state.id; if (!id || this.#state.phase !== 'open') return;
    this.publish({ phase: 'stopping' });
    try { const r = await this.client.request({ method: 'POST', path: `/api/terminal/sessions/${id}/stop` } as never);
      if (r.status !== 204 && !(r.status === 200 && record(r.body) && r.body.ok === true) && this.getSnapshot().id === id && this.getSnapshot().phase === 'stopping') this.publish({ phase: 'open', message: 'Could not stop this command.' });
    } catch { if (this.getSnapshot().id === id && this.getSnapshot().phase === 'stopping') this.publish({ phase: 'open', message: 'Could not stop this command (no connection).' }); }
  }

  /** Keystrokes from the screen, sent in order. */
  write(data: string) {
    if (this.#state.phase !== 'open' || !data || this.#state.readOnly) return;
    this.#pending += data;
    if (!this.#sending) void this.flush();
  }
  private async flush() {
    this.#sending = true;
    try {
      while (this.#pending && this.#state.phase === 'open' && this.#state.id) {
        const chunk = this.#pending.slice(0, 32_000); this.#pending = this.#pending.slice(chunk.length);
        const r = await this.client.request({ method: 'POST', path: `/api/terminal/sessions/${this.#state.id}/input`, body: { data: chunk } } as never).catch(() => null);
        if (r && r.status === 409) { this.publish({ phase: 'exited' }); break; }
      }
    } finally { this.#sending = false; }
  }
  resize(cols: number, rows: number) {
    clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      const id = this.#state.id;
      if (this.#state.phase === 'open' && id && cols >= 10 && rows >= 2) void this.client.request({ method: 'POST', path: `/api/terminal/sessions/${id}/resize`, body: { cols: Math.min(500, cols), rows: Math.min(200, rows) } } as never).catch(() => null);
    }, 120);
  }
  /** Closes the shell on the server. */
  async close() {
    const id = this.#state.id;
    this.#stream?.abort(); this.#stream = null;
    this.publish({ phase: 'idle', id: null });
    if (id) await this.client.request({ method: 'DELETE', path: `/api/terminal/sessions/${id}` } as never).catch(() => null);
  }
  dispose() { void this.close(); clearTimeout(this.#resizeTimer); this.#disposed = true; this.#listeners.clear(); this.#output.clear(); this.#clearers.clear(); }
}


/** The terminal look, loaded from and saved to the server (per owner), applied at once. */
export class TerminalPrefsController {
  #prefs: Readonly<TerminalPrefs> = Object.freeze({ ...DEFAULT_TERMINAL_PREFS });
  #listeners = new Set<() => void>();
  #pending: Partial<TerminalPrefs> = {};
  #timer: ReturnType<typeof setTimeout> | undefined;
  #loaded = false;
  constructor(private readonly client: SessionClient) {}
  getSnapshot = () => this.#prefs;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  private set(p: TerminalPrefs) { this.#prefs = Object.freeze(p); this.#listeners.forEach(fn => fn()); }
  async load() {
    if (this.#loaded) return; this.#loaded = true;
    try {
      const r = await this.client.request({ method: 'GET', path: '/api/terminal/prefs' } as never);
      if (r.status === 200 && record(r.body)) this.set({ ...terminalPrefs(r.body.prefs), ...this.#pending });
    } catch { /* defaults stay */ }
  }
  /** Changes settings now; saves them a moment later (several quick changes become one save). */
  update(change: Partial<TerminalPrefs>) {
    const ok = Object.fromEntries(Object.entries(change).filter(([k, v]) => terminalPrefOk(k, v))) as Partial<TerminalPrefs>;
    if (!Object.keys(ok).length) return;
    this.set({ ...this.#prefs, ...ok });
    this.#pending = { ...this.#pending, ...ok };
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.flush(), 400);
  }
  reset() { this.update({ ...DEFAULT_TERMINAL_PREFS }); }
  async flush() {
    const body = this.#pending; this.#pending = {};
    if (!Object.keys(body).length) return;
    try { await this.client.request({ method: 'PUT', path: '/api/terminal/prefs', body } as never); } catch { /* kept for this page */ }
  }
  dispose() { clearTimeout(this.#timer); void this.flush(); this.#listeners.clear(); }
}

export const MAX_TERMINAL_TABS = 4;
const AGENT_LOG = 'agent-commands';
export type TerminalTab = Readonly<{ key: string; n: number; terminal: TerminalController; commandKey?: string }>;
export type TerminalTabsState = Readonly<{ tabs: readonly TerminalTab[]; active: string | null }>;

/** Several shells side by side as tabs (the server allows four per owner). */
export class TerminalTabs {
  #state: TerminalTabsState = Object.freeze({ tabs: [], active: null });
  #listeners = new Set<() => void>();
  #n = 0;
  constructor(private readonly client: SessionClient) {}
  getSnapshot = () => this.#state;
  subscribe = (fn: () => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
  private publish(p: Partial<TerminalTabsState>) { this.#state = Object.freeze({ ...this.#state, ...p }); this.#listeners.forEach(fn => fn()); }
  /** Tabs whose session still runs: a finished command keeps its tab but no longer takes a place. */
  #live() { return this.#state.tabs.filter(t => t.commandKey !== AGENT_LOG && t.terminal.getSnapshot().phase !== 'exited').length; }
  /** Whether another live terminal may open. */
  canAdd() { return this.#live() < MAX_TERMINAL_TABS; }
  /** Opens a new tab (its shell starts when its screen mounts). */
  add() {
    if (this.#live() >= MAX_TERMINAL_TABS) return null;
    const tab: TerminalTab = { key: `t${++this.#n}`, n: this.#n, terminal: new TerminalController(this.client) };
    this.publish({ tabs: [...this.#state.tabs, tab], active: tab.key });
    return tab;
  }
  command(key: string, command: string, projectId: string | null) {
    const old = this.#state.tabs.find(t => t.commandKey === key);
    if (old) return old;
    if (this.#live() >= MAX_TERMINAL_TABS) return null;
    const tab: TerminalTab = { key: `t${++this.#n}`, n: this.#n, terminal: new TerminalController(this.client), commandKey: key };
    this.publish({ tabs: [...this.#state.tabs, tab], active: this.#state.active });
    void tab.terminal.open(projectId, { cols: 80, rows: 24 }, command);
    return tab;
  }
  select(key: string) { if (this.#state.tabs.some(t => t.key === key)) this.publish({ active: key }); }
  /** CP15: when agents have run commands, their read-only "Agent commands" tab appears beside the shells (never taking a place). */
  async syncAgentLog() {
    if (this.#state.tabs.some(t => t.commandKey === AGENT_LOG)) return;
    try {
      const r = await this.client.request({ method: 'GET', path: '/api/terminal' } as never);
      const sessions = record(r.body) && Array.isArray(r.body.sessions) ? r.body.sessions as { id: string; exited: boolean; log?: boolean }[] : [];
      const log = r.status === 200 ? sessions.find(s => s.log && !s.exited) : undefined;
      if (!log || this.#state.tabs.some(t => t.commandKey === AGENT_LOG)) return;
      const tab: TerminalTab = { key: `t${++this.#n}`, n: this.#n, terminal: new TerminalController(this.client), commandKey: AGENT_LOG };
      tab.terminal.attach(log.id);
      this.publish({ tabs: [...this.#state.tabs, tab], active: this.#state.active ?? tab.key });
    } catch { /* the tab comes on the next check */ }
  }
  /** Closes a tab and its shell. */
  close(key: string) {
    const i = this.#state.tabs.findIndex(t => t.key === key); if (i < 0) return;
    this.#state.tabs[i].terminal.dispose();
    const tabs = this.#state.tabs.filter(t => t.key !== key);
    this.publish({ tabs, active: this.#state.active === key ? (tabs[Math.min(i, tabs.length - 1)]?.key ?? null) : this.#state.active });
  }
  /** A different project: every shell restarts in the new folder. */
  closeAll() { for (const t of this.#state.tabs) t.terminal.dispose(); this.publish({ tabs: [], active: null }); }
  dispose() { this.closeAll(); this.#listeners.clear(); }
}
