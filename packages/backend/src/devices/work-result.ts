/**
 * CP10 (D8, D9; Mohamed 2026-11-10: both ways): the work a computer did on a task comes back to the
 * computer that sent it. The target snapshots the project folder when the task starts and when it ends;
 * the difference is the work (secret-looking files are never in a snapshot). With a GitHub remote it is
 * pushed as the computer's own branch; otherwise it travels inside the encrypted channel, in parts.
 * On the sending computer nothing is written into the project until the owner presses Bring into.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshotState, checkpointPatch } from '../services/chat-checkpoints.js';
import { minimalChildEnv } from '../tools/exec-policy.js';

export const DIRECT_MAX_BYTES = 3 * 1024 * 1024;
export const PART_CHARS = 16_000;
export type ResultFile = { path: string; added: number; removed: number };
export type WorkMode = 'github' | 'direct' | 'too_large' | 'none';
export interface WorkResult { taskId: string; mode: WorkMode; branch?: string; base?: string; files: ResultFile[]; size?: number; sha256?: string; parts?: number }

/** No hooks, no pager, no outside programs; the user's own config (identity, credentials) only where it is needed. */
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external=', '--no-pager'];
function git(cwd: string, args: string[], opts: { user?: boolean; index?: string; timeout?: number } = {}): Promise<string> {
  const env = opts.user
    ? minimalChildEnv({ GIT_TERMINAL_PROMPT: '0', ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}), ...(opts.index ? { GIT_INDEX_FILE: opts.index } : {}) })
    : minimalChildEnv({ GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...(opts.index ? { GIT_INDEX_FILE: opts.index } : {}) });
  return new Promise((resolve, reject) => execFile('git', [...SAFE, ...args], { cwd, timeout: opts.timeout ?? 30_000, maxBuffer: DIRECT_MAX_BYTES + 1, windowsHide: true, env }, (err, stdout, stderr) => err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve(String(stdout))));
}
const BRANCH = /^girru\/[a-z0-9-]{1,40}\/[A-Za-z0-9_-]{1,40}$/;
export const branchFor = (computer: string, taskId: string) => `girru/${computer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'computer'}/${taskId.slice(0, 40)}`;

// ---- on the computer that runs the task ----

/** The project folder when the task starts (null: not a git folder, or git could start a program there). */
export async function startSnapshot(folder: string): Promise<string | null> {
  try { const s = await snapshotState(folder); return s && s !== 'blocked' ? s : null; } catch { return null; }
}

/** After the task: the work as a patch, pushed as this computer's branch when the project has a GitHub remote. */
export async function finishWork(input: { folder: string; start: string; computer: string; taskId: string; title: string }): Promise<{ result: WorkResult; patch: string }> {
  const end = await startSnapshot(input.folder);
  if (!end) return { result: { taskId: input.taskId, mode: 'none', files: [] }, patch: '' };
  let diff;
  try { diff = await checkpointPatch(input.start, end, DIRECT_MAX_BYTES); }
  catch { return { result: { taskId: input.taskId, mode: 'too_large', files: [] }, patch: '' }; }
  if (!diff.files.length) return { result: { taskId: input.taskId, mode: 'none', files: [] }, patch: '' };
  const branch = branchFor(input.computer, input.taskId);
  if (!diff.rel) {
    const pushed = await pushBranch(diff.top, diff.patch, branch, input.title).catch(() => null);
    if (pushed) return { result: { taskId: input.taskId, mode: 'github', branch, base: pushed.base, files: diff.files }, patch: '' };
  }
  const size = Buffer.byteLength(diff.patch);
  if (size > DIRECT_MAX_BYTES) return { result: { taskId: input.taskId, mode: 'too_large', files: diff.files }, patch: '' };
  return { result: { taskId: input.taskId, mode: 'direct', files: diff.files, size, sha256: createHash('sha256').update(diff.patch).digest('hex'), parts: Math.max(1, Math.ceil(diff.patch.length / PART_CHARS)) }, patch: diff.patch };
}

/** Commits the patch on top of HEAD without touching the working folder, then pushes it as a new branch to origin on GitHub. */
async function pushBranch(top: string, patch: string, branch: string, title: string): Promise<{ base: string } | null> {
  if (!BRANCH.test(branch)) return null;
  const remote = (await git(top, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
  // Tests stand a local bare repository in for GitHub; real use needs a GitHub origin.
  const testRemote = process.env.NODE_ENV === 'test' && process.env.GIRRU_TEST_GITHUB_REMOTE === remote;
  if (!testRemote && !/^(https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/.test(remote)) return null;
  const name = (await git(top, ['config', 'user.name'], { user: true }).catch(() => '')).trim();
  if (!name) return null;
  const base = (await git(top, ['rev-parse', 'HEAD'])).trim();
  const dir = mkdtempSync(path.join(tmpdir(), 'girru-work-')), index = path.join(dir, 'index'), file = path.join(dir, 'work.patch');
  try {
    writeFileSync(file, patch, { mode: 0o600 });
    await git(top, ['read-tree', base], { index });
    await git(top, ['apply', '--cached', '--binary', file], { index });
    const tree = (await git(top, ['write-tree'], { index })).trim();
    const commit = (await git(top, ['commit-tree', tree, '-p', base, '-m', title.replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 120) || 'Work from another computer'], { user: true })).trim();
    await git(top, ['push', 'origin', `${commit}:refs/heads/${branch}`], { user: true, timeout: 90_000 });
    return { base };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export const patchParts = (patch: string) => Array.from({ length: Math.max(1, Math.ceil(patch.length / PART_CHARS)) }, (_, i) => patch.slice(i * PART_CHARS, (i + 1) * PART_CHARS));

// ---- on the computer that sent the task ----

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const dirOf = (dataDir: string, taskId: string) => { if (!ID.test(taskId)) throw Error('computer_result_invalid'); return path.join(dataDir, 'computer-results', taskId); };
export function saveResult(dataDir: string, result: WorkResult, from: string) { const d = dirOf(dataDir, result.taskId); mkdirSync(d, { recursive: true, mode: 0o700 }); writeFileSync(path.join(d, 'result.json'), JSON.stringify({ ...result, from, receivedAt: Date.now(), state: 'ready' }), { mode: 0o600 }); }
export function savePart(dataDir: string, taskId: string, index: number, text: string) { const d = dirOf(dataDir, taskId); mkdirSync(d, { recursive: true, mode: 0o700 }); writeFileSync(path.join(d, `part-${index}`), text, { mode: 0o600 }); }
export function readResult(dataDir: string, taskId: string): (WorkResult & { from: string; state: string; receivedAt: number }) | null { try { return JSON.parse(readFileSync(path.join(dirOf(dataDir, taskId), 'result.json'), 'utf8')); } catch { return null; } }
export function markResult(dataDir: string, taskId: string, state: 'brought' | 'ready') { const r = readResult(dataDir, taskId); if (r) writeFileSync(path.join(dirOf(dataDir, taskId), 'result.json'), JSON.stringify({ ...r, state }), { mode: 0o600 }); }
/** The direct patch, whole and unchanged (every part present, the size and hash as the other computer said). */
export function directPatch(dataDir: string, r: WorkResult): string {
  const d = dirOf(dataDir, r.taskId);
  const parts = Array.from({ length: r.parts ?? 0 }, (_, i) => { const f = path.join(d, `part-${i}`); if (!existsSync(f)) throw Error('computer_result_incomplete'); return readFileSync(f, 'utf8'); });
  const patch = parts.join('');
  if (Buffer.byteLength(patch) !== r.size || createHash('sha256').update(patch).digest('hex') !== r.sha256) throw Error('computer_result_changed');
  return patch;
}
/** The GitHub branch's work against the base it started from (fetched, not merged). */
export async function githubPatch(folder: string, r: WorkResult): Promise<string> {
  if (!r.branch || !BRANCH.test(r.branch) || !/^[a-f0-9]{40}$/.test(r.base ?? '')) throw Error('computer_result_invalid');
  const top = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
  await git(top, ['fetch', '--no-tags', 'origin', `refs/heads/${r.branch}`], { user: true, timeout: 90_000 });
  return git(top, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', r.base!, 'FETCH_HEAD']);
}
/** Bring into: apply the work to the project folder (not committed: the owner reviews and saves it as usual). */
export async function bringInto(folder: string, patch: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  const top = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
  const dir = mkdtempSync(path.join(tmpdir(), 'girru-bring-')), file = path.join(dir, `${randomUUID()}.patch`);
  try {
    writeFileSync(file, patch, { mode: 0o600 });
    try { await git(top, ['apply', '--check', '--binary', file]); await git(top, ['apply', '--binary', file]); return { ok: true }; }
    catch {
      try { await git(top, ['apply', '--3way', '--binary', file], { user: true }); return { ok: true }; }
      catch (e) { const text = String((e as { stderr?: string }).stderr ?? ''); return { ok: false, conflicts: [...new Set([...text.matchAll(/(?:patch failed|conflict[s]? in|U)\s*:?\s*([^\s:]+)/gi)].map(m => m[1]))].slice(0, 20) }; }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
