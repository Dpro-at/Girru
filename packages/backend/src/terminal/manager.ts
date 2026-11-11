/**
 * Built-in terminal sessions (TERM-01): one PTY shell per session, owned by
 * one account. Works on Windows (ConPTY), macOS and Linux through node-pty.
 *
 * SECURITY:
 *  - Off unless the server operator sets AGENT_TERMINAL=true.
 *  - The shell gets a minimal environment: never the server's own variables
 *    (JWT/encryption secrets, provider keys, database URLs).
 *  - Per-owner session cap, idle timeout, bounded output buffer and input size.
 */

import { randomUUID } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { accessSync, chmodSync, constants as fsConstants, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const TERMINAL_ENV = 'AGENT_TERMINAL';
export const MAX_SESSIONS_PER_OWNER = 4;
export const MAX_INPUT_BYTES = 64 * 1024;
export const MAX_BUFFER_BYTES = 256 * 1024;
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const MIN_COLS = 10, MAX_COLS = 500, MIN_ROWS = 2, MAX_ROWS = 200;

export function terminalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TERMINAL_ENV] === 'true';
}

/** The parts of node-pty we use (lets tests pass a fake). */
export interface PtyProcess {
  readonly pid?: number;
  onData(listener: (data: string) => void): { dispose(): void } | void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } | void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
export type PtySpawn = (file: string, args: string[], options: {
  name: string; cols: number; rows: number; cwd: string; env: Record<string, string>;
}) => PtyProcess;

/**
 * A chat command must look exactly like what runs: no control or format characters
 * (tab and newline allowed), so no zero-width, text-direction, tag or invisible filler
 * characters, and no line or paragraph separators.
 */
export const HIDDEN_COMMAND_CHARS = /(?![\t\n])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u115f\u1160\u3164\uffa0]/u;
export function commandAllowed(command: unknown): command is string {
  return typeof command === 'string' && !!command.trim() && command.length <= 16000 && !HIDDEN_COMMAND_CHARS.test(command);
}

export class TerminalError extends Error {
  constructor(readonly code: 'disabled' | 'limit' | 'not_found' | 'invalid' | 'closed' | 'unsupported', message: string) {
    super(message);
  }
}

/** Shell for this OS: the user's own login shell where it is known and exists. */
export function defaultShell(os: NodeJS.Platform = platform(), env: NodeJS.ProcessEnv = process.env): { file: string; args: string[] } {
  if (os === 'win32') {
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  const own = env.SHELL;
  if (own && own.startsWith('/') && existsSync(own)) return { file: own, args: ['-l'] };
  for (const candidate of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (existsSync(candidate)) return { file: candidate, args: candidate === '/bin/sh' ? [] : ['-l'] };
  }
  return { file: '/bin/sh', args: [] };
}

const PASS_THROUGH_POSIX = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ'];
const PASS_THROUGH_WIN = [
  'PATH', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'USERPROFILE', 'USERNAME', 'USERDOMAIN',
  'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'TEMP', 'TMP', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'OS',
];

/** Minimal shell environment: an allow-list, never the server's secrets. */
export function shellEnv(os: NodeJS.Platform = platform(), env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of os === 'win32' ? PASS_THROUGH_WIN : PASS_THROUGH_POSIX) {
    const value = env[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  // zsh marks output without a final newline with a reverse "%"; a fresh screen has none to mark.
  if (os !== 'win32') out.PROMPT_EOL_MARK = '';
  return out;
}

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = Number.isInteger(cols) ? (cols as number) : 80;
  const r = Number.isInteger(rows) ? (rows as number) : 24;
  return { cols: Math.min(MAX_COLS, Math.max(MIN_COLS, c)), rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, r)) };
}

export interface OutputChunk { seq: number; data: string }
type Listener = (event: { type: 'data'; chunk: OutputChunk } | { type: 'exit'; exitCode: number; signal?: number }) => void;

interface Session {
  id: string;
  ownerId: string;
  pty: PtyProcess;
  chunks: OutputChunk[];
  bufferedBytes: number;
  nextSeq: number;
  exitCode: number | null;
  signal?: number;
  listeners: Set<Listener>;
  idleTimer: NodeJS.Timeout | null;
  stopTimer: NodeJS.Timeout | null;
  command: boolean;
  createdAt: string;
  shell: string;
  /** CP15: the read-only "Agent commands" tab: what agents ran, with its output. No shell behind it. */
  log?: boolean;
}

export interface TerminalManagerOptions {
  spawn?: PtySpawn;
  idleTimeoutMs?: number;
  stopGraceMs?: number;
  env?: NodeJS.ProcessEnv;
  os?: NodeJS.Platform;
  cwd?: string;
}

/**
 * node-pty starts shells on macOS through a small `spawn-helper`. npm installs
 * its prebuilt copy without the run permission, so every shell fails with
 * "posix_spawnp failed". Give it the permission once, before the first shell.
 * Best effort: a read-only install keeps whatever it has.
 */
export function ensureSpawnHelper(os: NodeJS.Platform = platform(), arch: string = process.arch, resolvePkg: () => string = () => createRequire(import.meta.url).resolve('node-pty/package.json')): string[] {
  if (os === 'win32') return [];
  let root: string;
  try { root = dirname(resolvePkg()); } catch { return []; }
  const fixed: string[] = [];
  for (const helper of [join(root, 'prebuilds', `${os}-${arch}`, 'spawn-helper'), join(root, 'build', 'Release', 'spawn-helper')]) {
    if (!existsSync(helper)) continue;
    try { accessSync(helper, fsConstants.X_OK); } catch {
      try { chmodSync(helper, 0o755); fixed.push(helper); } catch { /* read-only install */ }
    }
  }
  return fixed;
}

async function loadNodePty(): Promise<PtySpawn> {
  const fixed = ensureSpawnHelper();
  if (fixed.length) console.warn('terminal_spawn_helper_fixed', fixed.length);
  const mod: any = await import('node-pty');
  const spawn = mod.spawn ?? mod.default?.spawn;
  if (typeof spawn !== 'function') throw new TerminalError('disabled', 'The terminal backend is not available on this server');
  return spawn as PtySpawn;
}

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private readonly logs = new Map<string, string>();
  private spawnFn: PtySpawn | null;
  private readonly idleTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly opening = new Map<string, number>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly os: NodeJS.Platform;
  private readonly cwd: string | undefined;

  constructor(options: TerminalManagerOptions = {}) {
    this.spawnFn = options.spawn ?? null;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.stopGraceMs = options.stopGraceMs ?? 3000;
    this.env = options.env ?? process.env;
    this.os = options.os ?? platform();
    this.cwd = options.cwd;
  }

  list(ownerId: string) {
    return [...this.sessions.values()]
      .filter(s => s.ownerId === ownerId)
      .map(s => ({ id: s.id, shell: s.shell, createdAt: s.createdAt, exited: s.exitCode !== null, ...(s.log ? { log: true } : {}) }));
  }

  /** `size.cwd`: a folder already checked by the caller (a project folder); otherwise home. */
  async create(ownerId: string, size: { cols?: unknown; rows?: unknown; cwd?: string; extraEnv?: Record<string, string>; command?: string } = {}) {
    if (!terminalEnabled(this.env)) throw new TerminalError('disabled', 'The terminal is turned off on this server');
    // A finished session keeps its transcript for replay but no longer takes a place.
    // Sessions still starting count too, so two quick opens cannot pass the cap.
    if ([...this.sessions.values()].filter(t => t.ownerId === ownerId && !t.log && t.exitCode === null).length + (this.opening.get(ownerId) ?? 0) >= MAX_SESSIONS_PER_OWNER) {
      throw new TerminalError('limit', `At most ${MAX_SESSIONS_PER_OWNER} terminals per account`);
    }
    if (size.command !== undefined && !commandAllowed(size.command)) throw new TerminalError('invalid', 'Invalid command');
    // Not verified on a real Windows shell yet: chat commands stay off there until they are.
    if (size.command !== undefined && this.os === 'win32') throw new TerminalError('unsupported', 'Running a command from chat is not available on Windows yet. Copy it into the Terminal instead.');
    this.opening.set(ownerId, (this.opening.get(ownerId) ?? 0) + 1);
    try {
    const spawn = this.spawnFn ?? (this.spawnFn = await loadNodePty());
    const { cols, rows } = clampSize(size.cols, size.rows);
    const shell = defaultShell(this.os, this.env);
    // CHAT-BUILD-01 stage 3: a project's terminal also gets the project's own variables (checked names).
    const env = { ...shellEnv(this.os, this.env), ...(size.extraEnv ?? {}) };
    const cwd = size.cwd ?? this.cwd ?? (env.HOME || env.USERPROFILE || homedir());
    const args = size.command === undefined ? shell.args : this.os === 'win32' ? ['-NoLogo', '-NonInteractive', '-Command', size.command] : [...shell.args, '-c', '--', size.command];
    const pty = spawn(shell.file, args, { name: 'xterm-256color', cols, rows, cwd, env });
    const session: Session = {
      id: randomUUID(), ownerId, pty, chunks: [], bufferedBytes: 0, nextSeq: 1, exitCode: null,
      listeners: new Set(), idleTimer: null, stopTimer: null, command: size.command !== undefined, createdAt: new Date().toISOString(), shell: shell.file,
    };
    pty.onData(data => this.push(session, data));
    pty.onExit(({ exitCode, signal }) => {
      session.exitCode = exitCode; session.signal = signal;
      for (const l of session.listeners) l({ type: 'exit', exitCode, ...(signal ? { signal } : {}) });
      if (session.stopTimer) clearTimeout(session.stopTimer);
      session.stopTimer = null;
      // Keep the finished transcript for a while (replay), then let it go.
      if (this.sessions.get(session.id) === session) this.touch(session);
    });
    this.sessions.set(session.id, session);
    this.touch(session);
    return { id: session.id, shell: shell.file, cols, rows, cwd };
    } finally { const n = (this.opening.get(ownerId) ?? 1) - 1; if (n) this.opening.set(ownerId, n); else this.opening.delete(ownerId); }
  }

  /** CP15: add what an agent ran (and its output) to the owner's read-only "Agent commands" tab, made on first use. */
  appendLog(ownerId: string, text: string) {
    const known = this.logs.get(ownerId);
    let s = known ? this.sessions.get(known) : undefined;
    if (!s) {
      const quiet: PtyProcess = { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
      s = { id: randomUUID(), ownerId, pty: quiet, chunks: [], bufferedBytes: 0, nextSeq: 1, exitCode: null, listeners: new Set(), idleTimer: null, stopTimer: null,
        command: true, createdAt: new Date().toISOString(), shell: 'Agent commands', log: true };
      this.sessions.set(s.id, s); this.logs.set(ownerId, s.id);
    }
    this.push(s, text.replace(/\r?\n/g, '\r\n'));
  }

  /** Owner-scoped lookup: another account's session id reads as not found. */
  private get(ownerId: string, id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.ownerId !== ownerId) throw new TerminalError('not_found', 'No such terminal');
    return s;
  }

  write(ownerId: string, id: string, data: unknown) {
    const s = this.get(ownerId, id);
    if (s.log) throw new TerminalError('invalid', 'This tab only shows what agents ran');
    if (typeof data !== 'string' || !data) throw new TerminalError('invalid', 'Input must be a non-empty string');
    if (Buffer.byteLength(data, 'utf8') > MAX_INPUT_BYTES) throw new TerminalError('invalid', `Input is larger than ${MAX_INPUT_BYTES} bytes`);
    if (s.exitCode !== null) throw new TerminalError('closed', 'The shell has exited');
    s.pty.write(data);
    this.touch(s);
  }

  resize(ownerId: string, id: string, cols: unknown, rows: unknown) {
    const s = this.get(ownerId, id);
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new TerminalError('invalid', 'cols and rows must be integers');
    if (s.exitCode !== null) throw new TerminalError('closed', 'The shell has exited');
    const size = clampSize(cols, rows);
    s.pty.resize(size.cols, size.rows);
    this.touch(s);
    return size;
  }

  /**
   * Subscribe to output after `afterSeq` (replays what is still buffered).
   * Returns an unsubscribe function.
   */
  subscribe(ownerId: string, id: string, afterSeq: number, listener: Listener): () => void {
    const s = this.get(ownerId, id);
    for (const chunk of s.chunks) if (chunk.seq > afterSeq) listener({ type: 'data', chunk });
    if (s.exitCode !== null) {
      listener({ type: 'exit', exitCode: s.exitCode, ...(s.signal ? { signal: s.signal } : {}) });
      return () => {};
    }
    s.listeners.add(listener);
    return () => { s.listeners.delete(listener); };
  }

  /** Stop this session without discarding its exit event or transcript. */
  stop(ownerId: string, id: string) {
    const s = this.get(ownerId, id);
    if (s.log) { this.destroy(s); return; }
    if (s.exitCode !== null || s.stopTimer) return;
    this.kill(s, 'SIGTERM');
    // Still running after the grace time: end it for good.
    if (s.exitCode === null && this.os !== 'win32') {
      s.stopTimer = setTimeout(() => { s.stopTimer = null; if (s.exitCode === null) this.kill(s, 'SIGKILL'); }, this.stopGraceMs);
      s.stopTimer.unref?.();
    }
  }

  /** On POSIX a PTY leads its own process group: signal the group, so the command's children end too. */
  private kill(s: Session, signal: NodeJS.Signals) {
    if (this.os !== 'win32' && Number.isInteger(s.pty.pid) && s.pty.pid! > 1) {
      try { process.kill(-s.pty.pid!, signal); return; } catch { /* fall back to the PTY handle */ }
    }
    try { s.pty.kill(this.os === 'win32' ? undefined : signal); } catch { /* already exiting; its exit still arrives */ }
  }

  close(ownerId: string, id: string) {
    const s = this.get(ownerId, id);
    this.destroy(s);
  }

  closeAll() {
    for (const s of [...this.sessions.values()]) this.destroy(s);
  }

  private destroy(s: Session) {
    this.clearIdle(s);
    this.sessions.delete(s.id);
    if (s.log && this.logs.get(s.ownerId) === s.id) this.logs.delete(s.ownerId);
    if (s.stopTimer) clearTimeout(s.stopTimer);
    s.stopTimer = null;
    if (s.exitCode === null) this.kill(s, 'SIGKILL');
    s.listeners.clear();
  }

  private push(s: Session, data: string) {
    const chunk = { seq: s.nextSeq++, data };
    s.chunks.push(chunk);
    s.bufferedBytes += Buffer.byteLength(data, 'utf8');
    while (s.bufferedBytes > MAX_BUFFER_BYTES && s.chunks.length > 1) {
      s.bufferedBytes -= Buffer.byteLength(s.chunks.shift()!.data, 'utf8');
    }
    for (const l of s.listeners) l({ type: 'data', chunk });
  }

  private touch(s: Session) {
    this.clearIdle(s);
    // A running command is never ended for being quiet (a long build takes no input).
    if (s.command && s.exitCode === null) return;
    s.idleTimer = setTimeout(() => this.destroy(s), this.idleTimeoutMs);
    s.idleTimer.unref?.();
  }

  private clearIdle(s: Session) {
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
}

/** The terminal screen's look, saved per owner (TERM-PRO-01). Unknown or bad fields fall back to the defaults. */
export const TERMINAL_THEMES = ['dpro-night', 'dpro-day', 'graphite', 'midnight', 'ocean', 'forest', 'paper', 'contrast'] as const;
export const TERMINAL_FONTS = ['system', 'sf-mono', 'menlo', 'monaco', 'jetbrains', 'fira', 'cascadia', 'courier'] as const;
export const TERMINAL_CURSORS = ['block', 'bar', 'underline'] as const;
export type TerminalPrefs = {
  theme: (typeof TERMINAL_THEMES)[number]; fontFamily: (typeof TERMINAL_FONTS)[number]; fontSize: number; lineHeight: number; letterSpacing: number;
  cursorStyle: (typeof TERMINAL_CURSORS)[number]; cursorBlink: boolean; scrollback: number; copyOnSelect: boolean;
};
export const DEFAULT_TERMINAL_PREFS: TerminalPrefs = { theme: 'dpro-night', fontFamily: 'system', fontSize: 12, lineHeight: 1.2, letterSpacing: 0, cursorStyle: 'block', cursorBlink: true, scrollback: 5000, copyOnSelect: false };

const pick = <T extends string>(list: readonly T[], x: unknown, d: T): T => (list as readonly unknown[]).includes(x) ? x as T : d;
const num = (x: unknown, min: number, max: number, d: number, step = 1) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? Number((Math.round(x / step) * step).toFixed(2)) : d;
/** Strict for a save (null when anything is off), lenient for reading old values. */
export function terminalPrefs(x: unknown, strict = false): TerminalPrefs | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return strict ? null : { ...DEFAULT_TERMINAL_PREFS };
  const o = x as Record<string, unknown>;
  if (strict && Object.keys(o).some(k => !(k in DEFAULT_TERMINAL_PREFS))) return null;
  const d = DEFAULT_TERMINAL_PREFS;
  const out: TerminalPrefs = {
    theme: pick(TERMINAL_THEMES, o.theme, d.theme), fontFamily: pick(TERMINAL_FONTS, o.fontFamily, d.fontFamily),
    fontSize: num(o.fontSize, 9, 24, d.fontSize), lineHeight: num(o.lineHeight, 1, 1.8, d.lineHeight, 0.05), letterSpacing: num(o.letterSpacing, 0, 3, d.letterSpacing, 0.5),
    cursorStyle: pick(TERMINAL_CURSORS, o.cursorStyle, d.cursorStyle), cursorBlink: typeof o.cursorBlink === 'boolean' ? o.cursorBlink : d.cursorBlink,
    scrollback: num(o.scrollback, 1000, 50000, d.scrollback, 1000), copyOnSelect: typeof o.copyOnSelect === 'boolean' ? o.copyOnSelect : d.copyOnSelect,
  };
  if (strict && Object.entries(o).some(([k, v]) => out[k as keyof TerminalPrefs] !== v)) return null;
  return out;
}
