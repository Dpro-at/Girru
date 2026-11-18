import {assertMemoryFilesystemAccess,assertProtectedMemoryFileDescriptor,closeProtectedMemoryFileDescriptor} from '../../memory/encryption/protected-filesystem.js';
/**
 * File-tool sandbox (S1.6).
 *
 * Every agent gets its own workspace directory `.data/workspaces/<agentId>/`
 * (created on demand, mode 0700). The `read` and `write` tools only ever
 * touch files inside a root:
 *
 *  - write: always the agent's own workspace (Q-17: no write outside it, no
 *    approval path).
 *  - read:  the agent's own workspace, or an explicit read root put in the
 *    tool context by trusted server code (e.g. the owner-chosen directory of
 *    a small-agent run, MCP-01b). Never taken from model input.
 *
 * Checks (all of them, in this order):
 *  1. the path is a non-empty string without NUL or control characters;
 *  2. lexical containment: `path.relative(root, target)` must not start with
 *     `..` and must not be absolute (separator-aware, so `/work-evil` is not
 *     inside `/work`);
 *  3. the always-deny list (`.env*`, `*.env` incl. `secrets.env`,
 *     `.data/encryption/**`, `*.db*`, `.git/**`, SSH keys, `credentials*`,
 *     `auth.json`, `instance.json`), on the path relative to the root and
 *     again on the resolved real path, so a wider root never exposes them;
 *     on the real path also everything under the backend data folder
 *     (`.data/`) except the `.data/workspaces/` subtree;
 *  4. realpath containment: the real path of the file (read) or of its
 *     parent directory (write) must still be inside the real root, so a
 *     symlink pointing outside is refused;
 *  5. files are opened with O_NOFOLLOW and must be regular files; size limits.
 */

import { dataPath, dataRoot, protectedDataDirs, realish } from '../../config/data-root.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_READ_BYTES = 1024 * 1024; // 1 MiB
export const MAX_WRITE_BYTES = 1024 * 1024; // 1 MiB
const MAX_PATH_CHARS = 1024;

export class FileSandboxError extends Error {
  constructor(message: string, readonly code: 'invalid_path' | 'outside_workspace' | 'denied' | 'not_found' | 'not_a_file' | 'too_large') {
    super(message);
  }
}

/** Directory that holds all agent workspaces. */
export function workspacesBaseDir(): string {
  return dataPath('workspaces');
}

/** Directory name of an agent's workspace (safe characters only). */
export function workspaceDirName(agentId: string | undefined | null): string {
  const id = (agentId ?? '').trim();
  if (!id) return '_default';
  if (/^[A-Za-z0-9_-]{1,64}$/.test(id) && id !== '_default') return id;
  return `h-${createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
}

/** Path of an agent's workspace (not created). */
export function agentWorkspacePath(agentId: string | undefined | null): string {
  return path.join(workspacesBaseDir(), workspaceDirName(agentId));
}

/** Create (if needed) and return the real path of an agent's workspace (mode 0700). */
export function ensureAgentWorkspace(agentId: string | undefined | null): string {
  const dir = agentWorkspacePath(agentId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new FileSandboxError('agent workspace is not a directory', 'invalid_path');
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort (e.g. Windows) */ }
  return realPath(dir);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function validatePathInput(p: unknown): string {
  if (typeof p !== 'string' || !p.trim()) throw new FileSandboxError('path is required', 'invalid_path');
  if (p.length > MAX_PATH_CHARS) throw new FileSandboxError('path is too long', 'invalid_path');
  if (CONTROL_CHARS.test(p)) throw new FileSandboxError('path contains NUL or control characters', 'invalid_path');
  return p;
}

/** True on file systems that are case-insensitive by default (macOS APFS/HFS+, Windows NTFS). */
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Real path with the on-disk letter case (`fs.realpathSync.native`; the JS
 * `fs.realpathSync` keeps the caller's case on case-insensitive volumes, so
 * `~/.SSH` would not match `~/.ssh`). Throws when the path does not exist.
 */
export function realPath(p: string): string {
  return fs.realpathSync.native(path.resolve(p));
}

/** realPath, or the resolved path when it does not exist. */
export function canonicalPath(p: string): string {
  try { return realPath(p); } catch { return path.resolve(p); }
}

function relInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep)[0] !== '..';
}

/**
 * Separator-aware containment: true when `target` is `root` or inside it.
 * Exact comparison: use it on canonical paths (realPath) for "allowed"
 * decisions, so two different folders on a case-sensitive volume never merge.
 */
export function isInside(root: string, target: string): boolean {
  return relInside(root, target);
}

/**
 * Like isInside, but case-insensitive on darwin/win32. Use it for "denied"
 * decisions (protected trees), so a different spelling of a protected folder
 * (e.g. `~/.SSH`, `.DATA`) is still caught.
 */
export function isInsideIgnoringCase(root: string, target: string): boolean {
  if (!CASE_INSENSITIVE_FS) return relInside(root, target);
  return relInside(root.toLowerCase(), target.toLowerCase());
}

const SSH_KEY_NAME = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?(\.pub)?$/i;
const DB_NAME = /\.(db|sqlite3?)($|[-.])/i;
const KEY_FILE = /\.(pem|key|p12|pfx|ppk)$/i;
/** CLI token (auth.json), backend instance secret (instance.json) and similar. */
const SECRET_FILE_NAMES: ReadonlySet<string> = new Set(['auth.json', 'instance.json', 'secrets.env', '.netrc', '.npmrc', '.git-credentials', '.pgpass', '.credentials.json', 'studio-connection.json']);

/** `.env`, `.env.local`, `secrets.env`, `prod.env`, ... */
function isEnvFileName(name: string): boolean {
  const lc = name.toLowerCase();
  return lc.startsWith('.env') || lc.endsWith('.env');
}

/** Backend data folder (the data root, else `<cwd>/.data`), on-disk case. */
export function backendDataDir(): string {
  return canonicalPath(dataRoot());
}

/**
 * True when an absolute path is inside a private data folder
 * (protectedDataDirs(): the data root, `<cwd>/.data`, the DB folder,
 * uploads, ...) but not in the agent `workspaces/` subtree.
 * Case-insensitive on darwin/win32.
 */
export function isProtectedDataPath(absolute: string): boolean {
  // Every private data folder (shared list, same as exec-policy), compared
  // after resolving symlinks on both sides, also for a path not created yet.
  const targets = [...new Set([path.resolve(absolute), realish(absolute)])];
  const workspaces = [...new Set([path.resolve(workspacesBaseDir()), realish(workspacesBaseDir())])];
  const dirs = protectedDataDirs();
  return targets.some((t) => dirs.some((d) => isInsideIgnoringCase(d, t))
    && !workspaces.some((w) => isInsideIgnoringCase(w, t)));
}

/** Reason a path (as components) is on the always-deny list, or null. */
function denyReasonForComponents(parts: string[]): string | null {
  for (let i = 0; i < parts.length; i++) {
    const c = parts[i];
    const lc = c.toLowerCase();
    if (lc.startsWith('.env') || (i === parts.length - 1 && lc.endsWith('.env'))) return 'environment files are never readable or writable by agents';
    if (lc === '.git') return 'git internals are off limits';
    if (lc === '.ssh') return 'SSH keys are off limits';
    if (lc === '.data' && parts[i + 1]?.toLowerCase() === 'encryption') return 'encryption keys are off limits';
    if (lc.startsWith('credentials')) return 'credential files are off limits';
  }
  const base = parts[parts.length - 1] ?? '';
  if (DB_NAME.test(base)) return 'database files are off limits';
  if (SSH_KEY_NAME.test(base) || base.toLowerCase() === 'authorized_keys') return 'SSH keys are off limits';
  if (KEY_FILE.test(base)) return 'key files are off limits';
  if (SECRET_FILE_NAMES.has(base.toLowerCase())) return 'token and instance-secret files are off limits';
  return null;
}

/** Deny-list check on a path relative to the root and on the absolute real path. */
export function denyReason(relFromRoot: string, absolute?: string): string | null {
  if(absolute)try{assertMemoryFilesystemAccess(absolute);}catch{return 'native-owned memory and control files are off limits';}
  const relParts = relFromRoot.split(/[\\/]+/).filter(Boolean);
  const r = denyReasonForComponents(relParts);
  if (r) return r;
  if (absolute) {
    // On the absolute path only the structural rules apply (a parent folder
    // named "credentials" outside the root is not the agent's business).
    const parts = absolute.split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const lc = parts[i].toLowerCase();
      if (lc === '.git' || lc === '.ssh') return 'this location is off limits';
      if (lc === '.data' && parts[i + 1]?.toLowerCase() === 'encryption') return 'encryption keys are off limits';
    }
    if (isProtectedDataPath(absolute)) return 'the backend data folder is off limits (only agent workspaces are allowed)';
    const base = parts[parts.length - 1] ?? '';
    if (isEnvFileName(base) || DB_NAME.test(base) || SSH_KEY_NAME.test(base) || KEY_FILE.test(base) || SECRET_FILE_NAMES.has(base.toLowerCase())) return 'this file is off limits';
  }
  return null;
}

function realRootOf(root: string): string {
  try {
    return realPath(root);
  } catch {
    throw new FileSandboxError('workspace does not exist', 'not_found');
  }
}

function lexicalTarget(realRoot: string, input: string): { target: string; rel: string } {
  const target = path.resolve(realRoot, input);
  if (!isInside(realRoot, target)) throw new FileSandboxError(`Path "${input}" is outside the workspace`, 'outside_workspace');
  const rel = path.relative(realRoot, target);
  const deny = denyReason(rel);
  if (deny) throw new FileSandboxError(`Access denied: ${deny}`, 'denied');
  return { target, rel };
}

/** Resolve a path for reading: real path, inside the root, not denied. */
export function resolveReadPath(root: string, input: unknown): { real: string; rel: string } {
  const p = validatePathInput(input);
  const realRoot = realRootOf(root);
  const { target } = lexicalTarget(realRoot, p);
  let real: string;
  try {
    real = realPath(target);
  } catch {
    throw new FileSandboxError(`File not found: ${p}`, 'not_found');
  }
  if (!isInside(realRoot, real)) throw new FileSandboxError(`Path "${p}" points outside the workspace`, 'outside_workspace');
  const rel = path.relative(realRoot, real);
  const deny = denyReason(rel, real);
  if (deny) throw new FileSandboxError(`Access denied: ${deny}`, 'denied');
  return { real, rel };
}

/** Biggest file the read tool scans for a part or a search (CHAT-LIVE-01). */
export const MAX_SCAN_BYTES = 32 * 1024 * 1024;

/**
 * Text of an already-resolved real path (from resolveReadPath, or a plain
 * file found by walking a resolved folder without following links): regular
 * file, no symlink at the last step, at most MAX_SCAN_BYTES, not binary.
 */
export function sandboxedReadText(real: string, maxBytes = MAX_SCAN_BYTES): string {
  assertMemoryFilesystemAccess(real);
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    assertProtectedMemoryFileDescriptor(fd);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new FileSandboxError('Not a regular file', 'not_a_file');
    if (st.size > maxBytes) throw new FileSandboxError(`File is too large to read (${st.size} bytes, max ${maxBytes})`, 'too_large');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = fs.readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; }
    if (buf.subarray(0, Math.min(off, 8192)).includes(0)) throw new FileSandboxError('Not a text file', 'not_a_file');
    return buf.subarray(0, off).toString('utf-8');
  } finally {
    closeProtectedMemoryFileDescriptor(fd,()=>fs.closeSync(fd));
  }
}

/** Read a file inside the root (regular file, size-limited, no symlink at the last step). */
export function sandboxedReadFile(root: string, input: unknown, maxBytes = MAX_READ_BYTES): { content: string; rel: string; size: number; modified: Date } {
  const { real, rel } = resolveReadPath(root, input);
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    assertProtectedMemoryFileDescriptor(fd);
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new FileSandboxError('Not a regular file', 'not_a_file');
    if (st.size > maxBytes) throw new FileSandboxError(`File is too large (${st.size} bytes, max ${maxBytes})`, 'too_large');
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { content: buf.subarray(0, off).toString('utf-8'), rel, size: off, modified: st.mtime };
  } finally {
    closeProtectedMemoryFileDescriptor(fd,()=>fs.closeSync(fd));
  }
}

/**
 * Write a file inside the root. Parent directories are created one by one
 * (0700) and each existing one is checked with realpath, so a symlinked
 * directory cannot lead outside. An existing symlink at the target is refused.
 */
export function sandboxedWriteFile(root: string, input: unknown, content: unknown, maxBytes = MAX_WRITE_BYTES): { rel: string; size: number; modified: Date } {
  const p = validatePathInput(input);
  if (typeof content !== 'string') throw new FileSandboxError('content must be a string', 'invalid_path');
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > maxBytes) throw new FileSandboxError(`Content is too large (${bytes} bytes, max ${maxBytes})`, 'too_large');
  const realRoot = realRootOf(root);
  const { target, rel } = lexicalTarget(realRoot, p);
  if (target === realRoot) throw new FileSandboxError('Cannot write to the workspace directory itself', 'not_a_file');

  // Walk the parent chain from the root, creating missing directories.
  const parentRel = path.relative(realRoot, path.dirname(target));
  let current = realRoot;
  for (const part of parentRel ? parentRel.split(path.sep) : []) {
    const next = path.join(current, part);
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(next); } catch { st = null; }
    if (!st) {
      fs.mkdirSync(next, { mode: 0o700 });
    } else if (st.isSymbolicLink()) {
      const real = realPath(next);
      if (!isInside(realRoot, real)) throw new FileSandboxError(`Path "${p}" points outside the workspace`, 'outside_workspace');
      if (!fs.statSync(real).isDirectory()) throw new FileSandboxError('A parent path is not a directory', 'not_a_file');
    } else if (!st.isDirectory()) {
      throw new FileSandboxError('A parent path is not a directory', 'not_a_file');
    }
    current = realPath(next);
    if (!isInside(realRoot, current)) throw new FileSandboxError(`Path "${p}" points outside the workspace`, 'outside_workspace');
  }
  const finalPath = path.join(current, path.basename(target));
  const deny = denyReason(path.relative(realRoot, finalPath), finalPath);
  if (deny) throw new FileSandboxError(`Access denied: ${deny}`, 'denied');

  let existing: fs.Stats | null = null;
  try { existing = fs.lstatSync(finalPath); } catch { existing = null; }
  if (existing?.isSymbolicLink()) throw new FileSandboxError('Refusing to write through a symbolic link', 'denied');
  if (existing && !existing.isFile()) throw new FileSandboxError('Not a regular file', 'not_a_file');

  assertMemoryFilesystemAccess(finalPath);
  const fd = fs.openSync(finalPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    assertProtectedMemoryFileDescriptor(fd);fs.ftruncateSync(fd,0);
    fs.writeSync(fd, content, 0, 'utf-8');
    const st = fs.fstatSync(fd);
    return { rel, size: st.size, modified: st.mtime };
  } finally {
    closeProtectedMemoryFileDescriptor(fd,()=>fs.closeSync(fd));
  }
}

/**
 * Root the `read` tool uses for this context: an explicit read root set by
 * server code, otherwise the agent's own workspace (created on demand).
 */
export function readRootFor(context: { agentId?: string; fileReadRoot?: string } | undefined): string {
  if (context?.fileReadRoot) return context.fileReadRoot;
  return ensureAgentWorkspace(context?.agentId);
}

/** Root the `write` tool uses: always the agent's own workspace. */
export function writeRootFor(context: { agentId?: string } | undefined): string {
  return ensureAgentWorkspace(context?.agentId);
}
