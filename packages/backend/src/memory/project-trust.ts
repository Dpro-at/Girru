/**
 * Outside projects (REPO-TRUST-01).
 *
 * A project made in Girru is trusted at once. A folder that was cloned or
 * downloaded and whose git remote belongs to someone else is OUTSIDE: it goes
 * on the owner's "Outside projects" list, and the guards treat its files as
 * someone else's (memory/docs recall ranks them lower and labels them, nothing
 * from it becomes a rule or a pinned fact, the coding apps' memory (MCP) is
 * off for it, tasks from its task file wait for the owner once).
 *
 * How a folder is judged (own code, no git command):
 *   - its `.git` (a folder, or a file `gitdir: …` for a worktree) is found in
 *     the project's main folder, read through the real path, no links, small
 *     size cap; `config` is parsed for `[remote "<name>"] url = …`
 *   - the remote judged is `origin`, else the first one; its owner is the
 *     whole namespace before the repository name (github.com/<owner>/repo,
 *     git@host:<owner>/repo, gitlab.com/<group>/<sub>/repo); local paths and
 *     file:// remotes are the owner's own
 *   - owners counted as the owner's own: BUILT_IN (9mtm and Dpro-at on
 *     github.com) plus the ones he adds (project_trust_owners, github.com
 *     unless he names another host); host and namespace must match exactly
 *     (any letter case)
 *   - no `.git`, no remote, or an own owner → trusted
 * The owner's own choice (put on the list / take off it) is kept until he
 * changes it; an automatic verdict is checked again when the folder's git
 * config changes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { all, one, run, sql, type Step } from '../repositories/sql-steps.js';
import { readRegularFile } from '../services/read-regular-file.js';
import { repoTrustEnabled } from '../services/repo-trust-switch.js';

/** The owner's own accounts, pinned to their host (a same-named account elsewhere is someone else). */
export const BUILT_IN_OWNERS: ReadonlyArray<{ name: string; host: string }> = Object.freeze([{ name: '9mtm', host: 'github.com' }, { name: 'Dpro-at', host: 'github.com' }]);
const MAX_GIT_CONFIG = 256 * 1024;

export class ProjectTrustError extends Error {
  constructor(readonly status: 400 | 404, readonly code: string) { super(code); }
}

export interface GitRemote { name: string; url: string }
export interface RemoteOwner { host: string; owner: string }

/** `[remote "x"] url = …` entries of a git config text. */
export function parseGitRemotes(config: string): GitRemote[] {
  const out: GitRemote[] = [];
  let remote: string | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]$/.exec(line);
    if (section) { remote = section[1].toLowerCase() === 'remote' && section[2] !== undefined ? section[2] : null; continue; }
    if (remote === null) continue;
    const kv = /^url\s*=\s*(.+)$/i.exec(line);
    if (kv) out.push({ name: remote, url: kv[1].trim().replace(/^"(.*)"$/, '$1') });
  }
  return out;
}

/** Host and owner of a remote URL; null for a local path (the owner's own). */
export function remoteOwner(url: string): RemoteOwner | null {
  const u = url.trim();
  if (!u || u.startsWith('/') || u.startsWith('.') || /^file:/i.test(u) || /^[A-Za-z]:[\\/]/.test(u)) return null;
  // scp-like: [user@]host:owner/repo
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(\S+)$/.exec(u);
  if (scp) {
    const parts = scp[2].split('/').filter(Boolean);
    return parts.length >= 2 ? { host: scp[1].toLowerCase(), owner: parts.slice(0, -1).join('/') } : null;
  }
  try {
    const p = new URL(u);
    if (!/^(https?|ssh|git|git\+ssh|ssh\+git):$/i.test(p.protocol)) return null;
    const parts = p.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x));
    // The owner is the whole namespace before the repository name (nested groups included), compared exactly.
    if (parts.length < 2) return null;
    return { host: p.hostname.toLowerCase(), owner: parts.slice(0, -1).join('/') };
  } catch { return null; }
}

/** The git config of a folder (a `.git` folder, or a worktree's `.git` file pointing at its gitdir), or null. */
export async function readGitConfig(folder: string): Promise<{ text: string; mtimeMs: number } | null> {
  let root: string;
  try { root = await fs.realpath(folder); } catch { return null; }
  const dotGit = path.join(root, '.git');
  let st: import('node:fs').Stats;
  try { st = await fs.lstat(dotGit); } catch { return null; }
  if (st.isSymbolicLink()) return null;
  let gitDir: string | null = null;
  let commonDir: string | null = null;
  if (st.isDirectory()) gitDir = dotGit;
  else if (st.isFile()) {
    try {
      const r = await readRegularFile(dotGit, 4096, { root });
      const m = /^gitdir:\s*(.+)\s*$/m.exec(Buffer.from(r.data).toString('utf8'));
      if (m) gitDir = path.resolve(root, m[1].trim());
    } catch { return null; }
  }
  if (!gitDir) return null;
  // A linked worktree keeps its config in the main repository (commondir).
  try {
    const r = await readRegularFile(path.join(gitDir, 'commondir'), 4096);
    commonDir = path.resolve(gitDir, Buffer.from(r.data).toString('utf8').trim());
  } catch { /* not a linked worktree */ }
  for (const dir of [gitDir, commonDir].filter((x): x is string => !!x)) {
    try {
      const file = path.join(await fs.realpath(dir), 'config');
      const r = await readRegularFile(file, MAX_GIT_CONFIG, { truncate: true });
      return { text: Buffer.from(r.data).toString('utf8'), mtimeMs: Math.floor(r.stat.mtimeMs) };
    } catch { /* try the next */ }
  }
  return null;
}

/** The remote that decides: origin, else the first one. */
export function decidingRemote(remotes: GitRemote[]): GitRemote | null {
  return remotes.find((r) => r.name === 'origin') ?? remotes[0] ?? null;
}

export async function ownOwners(ownerId: string): Promise<Array<{ name: string; host: string }>> {
  const extra = await sql().read(all<{ name: string; host: string }>('SELECT name, host FROM project_trust_owners WHERE owner_id = ? ORDER BY name, host', ownerId)).catch(() => []);
  return [...BUILT_IN_OWNERS, ...extra];
}

export function isOwnOwner(r: RemoteOwner, own: ReadonlyArray<{ name: string; host: string }>): boolean {
  return own.some((o) => o.name.toLowerCase() === r.owner.toLowerCase() && o.host.toLowerCase() === r.host);
}

export interface TrustVerdict {
  projectId: string;
  outside: boolean;
  /** auto = judged from the folder; owner = the owner's own choice; none = no folder or a project made here. */
  source: 'auto' | 'owner' | 'none';
  remote: RemoteOwner | null;
  checkedAt: string | null;
}

interface Row { project_id: string; outside: number; source: 'auto' | 'owner'; remote_host: string | null; remote_owner: string | null; config_mtime: number | null; checked_at: string }

const verdictOf = (r: Row): TrustVerdict => ({
  projectId: r.project_id, outside: Number(r.outside) === 1, source: r.source,
  remote: r.remote_owner ? { host: r.remote_host ?? '', owner: r.remote_owner } : null, checkedAt: r.checked_at,
});

function* upsertStep(ownerId: string, projectId: string, v: { outside: boolean; source: 'auto' | 'owner'; remote: RemoteOwner | null; mtime: number | null }): Step<void> {
  const at = new Date().toISOString();
  const prev = yield* one<{ project_id: string }>('SELECT project_id FROM project_trust WHERE owner_id = ? AND project_id = ?', ownerId, projectId);
  if (prev) {
    yield* run(`UPDATE project_trust SET outside = ?, source = ?, remote_host = ?, remote_owner = ?, config_mtime = ?, checked_at = ? WHERE owner_id = ? AND project_id = ?`,
      v.outside ? 1 : 0, v.source, v.remote?.host ?? null, v.remote?.owner ?? null, v.mtime, at, ownerId, projectId);
  } else {
    yield* run(`INSERT INTO project_trust (owner_id, project_id, outside, source, remote_host, remote_owner, config_mtime, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ownerId, projectId, v.outside ? 1 : 0, v.source, v.remote?.host ?? null, v.remote?.owner ?? null, v.mtime, at);
  }
}

/** Judge one project's main folder now (an owner choice is never overwritten). */
export async function checkProjectTrust(ownerId: string, projectId: string): Promise<TrustVerdict> {
  const p = await sql().read(one<{ id: string; folder: string | null }>('SELECT id, folder FROM chat_projects WHERE id = ? AND user_id = ?', projectId, ownerId));
  if (!p) throw new ProjectTrustError(404, 'project_not_found');
  const row = await sql().read(one<Row>('SELECT * FROM project_trust WHERE owner_id = ? AND project_id = ?', ownerId, projectId));
  if (row?.source === 'owner') return verdictOf(row);
  if (!p.folder) return { projectId, outside: false, source: 'none', remote: null, checkedAt: null };
  const cfg = await readGitConfig(p.folder);
  if (row && cfg && row.config_mtime === cfg.mtimeMs) return verdictOf(row);
  if (row && !cfg && row.config_mtime === null) return verdictOf(row);
  const remote = cfg ? decidingRemote(parseGitRemotes(cfg.text)) : null;
  const who = remote ? remoteOwner(remote.url) : null;
  const outside = !!who && !isOwnOwner(who, await ownOwners(ownerId));
  await sql().tx(() => upsertStep(ownerId, projectId, { outside, source: 'auto', remote: who, mtime: cfg?.mtimeMs ?? null }));
  return { projectId, outside, source: 'auto', remote: who, checkedAt: new Date().toISOString() };
}

const cache = new Map<string, { at: number; outside: boolean }>();
const CACHE_MS = 30_000;

/**
 * Is this project outside? (the guards' one question). Uses the stored verdict
 * and looks at the folder again at most every 30 s; never throws (a project
 * that cannot be judged counts as the owner's own, as before this check).
 */
export async function isOutsideProject(ownerId: string, projectId: string | null | undefined): Promise<boolean> {
  if (!projectId || !repoTrustEnabled()) return false;
  const key = `${ownerId}\n${projectId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.outside;
  const v = await checkProjectTrust(ownerId, projectId).catch(() => null);
  const outside = v?.outside ?? false;
  cache.set(key, { at: Date.now(), outside });
  return outside;
}

/** The project ids of an owner that are outside (stored verdicts; a fresh check runs for projects never judged). */
export async function outsideProjectIds(ownerId: string): Promise<Set<string>> {
  const rows = await sql().read(all<{ id: string }>(`SELECT id FROM chat_projects WHERE user_id = ?`, ownerId));
  const out = new Set<string>();
  for (const r of rows) if (await isOutsideProject(ownerId, r.id)) out.add(r.id);
  return out;
}

/** Put a project on the Outside list (true) or take it off (false): the owner's choice, kept. */
export async function setProjectOutside(ownerId: string, projectId: unknown, outside: unknown): Promise<TrustVerdict> {
  if (typeof projectId !== 'string' || !projectId || typeof outside !== 'boolean') throw new ProjectTrustError(400, 'invalid_input');
  const p = await sql().read(one<{ id: string }>('SELECT id FROM chat_projects WHERE id = ? AND user_id = ?', projectId, ownerId));
  if (!p) throw new ProjectTrustError(404, 'project_not_found');
  const row = await sql().read(one<Row>('SELECT * FROM project_trust WHERE owner_id = ? AND project_id = ?', ownerId, projectId));
  const remote = row?.remote_owner ? { host: row.remote_host ?? '', owner: row.remote_owner } : null;
  await sql().tx(() => upsertStep(ownerId, projectId, { outside, source: 'owner', remote, mtime: row?.config_mtime ?? null }));
  cache.delete(`${ownerId}\n${projectId}`);
  return { projectId, outside, source: 'owner', remote, checkedAt: new Date().toISOString() };
}

/** Let the automatic check judge this project again (undo of the owner's choice). */
export async function resetProjectTrust(ownerId: string, projectId: string): Promise<TrustVerdict> {
  await sql().read(run('DELETE FROM project_trust WHERE owner_id = ? AND project_id = ?', ownerId, projectId));
  cache.delete(`${ownerId}\n${projectId}`);
  return checkProjectTrust(ownerId, projectId);
}

/** An account or group path (`org` or `group/sub`), no `..`. */
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){0,4}$/;
const HOST_NAME = /^[a-z0-9][a-z0-9.-]{0,252}$/;

/** Count a remote owner (e.g. a GitHub organisation) as the owner's own; projects judged automatically are looked at again. */
export async function addOwnOwner(ownerId: string, name: unknown, host: unknown = ''): Promise<void> {
  // No host given: github.com (an account name alone never trusts the same name on every host).
  if (typeof host === 'string' && !host.trim()) host = 'github.com';
  if (typeof name !== 'string' || !OWNER_NAME.test(name) || name.includes('..') || typeof host !== 'string' || !HOST_NAME.test(host.toLowerCase())) throw new ProjectTrustError(400, 'invalid_owner');
  const d = sql().dialect;
  await sql().read(run(`INSERT ${d === 'postgres' ? '' : 'OR IGNORE '}INTO project_trust_owners (owner_id, name, host, created_at) VALUES (?, ?, ?, ?)${d === 'postgres' ? ' ON CONFLICT DO NOTHING' : ''}`,
    ownerId, name, host.toLowerCase(), new Date().toISOString()));
  await forgetAutoVerdicts(ownerId);
}

export async function removeOwnOwner(ownerId: string, name: unknown, host: unknown = ''): Promise<void> {
  if (typeof name !== 'string' || typeof host !== 'string') throw new ProjectTrustError(400, 'invalid_owner');
  const h = host.trim() ? host.toLowerCase() : 'github.com';
  await sql().read(run('DELETE FROM project_trust_owners WHERE owner_id = ? AND name = ? AND host = ?', ownerId, name, h));
  await forgetAutoVerdicts(ownerId);
}

async function forgetAutoVerdicts(ownerId: string): Promise<void> {
  await sql().read(run(`DELETE FROM project_trust WHERE owner_id = ? AND source = 'auto'`, ownerId));
  for (const k of [...cache.keys()]) if (k.startsWith(`${ownerId}\n`)) cache.delete(k);
  folderCache.clear();
}

/** Tests: drop the in-process verdict cache. */
export function clearProjectTrustCache(): void { cache.clear(); folderCache.clear(); }

/** The Outside projects list and the owners counted as the owner's own. */
export async function projectTrustView(ownerId: string): Promise<{ projects: Array<TrustVerdict & { name: string }>; owners: Array<{ name: string; host: string; builtIn: boolean }> }> {
  const rows = await sql().read(all<{ id: string; name: string }>(`SELECT id, name FROM chat_projects WHERE user_id = ? ORDER BY LOWER(name), id`, ownerId));
  const projects: Array<TrustVerdict & { name: string }> = [];
  for (const r of rows) {
    const v = await checkProjectTrust(ownerId, r.id).catch(() => null);
    if (v) projects.push({ ...v, name: r.name });
  }
  const own = await ownOwners(ownerId);
  return { projects, owners: own.map((o, i) => ({ ...o, builtIn: i < BUILT_IN_OWNERS.length })) };
}

/**
 * Is a file someone else's? True when it lies in an outside project's folder,
 * or (not a project yet) in a git folder whose remote owner is not the
 * owner's. Used by the automatic import: such notes are never turned into
 * memories on their own.
 */
export async function outsideFile(ownerId: string, file: string): Promise<boolean> {
  if (!repoTrustEnabled()) return false;
  const projects = await sql().read(all<{ id: string; folder: string | null; extra_folders: string | null }>(
    'SELECT id, folder, extra_folders FROM chat_projects WHERE user_id = ?', ownerId)).catch(() => []);
  const inside = (folder: string) => { const rel = path.relative(folder, file); return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel); };
  for (const p of projects) {
    const folders = [p.folder, ...(() => { try { const x = JSON.parse(p.extra_folders ?? '[]'); return Array.isArray(x) ? x.map((f) => f?.path) : []; } catch { return []; } })()]
      .filter((f): f is string => typeof f === 'string');
    if (folders.some(inside)) return isOutsideProject(ownerId, p.id);
  }
  // A scan asks about many files of one folder: each folder's answer is kept for a short while.
  const start = path.dirname(file);
  const hit = folderCache.get(`${ownerId}\n${start}`);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.outside;
  const own = await ownOwners(ownerId);
  let dir = start;
  let outside = false;
  for (let i = 0; i < 16; i++) {
    const cfg = await readGitConfig(dir);
    if (cfg) {
      const remote = decidingRemote(parseGitRemotes(cfg.text));
      const who = remote ? remoteOwner(remote.url) : null;
      outside = !!who && !isOwnOwner(who, own);
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  folderCache.set(`${ownerId}\n${start}`, { at: Date.now(), outside });
  if (folderCache.size > 5000) folderCache.clear();
  return outside;
}
const folderCache = new Map<string, { at: number; outside: boolean }>();
