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
export interface WorkResult { taskId: string; mode: WorkMode; branch?: string; base?: string; commit?: string; files: ResultFile[]; size?: number; sha256?: string; parts?: number }

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
  // Nothing leaves this computer when the work touches a file that looks like a secret.
  if (diff.files.some(f => secretPath(f.path))) return { result: { taskId: input.taskId, mode: 'none', files: [] }, patch: '' };
  const branch = branchFor(input.computer, input.taskId);
  if (!diff.rel) {
    const pushed = await pushBranch(diff.top, diff.patch, branch, input.title).catch(() => null);
    if (pushed) return { result: { taskId: input.taskId, mode: 'github', branch, base: pushed.base, commit: pushed.commit, files: diff.files }, patch: '' };
  }
  const size = Buffer.byteLength(diff.patch);
  if (size > DIRECT_MAX_BYTES) return { result: { taskId: input.taskId, mode: 'too_large', files: diff.files }, patch: '' };
  return { result: { taskId: input.taskId, mode: 'direct', files: diff.files, size, sha256: createHash('sha256').update(diff.patch).digest('hex'), parts: Math.max(1, Math.ceil(diff.patch.length / PART_CHARS)) }, patch: diff.patch };
}

/** Commits the patch on top of HEAD without touching the working folder, then pushes it as a new branch to origin on GitHub. */
async function pushBranch(top: string, patch: string, branch: string, title: string): Promise<{ base: string; commit: string } | null> {
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
    return { base, commit };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Names that hold keys and secrets; the work is never sent when it touches one. */
const SECRET_NAME = /^\.env(?:\.|$)|^\.envrc$|^\.dev\.vars$|\.(?:pem|key|p12|pfx|jks|keystore|tfstate|tfvars)$|^id_(?:rsa|ed25519|ecdsa|dsa)|^credentials|^(?:secrets\.env|\.credentials\.json|\.npmrc|\.netrc|\.git-credentials|\.pgpass|auth\.json|service-account.*\.json|.*-credentials\.json)$/i;
export const secretPath = (p: string) => p.split('/').some(n => SECRET_NAME.test(n));
/** A path segment that macOS or Windows could read as something else: .git with trailing dots/spaces, an 8.3 short name, a trailing dot or space, invisible characters. */
export const confusingSegment = (n: string) => /^\.git[\s.]*$/i.test(n) || /^git~\d+$/i.test(n) || /[. ]$/.test(n) || /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/.test(n);
/** For any line of a patch header that is not one git writes for a plain change, refuse rather than guess. */

export const patchParts = (patch: string) => Array.from({ length: Math.max(1, Math.ceil(patch.length / PART_CHARS)) }, (_, i) => patch.slice(i * PART_CHARS, (i + 1) * PART_CHARS));

// ---- on the computer that sent the task ----

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const dirOf = (dataDir: string, taskId: string) => { if (!ID.test(taskId)) throw Error('computer_result_invalid'); return path.join(dataDir, 'computer-results', taskId); };
export function saveResult(dataDir: string, result: WorkResult, from: string) { const d = dirOf(dataDir, result.taskId); if (existsSync(path.join(d, 'result.json'))) throw Error('computer_result_exists'); mkdirSync(d, { recursive: true, mode: 0o700 }); writeFileSync(path.join(d, 'result.json'), JSON.stringify({ ...result, from, receivedAt: Date.now(), state: 'ready' }), { mode: 0o600 }); }
export function savePart(dataDir: string, taskId: string, index: number, text: string) { const d = dirOf(dataDir, taskId); if (existsSync(path.join(d, 'result.json'))) throw Error('computer_result_exists'); mkdirSync(d, { recursive: true, mode: 0o700 }); writeFileSync(path.join(d, `part-${index}`), text, { mode: 0o600 }); }
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
  if (!r.branch || !BRANCH.test(r.branch) || !/^[a-f0-9]{40}$/.test(r.base ?? '') || !/^[a-f0-9]{40}$/.test(r.commit ?? '')) throw Error('computer_result_invalid');
  const top = (await git(folder, ['rev-parse', '--show-toplevel'])).trim();
  await git(top, ['fetch', '--no-tags', 'origin', `refs/heads/${r.branch}`], { user: true, timeout: 90_000 });
  // Exactly the commit the other computer pushed: a branch moved since then is refused.
  if ((await git(top, ['rev-parse', 'FETCH_HEAD'])).trim() !== r.commit) throw Error('computer_result_changed');
  return git(top, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index', r.base!, r.commit!]);
}
/**
 * What a patch really changes, read from the patch itself (not from what the other computer said),
 * and the paths that need the owner's extra look: links, git internals, CI and automation files.
 */
export async function inspectPatch(patch: string): Promise<{ files: string[]; blocked: string[]; risky: string[] }> {
  // Read from the patch's own headers: every entry's old and new names, and every final file mode.
  const files = new Set<string>(), blocked = new Set<string>(), risky = new Set<string>();
  const unquote = (p: string) => { const t = p.trim(); if (!t.startsWith('"')) return t; blocked.add(t); return t.slice(1, -1); };
  const strip = (p: string) => unquote(p).replace(/^[ab]\//, '');
  let entry: string[] = [];
  const close = () => { for (const n of entry) files.add(n); entry = []; };
  for (const line of patch.split('\n')) {
    let m: RegExpExecArray | null;
    if (line.startsWith('diff --git ')) { close(); m = /^diff --git (\S+|"[^"]*") (\S+|"[^"]*")$/.exec(line); if (!m) { blocked.add(line.slice(11, 200)); continue; } entry.push(strip(m[1]), strip(m[2])); }
    else if ((m = /^(?:rename|copy) (?:from|to) (.+)$/.exec(line))) entry.push(unquote(m[1]));
    else if (/^\s*(?:old mode|new mode|new file mode|deleted file mode|mode change|index )/.test(line) && !/^index [0-9a-f]+\.\.[0-9a-f]+$/.test(line)) {
      // Read the way git reads it (spaces, any length); a line git might read differently blocks the entry.
      m = /^(?:old mode|new mode|new file mode|deleted file mode)\s+([0-7]+)\s*$/.exec(line) ?? /^mode change\s+[0-7]+\s*=>\s*([0-7]+)\s*$/.exec(line) ?? /^index [0-9a-f]+\.\.[0-9a-f]+\s+([0-7]+)\s*$/.exec(line);
      if (!m) { entry.forEach(n => blocked.add(n)); continue; }
      // Any link or submodule mode, old or new, blocks the entry; a runnable mode needs the second press.
      const mode = m[1].replace(/^0+(?=\d{6})/, ''), names = [...entry];
      if (mode === '120000' || mode === '160000') names.forEach(n => blocked.add(n));
      else if (mode === '100755') names.forEach(n => risky.add(n));
      else if (mode !== '100644') names.forEach(n => blocked.add(n));
    }
  }
  close();
  for (const f of files) {
    // Case-insensitive, as macOS and Windows file systems are.
    if (f.toLowerCase().split('/').includes('.git') || f.split('/').some(confusingSegment) || f.startsWith('/') || f.includes('\\') || f.split('/').includes('..') || secretPath(f)) blocked.add(f);
    if (RISKY.test(f)) risky.add(f);
  }
  // git's own reading must agree with ours (no entry git sees that we did not).
  const dir = mkdtempSync(path.join(tmpdir(), 'girru-look-')), file = path.join(dir, 'work.patch');
  try {
    writeFileSync(file, patch, { mode: 0o600 });
    const numstat = await git(dir, ['apply', '--numstat', '-z', file]);
    for (const r of numstat.split('\u0000')) { const p = /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/.exec(r)?.[1]; if (p && !files.has(p)) blocked.add(p); }
    // And git's own summary of modes: a link, a submodule or any unusual mode it reports is blocked.
    const summary = await git(dir, ['apply', '--summary', file]);
    for (const m of summary.matchAll(/mode (\d+) (.+)$/gm)) { const f = m[2].trim().replace(/ \(\d+%\)$/, ''); if (m[1] === '100755') risky.add(f); else if (m[1] !== '100644') blocked.add(f); }
    for (const m of summary.matchAll(/mode change (\d+) => (\d+) (.+)$/gm)) { const f = m[3].trim(); if (m[2] === '100755') risky.add(f); else if (m[2] !== '100644') blocked.add(f); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return { files: [...files], blocked: [...blocked], risky: [...risky].filter(f => !blocked.has(f)) };
}
/** Files that run programs or change how the project is built or checked, at any folder depth. */
const RISKY = /(?:^|\/)(?:\.github|\.gitlab|\.circleci|\.husky|\.githooks|\.devcontainer|\.buildkite)\/|(?:^|\/)\.vscode\/(?:tasks|launch|settings)\.json$|(?:^|\/)(?:package\.json|Makefile|makefile|GNUmakefile|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|\.gitlab-ci\.yml|Jenkinsfile|\.pre-commit-config\.yaml|setup\.py|setup\.cfg|pyproject\.toml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|pom\.xml|Cargo\.toml|build\.rs|\.npmrc|\.yarnrc(?:\.yml)?|\.envrc|justfile|Taskfile\.ya?ml|(?:vite|webpack|rollup|babel|jest|vitest|eslint)\.config\.[cm]?[jt]s|\.gitattributes|\.gitmodules)$/i;

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

// ---- CP10a: the project on this computer ----

const GITHUB_URL = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}?(?:\.git)?$/;
/** Clone a GitHub project into a new folder inside `parent` (the owner chose both); the folder must not exist yet. */
export async function cloneFromGithub(url: string, parent: string): Promise<{ folder: string; name: string }> {
  if (!GITHUB_URL.test(url)) throw Error('computer_project_url_invalid');
  if (!path.isAbsolute(parent) || !existsSync(parent)) throw Error('computer_project_folder_invalid');
  const name = url.replace(/\.git$/, '').split('/').pop()!.replace(/[^A-Za-z0-9_.-]/g, '-');
  if (!name || name === '.' || name === '..') throw Error('computer_project_url_invalid');
  const folder = path.join(parent, name);
  if (existsSync(folder)) throw Error('computer_project_folder_exists');
  await git(parent, ['clone', '--no-recurse-submodules', url, folder], { user: true, timeout: 600_000 });
  return { folder, name };
}
