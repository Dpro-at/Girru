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
import { briefMarkdown, projectBrief } from '../bridge/brief.js';
import { redactImportText } from '../import/redact.js';
import { latestSeq, scopeInfo, enabledScopes } from './events.js';

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
    const body = briefMarkdown(await projectBrief(ownerId, project));
    // The brief is redacted already (brief.ts); a text that still looks like a secret is never written.
    if (Object.values(redactImportText(body).counts).some((n) => Number(n) > 0)) {
      return result(await setStatus(s, 'conflict', 'The brief still contains something that looks like a secret; nothing was written', false), false);
    }
    const text = `<!-- girru:brief scope=${scope} seq=${max} projection=${nextVersion} · generated from Girru's database; edits here are not read back -->\n\n${body}\n`;

    removeStaged(dir);
    if (outside && opts.overwrite) {
      // The outside version is kept beside it, copied from the file itself (never through a link).
      const kept = readNoFollow(target);
      if (kept) fs.writeFileSync(path.join(dir, `brief.outside-${nextVersion}.md`), kept, { flag: 'wx', mode: 0o644 });
    }
    const tmp = stage(dir, text);
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
    const hash = sha(text);
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

// --- worker ----------------------------------------------------------------

/** The brief file is gone (an unsafe entry is left to an explicit run, which reports it). */
function missing(file: string): boolean {
  try { return fileHash(file) === null; } catch { return false; }
}

let timer: NodeJS.Timeout | null = null;
let busy = false;

/** One pass over every enabled scope (also what the timer runs). */
export async function projectionTick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    for (const scope of await enabledScopes()) {
      const s = await syncStatus(scope);
      if (s.status === 'waiting' || s.status === 'unreachable' || (s.status === 'up_to_date' && s.target && missing(s.target))) {
        await runBriefProjection(scope).catch((err) => console.warn('[Store pilot] projection failed:', (err as Error)?.message));
      }
    }
  } finally { busy = false; }
}

export function startProjectionWorker(everyMs = 1500): void {
  if (timer) return;
  timer = setInterval(() => { void projectionTick(); }, everyMs);
  timer.unref?.();
}

export function stopProjectionWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
