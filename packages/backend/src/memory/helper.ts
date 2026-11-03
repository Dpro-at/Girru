/**
 * The memory helper installs itself (MODELS-01-INSTALL; GIRRU_MEMORY_HELPER).
 *
 * The memory helper is the local runtime (Ollama) plus the embedding model
 * `qwen3-embedding:0.6b` (about 640 MB). Without it memory falls back to the
 * offline `hash-v2` model, which is weaker in meaning and across languages.
 * This job makes it ready without the owner doing anything, and without
 * ever being in the way:
 *
 *  - Background only: start-up schedules it a few seconds later and never
 *    waits for it (OPS3). A reply never waits for it either.
 *  - Loopback only: OLLAMA_URL must be 127.0.0.1 / ::1 / localhost, or the
 *    job does nothing and memory keeps the hash fallback. A runtime it starts
 *    is bound to 127.0.0.1.
 *  - Steps: find the runtime (installed? running?), start it when it is
 *    installed but not running, pull the embedding model with progress, check
 *    that it answers, then re-embed the rows saved with the hash fallback
 *    (memory/reembed.ts). The small memory worker comes later, only when
 *    MEMORY_WORKER_MODEL names one (its model waits for the owner's board).
 *  - Resumable: the state is kept in `<data>/memory-helper.json`; Ollama
 *    keeps the parts it already downloaded, so the next try (after a failure,
 *    or at the next start) goes on from there. Failures are retried later
 *    (1 min, 5 min, 30 min, 2 h, then every 6 h); meanwhile the hash fallback
 *    stays in use.
 *  - Installing the runtime itself needs the owner's approval of the board,
 *    so a missing runtime is reported ("runtime_missing"), never installed.
 *  - The state holds codes, counts and model names only: no memory text, no
 *    paths, no error text from elsewhere.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defaultOllamaUrl } from '../config/ollama-url.js';
import { defaultDataDir } from '../config/secrets-bootstrap.js';
import { memoryHelperEnabled } from '../services/memory-helper-switch.js';
import { DEFAULT_EMBEDDING_MODEL, isLoopbackUrl, getEmbeddingService, resetEmbeddingService } from './embedding.js';
import { all, sql } from '../repositories/sql-steps.js';

/** The embedding model's download, as Ollama lists it (shown before the download starts). */
export const EMBEDDING_SIZE_BYTES = 640 * 1024 * 1024;
export const STATE_FILE = 'memory-helper.json';
export const START_DELAY_MS = 5_000;
/** Retry after a failure (then the last value, again and again). */
export const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000] as const;
/** A download that sends nothing for this long is stopped (and tried again later). */
export const STALL_MS = 60_000;
const RUNTIME_WAIT_MS = 20_000;
const PERSIST_EVERY_MS = 2_000;

export type HelperPhase = 'waiting' | 'checking' | 'starting_runtime' | 'downloading' | 'verifying' | 'reembedding' | 'ready' | 'fallback';
export type FallbackReason = 'hash_chosen' | 'not_loopback' | 'runtime_missing' | 'runtime_not_running' | 'download_failed' | 'model_not_answering';
export type ErrorCode = 'network' | 'stalled' | 'disk_full' | 'bad_response' | 'not_found' | `http_${number}`;

export interface PullProgress { model: string; phase: 'later' | 'downloading' | 'ready' | 'fallback'; completedBytes: number; sizeBytes: number | null; error?: ErrorCode }

export interface HelperState {
  version: 1;
  phase: HelperPhase;
  /** The embedding model (target of the memory vectors). */
  model: string;
  completedBytes: number;
  sizeBytes: number;
  reason?: FallbackReason;
  error?: ErrorCode;
  /** Failed tries in a row (0 after a success). */
  attempts: number;
  nextTryAt: string | null;
  updatedAt: string;
  readyAt: string | null;
  /** Memories re-embedded with the model since the last start of the job. */
  reembedded: number;
  /** Memories still on another model (hash fallback). */
  remaining: number;
  runtime: { installed: boolean; running: boolean; startedByGirru: boolean };
  worker: PullProgress | null;
}

/** What the job needs from the outside; tests replace parts (no network, no runtime). */
export interface HelperDeps {
  baseUrl: () => string;
  /** The runtime's program, or null when it is not installed. */
  findRuntime: () => Promise<string | null>;
  /** Start `<bin> serve` bound to this host:port (detached). */
  startRuntime: (bin: string, hostPort: string) => void;
  dataDir: () => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const sleepUnref = (ms: number) => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

async function exists(file: string): Promise<boolean> { try { await fs.promises.access(file); return true; } catch { return false; } }

/** The Ollama program: on the PATH (and the usual folders), or inside Ollama.app on a Mac. */
async function findOllama(): Promise<string | null> {
  const { subscriptionSearchDirs } = await import('../services/subscription-chat.js');
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of await subscriptionSearchDirs()) {
    for (const e of exts) { const f = path.join(dir, 'ollama' + e); if (await exists(f)) return f; }
  }
  if (process.platform === 'darwin') {
    const inApp = '/Applications/Ollama.app/Contents/Resources/ollama';
    if (await exists(inApp)) return inApp;
  }
  return null;
}

function startOllama(bin: string, hostPort: string): void {
  const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', env: { ...process.env, OLLAMA_HOST: hostPort }, windowsHide: true });
  child.on('error', () => { /* reported by the wait that follows */ });
  child.unref();
}

const defaultDeps: HelperDeps = {
  baseUrl: () => defaultOllamaUrl().replace(/\/+$/, ''),
  findRuntime: findOllama,
  startRuntime: startOllama,
  dataDir: () => defaultDataDir(),
  now: () => Date.now(),
  sleep: sleepUnref,
};
let deps: HelperDeps = defaultDeps;

/** Tests: replace some of the outside parts; `null` restores the real ones. */
export function setMemoryHelperDeps(partial: Partial<HelperDeps> | null): void {
  deps = partial ? { ...defaultDeps, ...partial } : defaultDeps;
}

// ---- State ------------------------------------------------------------------------

let state: HelperState | null = null;
let lastPersist = 0;

function embeddingModel(): string {
  return process.env.MEMORY_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
}

/** The small memory worker: only when MEMORY_WORKER_MODEL names a model (V3-10; its choice waits for the board). */
function workerModel(): string | null {
  const v = String(process.env.MEMORY_WORKER_MODEL ?? '').trim();
  return v && !/^(0|off|false|no)$/i.test(v) ? v : null;
}

function fresh(): HelperState {
  return {
    version: 1, phase: 'waiting', model: embeddingModel(), completedBytes: 0, sizeBytes: EMBEDDING_SIZE_BYTES,
    attempts: 0, nextTryAt: null, updatedAt: new Date(deps.now()).toISOString(), readyAt: null, reembedded: 0, remaining: 0,
    runtime: { installed: false, running: false, startedByGirru: false }, worker: null,
  };
}

function stateFile(): string { return path.join(deps.dataDir(), STATE_FILE); }

const PHASES = new Set<HelperPhase>(['waiting', 'checking', 'starting_runtime', 'downloading', 'verifying', 'reembedding', 'ready', 'fallback']);

function load(): HelperState {
  if (state) return state;
  let saved: Partial<HelperState> | null = null;
  try { saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { /* first run */ }
  const base = fresh();
  if (saved && saved.version === 1 && saved.model === base.model && PHASES.has(saved.phase as HelperPhase)) {
    state = { ...base, ...saved, runtime: { ...base.runtime, ...(saved.runtime ?? {}) } } as HelperState;
    // A job cut off by a quit goes on at the next start.
    if (!['ready', 'fallback'].includes(state.phase)) state.phase = 'waiting';
  } else {
    state = base;
  }
  return state;
}

function persist(force = false): void {
  if (!state) return;
  const now = deps.now();
  if (!force && now - lastPersist < PERSIST_EVERY_MS) return;
  lastPersist = now;
  try {
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* the state file is a convenience; the job goes on */ }
}

function update(patch: Partial<HelperState>, force = false): void {
  const s = load();
  Object.assign(s, patch, { updatedAt: new Date(deps.now()).toISOString() });
  persist(force);
}

/** The helper's state for the health view and the status route (a copy). */
export function memoryHelperStatus(): HelperState & { enabled: boolean; percent: number | null } {
  const s = load();
  const percent = s.phase === 'downloading' && s.sizeBytes > 0 ? Math.min(100, Math.floor((s.completedBytes / s.sizeBytes) * 100)) : s.phase === 'ready' ? 100 : null;
  return { ...structuredClone(s), enabled: memoryHelperEnabled(), percent };
}

// ---- Runtime ----------------------------------------------------------------------

async function call(pathname: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 3_000, ...rest } = init;
  return fetch(`${deps.baseUrl()}${pathname}`, { ...rest, signal: rest.signal ?? AbortSignal.timeout(timeoutMs) });
}

async function runtimeRunning(): Promise<boolean> {
  try { return (await call('/api/version', { timeoutMs: 2_000 })).ok; } catch { return false; }
}

async function installedModels(): Promise<string[]> {
  const res = await call('/api/tags', { timeoutMs: 3_000 });
  if (!res.ok) throw Object.assign(new Error('tags'), { code: `http_${res.status}` as ErrorCode });
  const body = await res.json() as { models?: Array<{ name?: unknown }> };
  return Array.isArray(body?.models) ? body.models.map((m) => String(m?.name ?? '')).filter(Boolean) : [];
}

/** Installed under this name (the tag `latest` is implied when none is given). */
export function hasModel(installed: readonly string[], wanted: string): boolean {
  const full = wanted.includes(':') ? wanted : `${wanted}:latest`;
  return installed.includes(full) || installed.includes(wanted);
}

/** host:port of a loopback URL, for OLLAMA_HOST (bound to 127.0.0.1). */
function loopbackHostPort(url: string): string {
  try { return `127.0.0.1:${new URL(url).port || '11434'}`; } catch { return '127.0.0.1:11434'; }
}

// ---- Download -----------------------------------------------------------------------

function errorCode(err: unknown): ErrorCode {
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof e?.code === 'string' && /^(network|stalled|disk_full|bad_response|not_found|http_\d+)$/.test(e.code)) return e.code as ErrorCode;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'stalled';
  return 'network';
}

/**
 * Pull one model through the local runtime with progress (NDJSON stream).
 * Ollama resumes the layers it already has, so a new call goes on from there.
 */
async function pull(model: string, onProgress: (completed: number, total: number | null) => void, signal: AbortSignal): Promise<void> {
  const idle = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const kick = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), STALL_MS); timer.unref?.(); };
  const both = AbortSignal.any([signal, idle.signal]);
  kick();
  try {
    let res: Response;
    try {
      res = await fetch(`${deps.baseUrl()}/api/pull`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal: both,
      });
    } catch (err) { throw Object.assign(new Error('pull'), { code: idle.signal.aborted ? 'stalled' : errorCode(err) }); }
    if (!res.ok || !res.body) throw Object.assign(new Error('pull'), { code: res.status === 404 ? 'not_found' : `http_${res.status}` });
    const layers = new Map<string, { total: number; completed: number }>();
    const decoder = new TextDecoder();
    let buf = '';
    let success = false;
    const handle = (line: string) => {
      if (!line.trim()) return;
      let msg: { status?: unknown; digest?: unknown; total?: unknown; completed?: unknown; error?: unknown };
      try { msg = JSON.parse(line); } catch { throw Object.assign(new Error('pull'), { code: 'bad_response' }); }
      if (msg.error !== undefined) {
        const text = String(msg.error);
        throw Object.assign(new Error('pull'), { code: /space|disk/i.test(text) ? 'disk_full' : /not found|does not exist/i.test(text) ? 'not_found' : 'network' });
      }
      if (typeof msg.digest === 'string' && Number.isFinite(Number(msg.total))) {
        layers.set(msg.digest, { total: Number(msg.total), completed: Math.min(Number(msg.completed) || 0, Number(msg.total)) });
        let total = 0, done = 0;
        for (const l of layers.values()) { total += l.total; done += l.completed; }
        onProgress(done, total > 0 ? total : null);
      }
      if (msg.status === 'success') success = true;
    };
    const reader = res.body.getReader();
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await reader.read(); } catch (err) { throw Object.assign(new Error('pull'), { code: idle.signal.aborted ? 'stalled' : errorCode(err) }); }
        if (chunk.done) break;
        kick();
        buf += decoder.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      }
      handle(buf + decoder.decode());
    } finally { reader.releaseLock?.(); }
    if (!success) throw Object.assign(new Error('pull'), { code: 'bad_response' });
  } finally { clearTimeout(timer); }
}

// ---- Re-embed -----------------------------------------------------------------------

async function staleCounts(target: string): Promise<Array<{ user_id: string; n: number }>> {
  return sql().read(all<{ user_id: string; n: number }>(
    `SELECT user_id, COUNT(*) AS n FROM memories WHERE embedding IS NULL OR embedding_model IS NULL OR embedding_model != ? GROUP BY user_id ORDER BY user_id`,
    target)).catch(() => []);
}

/** Re-embed every user's rows that are not on the model (in batches, a pause between them). */
async function reembedAll(signal: AbortSignal): Promise<{ done: number; remaining: number; failed: boolean }> {
  const { reembedUserMemories } = await import('./reembed.js');
  const target = getEmbeddingService().targetModel();
  let done = 0;
  for (const { user_id } of await staleCounts(target)) {
    for (;;) {
      if (signal.aborted) return { done, remaining: sum(await staleCounts(target)), failed: false };
      const r = await reembedUserMemories(user_id);
      done += r.reembedded;
      update({ reembedded: (load().reembedded ?? 0) + r.reembedded, remaining: sum(await staleCounts(target)) });
      if (r.error) return { done, remaining: sum(await staleCounts(target)), failed: true };
      if (r.remaining === 0 || r.reembedded === 0) break;
      await deps.sleep(0);
    }
  }
  return { done, remaining: sum(await staleCounts(target)), failed: false };
}
// Rows from before CORE-06 have no model column: the query counts them as "not on the model".
const sum = (rows: Array<{ n: number }>) => rows.reduce((s, r) => s + Number(r.n || 0), 0);

// ---- The job -------------------------------------------------------------------------

let running: Promise<HelperState> | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let controller: AbortController | null = null;

function scheduleRetry(attempts: number): string {
  const wait = RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)];
  const at = new Date(deps.now() + wait).toISOString();
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = null; void ensureMemoryHelper().catch(() => undefined); }, wait);
  retryTimer.unref?.();
  return at;
}

function fallback(reason: FallbackReason, error?: ErrorCode, retry = true): void {
  const attempts = (load().attempts ?? 0) + 1;
  update({ phase: 'fallback', reason, error, attempts, nextTryAt: retry ? scheduleRetry(attempts) : null }, true);
}

/**
 * Make the memory helper ready (one run at a time; a second call joins the
 * first). Never throws: every failure ends in the hash fallback plus a later
 * retry. Does nothing while GIRRU_MEMORY_HELPER is off.
 */
export function ensureMemoryHelper(): Promise<HelperState> {
  if (!memoryHelperEnabled()) return Promise.resolve(memoryHelperStatus());
  if (running) return running;
  controller = new AbortController();
  const signal = controller.signal;
  running = run(signal).catch(() => { fallback('download_failed', 'network'); return load(); })
    .finally(() => { running = null; })
    .then((s) => structuredClone(s));
  return running;
}

async function run(signal: AbortSignal): Promise<HelperState> {
  load();
  update({ phase: 'checking', reason: undefined, error: undefined, nextTryAt: null }, true);

  if (/^hash$/i.test(String(process.env.MEMORY_EMBEDDINGS ?? '').trim())) { update({ phase: 'fallback', reason: 'hash_chosen', nextTryAt: null }, true); return load(); }
  if (!isLoopbackUrl(deps.baseUrl())) { update({ phase: 'fallback', reason: 'not_loopback', nextTryAt: null }, true); return load(); }

  // 1. The runtime.
  let isRunning = await runtimeRunning();
  const bin = isRunning ? null : await deps.findRuntime();
  update({ runtime: { ...load().runtime, installed: isRunning || !!bin, running: isRunning } });
  if (!isRunning) {
    if (!bin) { fallback('runtime_missing'); return load(); }
    update({ phase: 'starting_runtime' }, true);
    try { deps.startRuntime(bin, loopbackHostPort(deps.baseUrl())); } catch { /* checked below */ }
    const until = deps.now() + RUNTIME_WAIT_MS;
    while (!isRunning && deps.now() < until && !signal.aborted) {
      await deps.sleep(1_000);
      isRunning = await runtimeRunning();
    }
    if (!isRunning) { fallback('runtime_not_running'); return load(); }
    update({ runtime: { installed: true, running: true, startedByGirru: true } });
  }
  if (signal.aborted) return load();

  // 2. The embedding model.
  const model = embeddingModel();
  let installed: string[];
  try { installed = await installedModels(); } catch (err) { fallback('runtime_not_running', errorCode(err)); return load(); }
  if (!hasModel(installed, model)) {
    update({ phase: 'downloading' }, true);
    try {
      await pull(model, (completed, total) => update({ completedBytes: completed, ...(total ? { sizeBytes: total } : {}) }), signal);
    } catch (err) {
      if (signal.aborted) { update({ phase: 'waiting' }, true); return load(); }
      fallback('download_failed', errorCode(err));
      return load();
    }
    update({ completedBytes: load().sizeBytes }, true);
  }

  // 3. Does it answer? (A new service: the old one may wait out a retry pause.)
  update({ phase: 'verifying' }, true);
  resetEmbeddingService();
  const probe = await getEmbeddingService().embedDetailed('memory helper check').catch(() => null);
  if (!probe?.semantic) { fallback('model_not_answering'); return load(); }

  // 4. Re-embed the rows saved with the hash fallback.
  update({ phase: 'reembedding', attempts: 0, reembedded: 0 }, true);
  const r = await reembedAll(signal);
  if (r.failed) { fallback('model_not_answering'); return load(); }
  update({ phase: 'ready', remaining: r.remaining, readyAt: load().readyAt ?? new Date(deps.now()).toISOString(), attempts: 0, nextTryAt: null, error: undefined, reason: undefined }, true);

  // 5. Later: the small memory worker (only when one is named).
  const worker = workerModel();
  if (worker && !signal.aborted) {
    if (hasModel(installed, worker)) {
      update({ worker: { model: worker, phase: 'ready', completedBytes: 0, sizeBytes: null } }, true);
    } else {
      update({ worker: { model: worker, phase: 'downloading', completedBytes: 0, sizeBytes: null } }, true);
      try {
        await pull(worker, (completed, total) => update({ worker: { model: worker, phase: 'downloading', completedBytes: completed, sizeBytes: total } }), signal);
        update({ worker: { model: worker, phase: 'ready', completedBytes: load().worker?.sizeBytes ?? 0, sizeBytes: load().worker?.sizeBytes ?? null } }, true);
      } catch (err) {
        update({ worker: { model: worker, phase: 'fallback', completedBytes: load().worker?.completedBytes ?? 0, sizeBytes: load().worker?.sizeBytes ?? null, error: errorCode(err) } }, true);
      }
    }
  } else if (!worker) {
    update({ worker: null });
  }
  return load();
}

/** Start-up: run the job a few seconds later in the background (never awaited; OPS3). */
export function startMemoryHelper(delayMs = START_DELAY_MS): void {
  if (!memoryHelperEnabled()) return;
  const s = load();
  const next = s.nextTryAt ? Date.parse(s.nextTryAt) - deps.now() : 0;
  const wait = Math.max(delayMs, Number.isFinite(next) ? next : 0);
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = null; void ensureMemoryHelper().catch(() => undefined); }, wait);
  retryTimer.unref?.();
}

/** Owner "Try again" (and tests): forget the wait and run now. */
export function retryMemoryHelper(): Promise<HelperState> {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (memoryHelperEnabled()) update({ nextTryAt: null }, true);
  return ensureMemoryHelper();
}

/** Shutdown and tests: stop a running download and the timers; the state file stays. */
export async function stopMemoryHelper(): Promise<void> {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  controller?.abort();
  await running?.catch(() => undefined);
  controller = null;
}

/** Tests: drop the in-memory state (the file is read again). */
export function resetMemoryHelperState(): void { state = null; lastPersist = 0; }


/**
 * The "Memory helper" row of the health view. Quiet: a download or the hash
 * fallback is not a problem by itself; the row asks for the owner only when
 * the runtime is missing (installing it needs the owner) or tries keep failing.
 */
export function memoryHelperRow(): { id: 'memory_helper'; state: 'ok' | 'needs_you'; word: string; detail: Record<string, unknown> } {
  const s = memoryHelperStatus();
  const mb = (b: number | null | undefined) => (b ? Math.round(b / (1024 * 1024)) : null);
  let word: string;
  let needsYou = false;
  switch (s.phase) {
    case 'ready': word = s.remaining > 0 ? `Ready, ${s.remaining} to update` : 'Ready'; break;
    case 'downloading': word = s.percent !== null ? `Downloading ${s.percent}%` : 'Downloading'; break;
    case 'reembedding': word = 'Updating memories'; break;
    case 'fallback':
      if (s.reason === 'hash_chosen') { word = 'Basic recall (chosen)'; break; }
      if (s.reason === 'not_loopback') { word = 'Basic recall (runtime not on this computer)'; break; }
      needsYou = s.reason === 'runtime_missing' || s.attempts >= 3;
      word = s.reason === 'runtime_missing' ? 'Basic recall, runtime not installed' : 'Basic recall for now, will try again';
      break;
    default: word = 'Getting ready';
  }
  return {
    id: 'memory_helper', state: needsYou ? 'needs_you' : 'ok', word,
    detail: {
      phase: s.phase, reason: s.reason ?? null, error: s.error ?? null, model: s.model, percent: s.percent,
      sizeMb: mb(s.sizeBytes), downloadedMb: mb(s.completedBytes), attempts: s.attempts, nextTryAt: s.nextTryAt,
      readyAt: s.readyAt, remaining: s.remaining, runtime: s.runtime,
      worker: s.worker ? { model: s.worker.model, phase: s.worker.phase, sizeMb: mb(s.worker.sizeBytes) } : null,
    },
  };
}
