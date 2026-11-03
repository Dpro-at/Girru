/**
 * STORE-MAP-01 pilot: the brief-file projection.
 *
 * Consumer `brief-file` keeps `<project folder>/.girru/brief.md` in step with
 * the project's memory. It always renders the CURRENT records (coalescing every
 * event since its watermark into one write), so an old event can never put old
 * text back. Rules:
 *  - The destination is checked against the hash Girru last wrote, before the
 *    write and again right before the atomic rename. A file changed outside
 *    Girru is a conflict: nothing is overwritten until the owner chooses.
 *  - An older run never replaces a newer projection (the state's watermark and
 *    projection version are re-checked before the rename; one run per scope).
 *  - Failures retry up to MAX_ATTEMPTS, then the state is `dead` (visible).
 *    A missing folder is `unreachable`: events are kept and replayed later.
 *  - The file is a view. Lines removed from it are never read back, so a
 *    deleted line can never forget a memory.
 */

import fs, { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { q } from '../../repositories/sql-steps.js';
import { nowText } from '../../db/pg/dialect.js';
import { findProject, type Project } from '../../repositories/chat-conversations.js';
import { assertProjectFilesOnly, briefMarkdown, projectBrief } from '../bridge/brief.js';
import { redactImportText } from '../import/redact.js';
import { latestSeq, scopeInfo, enabledScopes } from './events.js';
import { safeWriteFile, SafeFileError } from '../../services/safe-file.js';
import { storeP7Enabled } from '../../services/store-p7.js';

export const BRIEF_CONSUMER = 'brief-file';
export const BRIEF_FILE = path.join('.girru', 'brief.md');
export const MAX_ATTEMPTS = 5;

export type ProjectionStatus = 'up_to_date' | 'waiting' | 'conflict' | 'unreachable' | 'dead';

export interface ProjectionState {
  consumer: string;
  scope: string;
  target: string | null;
  watermark: number;
  projectionVersion: number;
  contentHash: string | null;
  status: ProjectionStatus;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface RunResult {
  status: ProjectionStatus;
  wrote: boolean;
  watermark: number;
  projectionVersion: number;
  reason?: string;
}

export interface RunOptions {
  /** Rebuild: render even when the watermark says nothing changed; also restarts a dead state. */
  force?: boolean;
  /** The owner chose Girru's version in a conflict: the outside file is kept beside it, then replaced. */
  overwrite?: boolean;
  /** P6 screens: false = the caller kept the outside text itself (a memory proposal); no copy beside the file. */
  keepOutsideFile?: boolean;
  /** Test hook: runs after the new file is staged and before the destination is re-checked. */
  beforeRename?: () => Promise<void> | void;
}

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

/** A file or folder Girru may not write through: a link, a different kind of entry, or a hard-linked file. */
class UnsafeEntryError extends Error {}

/** The bytes of a regular file, read without following a link; null when it does not exist. */
function readNoFollow(file: string): Buffer | null {
  let fd: number;
  try { fd = fs.openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') throw new UnsafeEntryError(`${path.basename(file)} is a link`);
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new UnsafeEntryError(`${path.basename(file)} is not a plain file`);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

function fileHash(file: string): string | null {
  const b = readNoFollow(file);
  return b === null ? null : sha(b);
}

/**
 * `<folder>/.girru`, made or checked: a real folder (never a link) whose real
 * path is inside the project folder's real path.
 */
function girruDir(folder: string): string {
  const root = fs.realpathSync.native(folder);
  const dir = path.join(root, path.dirname(BRIEF_FILE));
  let st: fs.Stats | null = null;
  try { st = fs.lstatSync(dir); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new UnsafeEntryError('.girru in the project folder is a link or a file');
  if (!st) fs.mkdirSync(dir, { mode: 0o755 });
  const real = fs.realpathSync.native(dir);
  if (real !== dir || path.dirname(real) !== root) throw new UnsafeEntryError('.girru is outside the project folder');
  return dir;
}

function toState(r: any): ProjectionState {
  return {
    consumer: r.consumer, scope: r.scope, target: r.target ?? null,
    watermark: Number(r.watermark) || 0, projectionVersion: Number(r.projection_version) || 0,
    contentHash: r.content_hash ?? null, status: r.status, attempts: Number(r.attempts) || 0,
    lastError: r.last_error ?? null, updatedAt: String(r.updated_at),
  };
}

export async function getState(consumer: string, scope: string): Promise<ProjectionState | null> {
  const r = await q.one('SELECT * FROM projection_state WHERE consumer = ? AND scope = ?', consumer, scope);
  return r ? toState(r) : null;
}

async function ensureState(consumer: string, scope: string): Promise<ProjectionState> {
  await q.run(`INSERT INTO projection_state (consumer, scope) SELECT ?, ? WHERE NOT EXISTS
    (SELECT 1 FROM projection_state WHERE consumer = ? AND scope = ?)`, consumer, scope, consumer, scope);
  return (await getState(consumer, scope))!;
}

async function setStatus(s: ProjectionState, status: ProjectionStatus, error: string | null, countAttempt: boolean): Promise<ProjectionState> {
  const attempts = countAttempt ? s.attempts + 1 : s.attempts;
  const final: ProjectionStatus = countAttempt && status === 'waiting' && attempts >= MAX_ATTEMPTS ? 'dead' : status;
  await q.run(`UPDATE projection_state SET status = ?, attempts = ?, last_error = ?, updated_at = ${nowText(q.dialect)}
    WHERE consumer = ? AND scope = ?`, final, attempts, error ? error.slice(0, 300) : null, s.consumer, s.scope);
  return { ...s, status: final, attempts, lastError: error };
}

/** What the owner sees: the stored state, with `waiting` when events are past the watermark. */
export async function syncStatus(scope: string, consumer = BRIEF_CONSUMER): Promise<ProjectionState & { latestSeq: number }> {
  const s = await ensureState(consumer, scope);
  const latest = await latestSeq(scope);
  const status: ProjectionStatus = s.status === 'up_to_date' && latest > s.watermark ? 'waiting' : s.status;
  return { ...s, status, latestSeq: latest };
}

async function projectOf(scope: string): Promise<{ ownerId: string; project: Project | undefined }> {
  const info = await scopeInfo(scope);
  if (!info) throw new Error(`Unknown change scope ${scope}`);
  return { ownerId: info.ownerId, project: await findProject(info.ownerId, info.projectId) };
}

/** Leftover staged files from a crash between write and rename. */
function removeStaged(dir: string): void {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) if (/^brief\.md\.[0-9a-f]{16}\.tmp$/.test(n)) fs.rmSync(path.join(dir, n), { force: true });
}

function stage(dir: string, text: string): string {
  const tmp = path.join(dir, `brief.md.${randomBytes(8).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o644);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return tmp;
}

const running = new Map<string, Promise<RunResult>>();

/** Bring the scope's brief file up to date. One run per scope at a time. */
export function runBriefProjection(scope: string, opts: RunOptions = {}): Promise<RunResult> {
  const key = `${BRIEF_CONSUMER}\u0000${scope}`;
  const prev = running.get(key) ?? Promise.resolve(null as unknown as RunResult);
  const next = prev.catch(() => null).then(() => runOnce(scope, opts));
  running.set(key, next);
  return next.finally(() => { if (running.get(key) === next) running.delete(key); });
}

async function runOnce(scope: string, opts: RunOptions): Promise<RunResult> {
  let s = await ensureState(BRIEF_CONSUMER, scope);
  const result = (st: ProjectionState, wrote: boolean, reason?: string): RunResult =>
    ({ status: st.status, wrote, watermark: st.watermark, projectionVersion: st.projectionVersion, ...(reason ? { reason } : {}) });

  if (s.status === 'dead' && !opts.force) return result(s, false, 'dead: rebuild to retry');

  const { ownerId, project } = await projectOf(scope);
  if (!project?.folder) return result(await setStatus(s, 'unreachable', 'The project has no folder', false), false);
  const folder = project.folder;
  try { if (!fs.statSync(folder).isDirectory()) throw new Error('not a folder'); } catch {
    return result(await setStatus(s, 'unreachable', 'The project folder is not reachable', false), false);
  }
  let dir: string;
  try { dir = girruDir(folder); } catch (err) {
    if (err instanceof UnsafeEntryError) return result(await setStatus(s, 'conflict', err.message, false), false);
    return result(await setStatus(s, 'unreachable', 'The project folder is not reachable', false), false);
  }
  const target = path.join(dir, path.basename(BRIEF_FILE));

  try {
    const max = await latestSeq(scope);
    const current = fileHash(target);
    const outside = current !== null && current !== s.contentHash;
    if (outside && !opts.overwrite) {
      return result(await setStatus(s, 'conflict', 'The file was changed outside Girru', false), false);
    }
    if (!opts.force && !outside && s.status === 'up_to_date' && max <= s.watermark && current !== null) return result(s, false);

    const nextVersion = s.projectionVersion + 1;
    const brief = await projectBrief(ownerId, project);
    // S4 (P7): owner, people and personal drawers never reach a project file.
    if (storeP7Enabled()) {
      try { assertProjectFilesOnly(brief); } catch (err) {
        return result(await setStatus(s, 'conflict', `${(err as Error).message}; nothing was written`, false), false);
      }
    }
    const body = briefMarkdown(brief);
    // The brief is redacted already (brief.ts); a text that still looks like a secret is never written.
    if (Object.values(redactImportText(body).counts).some((n) => Number(n) > 0)) {
      return result(await setStatus(s, 'conflict', 'The brief still contains something that looks like a secret; nothing was written', false), false);
    }
    const text = `<!-- girru:brief scope=${scope} seq=${max} projection=${nextVersion} · generated from Girru's database; edits here are not read back -->\n\n${body}\n`;

    removeStaged(dir);
    if (storeP7Enabled()) return await writeSafely(scope, folder, target, text, current, max, nextVersion, s, !!(outside && opts.overwrite && opts.keepOutsideFile !== false), opts, result);
    if (outside && opts.overwrite && opts.keepOutsideFile !== false) {
      // The outside version is kept beside it, copied from the file itself (never through a link).
      const kept = readNoFollow(target);
      if (kept) fs.writeFileSync(path.join(dir, `brief.outside-${nextVersion}.md`), kept, { flag: 'wx', mode: 0o644 });
    }
    const tmp = stage(dir, text);
    // The fingerprint of what Girru wrote: the staged file's bytes as they are on disk.
    const hash = fileHash(tmp);
    try {
      await opts.beforeRename?.();
      // Re-check: a newer projection or an outside edit since we looked wins.
      const fresh = (await getState(BRIEF_CONSUMER, scope))!;
      if (fresh.watermark > max || fresh.projectionVersion >= nextVersion) {
        fs.rmSync(tmp, { force: true });
        return result(fresh, false, 'superseded by a newer projection');
      }
      if (fileHash(target) !== current) {
        fs.rmSync(tmp, { force: true });
        return result(await setStatus(fresh, 'conflict', 'The file changed while Girru was writing it', false), false);
      }
      fs.renameSync(tmp, target);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    const done = await q.run(`UPDATE projection_state SET target = ?, watermark = ?, projection_version = ?, content_hash = ?, status = 'up_to_date',
      attempts = 0, last_error = NULL, updated_at = ${nowText(q.dialect)} WHERE consumer = ? AND scope = ? AND projection_version = ?`,
      target, max, nextVersion, hash, BRIEF_CONSUMER, scope, s.projectionVersion);
    s = (await getState(BRIEF_CONSUMER, scope))!;
    return result(s, done.changes === 1, done.changes === 1 ? undefined : 'state moved on during the write');
  } catch (err) {
    if (err instanceof UnsafeEntryError) return result(await setStatus(s, 'conflict', err.message, false), false);
    s = await setStatus(s, 'waiting', (err as Error)?.message ?? String(err), true);
    return result(s, false, s.lastError ?? undefined);
  }
}

/**
 * STORE-MAP-01 P7 (SEC2-6): the same write through the one safe file writer.
 * The projection's own re-check (a newer run wins) happens first; the writer
 * then re-checks the file itself (compare-and-set on the hash Girru read)
 * right before the rename, so an outside edit in between is still refused.
 */
async function writeSafely(scope: string, folder: string, target: string, text: string, current: string | null, max: number, nextVersion: number,
  s: ProjectionState, keepOutside: boolean, opts: RunOptions, result: (st: ProjectionState, wrote: boolean, reason?: string) => RunResult): Promise<RunResult> {
  const rel = BRIEF_FILE.split(path.sep).join('/');
  try {
    if (keepOutside) {
      const kept = readNoFollow(target);
      if (kept) safeWriteFile(folder, `.girru/brief.outside-${nextVersion}.md`, kept, { expectSha256: null });
    }
    await opts.beforeRename?.();
    const fresh = (await getState(BRIEF_CONSUMER, scope))!;
    if (fresh.watermark > max || fresh.projectionVersion >= nextVersion) return result(fresh, false, 'superseded by a newer projection');
    const w = safeWriteFile(folder, rel, text, { expectSha256: current });
    const done = await q.run(`UPDATE projection_state SET target = ?, watermark = ?, projection_version = ?, content_hash = ?, status = 'up_to_date',
      attempts = 0, last_error = NULL, updated_at = ${nowText(q.dialect)} WHERE consumer = ? AND scope = ? AND projection_version = ?`,
      target, max, nextVersion, w.sha256, BRIEF_CONSUMER, scope, s.projectionVersion);
    const after = (await getState(BRIEF_CONSUMER, scope))!;
    return result(after, done.changes === 1, done.changes === 1 ? undefined : 'state moved on during the write');
  } catch (err) {
    if (err instanceof SafeFileError) {
      const fresh = (await getState(BRIEF_CONSUMER, scope))!;
      const why = err.code === 'changed' ? 'The file changed while Girru was writing it' : err.message;
      return result(await setStatus(fresh, err.code === 'locked' ? 'waiting' : 'conflict', why, err.code === 'locked'), false);
    }
    throw err;
  }
}

// --- worker ----------------------------------------------------------------

/** The brief file is gone (an unsafe entry is left to an explicit run, which reports it). */
function missing(file: string): boolean {
  try { return fileHash(file) === null; } catch { return false; }
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

/**
 * STORE-MAP-01 P6 (T6): instant sync is debounced per project. A scope with
 * new events is written once it has been quiet for DEBOUNCE_MS, or at the
 * latest MAX_WAIT_MS after its first unwritten event, so many changes give one
 * write. Without a debounce (the pilot) every tick writes at once.
 */
export const DEBOUNCE_MS = 1200;
export const MAX_WAIT_MS = 5000;
const pending = new Map<string, { seq: number; changedAt: number; since: number }>();
let debounceOn = false;
export function setProjectionDebounce(on: boolean): void { debounceOn = on; if (!on) pending.clear(); }

/** Debounce: true when the scope may be written now (always true while the debounce is off). */
function settled(scope: string, seq: number, now: number): boolean {
  if (!debounceOn) return true;
  const p = pending.get(scope);
  if (!p) { pending.set(scope, { seq, changedAt: now, since: now }); return false; }
  if (seq !== p.seq) { p.seq = seq; p.changedAt = now; }
  return now - p.changedAt >= DEBOUNCE_MS || now - p.since >= MAX_WAIT_MS;
}

/** One pass over every enabled scope (also what the timer runs). `now` is a test seam. */
export async function projectionTick(now = Date.now()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (const scope of await enabledScopes()) {
      const s = await syncStatus(scope);
      const due = s.status === 'waiting' || s.status === 'unreachable' || (s.status === 'up_to_date' && s.target && missing(s.target));
      if (!due) { pending.delete(scope); continue; }
      if (s.status === 'waiting' && !settled(scope, s.latestSeq, now)) continue;
      pending.delete(scope);
      await runBriefProjection(scope).catch((err) => console.warn('[Store pilot] projection failed:', (err as Error)?.message));
    }
  } finally { busy = false; }
}

export function startProjectionWorker(everyMs = 1500): void {
  // P6 polls faster; the debounce decides when a scope is written.
  if (timer) return;
  timer = setInterval(() => { void projectionTick(); }, everyMs);
  timer.unref?.();
}

export function stopProjectionWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
