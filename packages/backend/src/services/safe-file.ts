/**
 * STORE-MAP-01 P7, SEC2-6: the one safe file writer for project folders. Every
 * file Girru writes into a folder it does not own (AGENTS.md, CLAUDE.md,
 * GEMINI.md, DESIGN.md, `.girru/*`, `.git/info/exclude`, `.cursor/rules/*`)
 * goes through `safeWriteFile`:
 *
 *  - only inside the folder: a relative path with no `..`, no absolute, drive or
 *    UNC part, no `\` or `:`, no Windows device names and no trailing dot or
 *    space; the whole path stays under the platform's length limit;
 *  - never through a link: every folder on the way is checked with lstat and
 *    its real path must be exactly the expected one (symlinks, Windows
 *    junctions, mount tricks); the file itself is opened without following
 *    links and must be a plain file with one name (no hard links);
 *  - no case collisions: `agents.md` is refused when `AGENTS.md` is there;
 *  - size and type: text only (UTF-8, no NUL), at most `maxBytes`;
 *  - atomic: a temp file next to the target (created exclusively, never
 *    through a link), flushed, then renamed over the target; temp files a crash
 *    left behind are removed on the next write; the folder is flushed after the
 *    rename except on Windows (it has no directory fsync);
 *  - re-checked after open: just before the rename the folder and the target
 *    must still be the same ones that were checked (same device and inode, same
 *    content hash when the caller asked for compare-and-set);
 *  - a file another program holds open on Windows is retried a few times and
 *    then reported as `locked`, never half written.
 *
 * Synchronous on purpose: the files are small, and one call is one step that no
 * other write of this process can interleave with.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { contentSha256 } from './content-hash.js';

export type SafeFileCode =
  | 'no_folder' | 'bad_path' | 'outside_folder' | 'path_too_long' | 'link' | 'not_regular'
  | 'case_collision' | 'too_large' | 'not_text' | 'changed' | 'locked';

export class SafeFileError extends Error {
  constructor(readonly code: SafeFileCode, message: string) { super(message); }
}

export interface SafeWriteOptions {
  /** Largest text allowed, in bytes (default 1 MB). */
  maxBytes?: number;
  /** File mode for a new file (default 0o644); an existing file keeps its own. */
  mode?: number;
  /** Compare-and-set: the sha256 the file must have now; null = it must not exist yet. */
  expectSha256?: string | null;
  /** Create missing folders on the way (default true). */
  createDirs?: boolean;
  /** Tests only: pretend to run on another platform. */
  platform?: NodeJS.Platform;
}
export interface SafeWriteResult { action: 'create' | 'update' | 'unchanged'; file: string; sha256: string }

export const SAFE_FILE_MAX_BYTES = 1024 * 1024;
/** Windows MAX_PATH without the `\\?\` prefix (259 characters plus the terminator). */
const WIN_MAX_PATH = 259;
const POSIX_MAX_PATH = 4095;
const WIN_DEVICE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;
const STALE_TEMP_MS = 60_000;
const LOCK_RETRIES = 5;

/** Tests only: watch or break the steps that cannot be forced from outside. */
export interface SafeFileHooks {
  beforeRename?: (tmp: string, target: string) => void;
  rename?: (from: string, to: string) => void;
  fsyncDir?: (dir: string) => void;
}
let hooks: SafeFileHooks = {};
export function setSafeFileHooksForTests(h: SafeFileHooks | null): void { hooks = h ?? {}; }

export const sha256 = contentSha256;

/** The folder's real path; it must exist and be a folder. */
export function safeRoot(folder: string | null | undefined): string {
  if (!folder) throw new SafeFileError('no_folder', 'There is no project folder');
  let real: string;
  try { real = fs.realpathSync.native(folder); } catch { throw new SafeFileError('no_folder', 'The project folder is not there'); }
  if (!fs.statSync(real).isDirectory()) throw new SafeFileError('no_folder', 'The project folder is not a folder');
  return real;
}

/** The parts of a relative path Girru may write, or an error saying why not. */
export function safeParts(relative: string): string[] {
  if (typeof relative !== 'string' || !relative || relative.includes('\0')) throw new SafeFileError('bad_path', 'Empty or invalid file name');
  if (relative.includes('\\') || relative.includes(':')) throw new SafeFileError('bad_path', `${relative}: "\\" and ":" are not allowed in a project file name`);
  if (relative.startsWith('/')) throw new SafeFileError('outside_folder', `${relative} is outside the project folder`);
  const parts = relative.split('/');
  for (const p of parts) {
    if (p === '..') throw new SafeFileError('outside_folder', `${relative} is outside the project folder`);
    if (!p || p === '.') throw new SafeFileError('bad_path', `${relative} is not a plain relative path`);
    if (/[. ]$/.test(p)) throw new SafeFileError('bad_path', `${relative}: a name may not end with a dot or a space`);
    if (WIN_DEVICE.test(p)) throw new SafeFileError('bad_path', `${relative}: "${p}" is a reserved device name on Windows`);
    if (/[\x00-\x1f<>"|?*]/.test(p)) throw new SafeFileError('bad_path', `${relative} has a character Windows does not allow`);
  }
  return parts;
}

const sameNode = (a: fs.Stats, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;
const lstatOrNull = (p: string): fs.Stats | null => { try { return fs.lstatSync(p); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } };
const fold = (s: string) => s.normalize('NFC').toLowerCase();

/** The name already in `dir` that differs from `name` only by case or Unicode form. */
function caseTwin(dir: string, name: string): string | null {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  return names.find((n) => n !== name && fold(n) === fold(name)) ?? null;
}

/** Walk (and create) the folders on the way; each must be a real folder at its expected real path. */
function checkDirs(root: string, dirs: string[], create: boolean): { dir: string; stat: fs.Stats } {
  let cur = root;
  let stat = fs.lstatSync(root);
  for (const part of dirs) {
    const next = path.join(cur, part);
    let st = lstatOrNull(next);
    if (!st) {
      const twin = caseTwin(cur, part);
      if (twin) throw new SafeFileError('case_collision', `${part} collides with ${twin} (names that differ only by case)`);
      if (!create) throw new SafeFileError('no_folder', `${part} is not there`);
      try { fs.mkdirSync(next, { mode: 0o755 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      st = fs.lstatSync(next);
    }
    if (st.isSymbolicLink()) throw new SafeFileError('link', `${part} is a link; Girru never writes through a link`);
    if (!st.isDirectory()) throw new SafeFileError('not_regular', `${part} is not a folder`);
    const real = fs.realpathSync.native(next);
    if (real !== next) {
      if (fold(real) === fold(next)) throw new SafeFileError('case_collision', `${part} is spelled ${path.basename(real)} on disk`);
      throw new SafeFileError('link', `${part} leads somewhere else (a junction or mount); Girru never writes through it`);
    }
    cur = next;
    stat = st;
  }
  return { dir: cur, stat };
}

/** The current target: missing, or a plain file with one name, read through one handle opened without following links. */
function readTarget(abs: string, maxBytes: number): { stat: fs.Stats; bytes: Buffer } | null {
  let fd: number;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP' || code === 'EMLINK') throw new SafeFileError('link', `${path.basename(abs)} is a link; Girru never writes through a link`);
    if (code === 'EISDIR') throw new SafeFileError('not_regular', `${path.basename(abs)} is a folder`);
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') throw new SafeFileError('locked', `${path.basename(abs)} is locked or not readable`);
    throw e;
  }
  try {
    const stat = fs.fstatSync(fd);
    const entry = fs.lstatSync(abs);
    if (entry.isSymbolicLink()) throw new SafeFileError('link', `${path.basename(abs)} is a link; Girru never writes through a link`);
    if (!stat.isFile() || !sameNode(stat, entry)) throw new SafeFileError('not_regular', `${path.basename(abs)} is not a plain file or changed while it was opened`);
    if (stat.nlink > 1) throw new SafeFileError('link', `${path.basename(abs)} has more than one name (a hard link); Girru leaves it alone`);
    // Read one byte more than the limit, so the hash below is never of a cut file.
    const cap = Math.max(maxBytes, SAFE_FILE_MAX_BYTES) + 1;
    const buf = Buffer.alloc(Math.min(stat.size, cap) + 1);
    let n = 0;
    while (n < buf.length) { const c = fs.readSync(fd, buf, n, buf.length - n, null); if (!c) break; n += c; }
    return { stat, bytes: buf.subarray(0, n) };
  } finally { fs.closeSync(fd); }
}

/** Temp files of this writer that a crash left behind (older than a minute, plain files only). */
function removeStaleTemps(dir: string, name: string): void {
  const prefix = `.${name}.girru-`;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith('.tmp')) continue;
    const st = lstatOrNull(path.join(dir, n));
    if (st?.isFile() && now - st.mtimeMs > STALE_TEMP_MS) fs.rmSync(path.join(dir, n), { force: true });
  }
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameOver(tmp: string, abs: string, platform: NodeJS.Platform): void {
  const doRename = hooks.rename ?? fs.renameSync;
  for (let i = 0; ; i++) {
    try { doRename(tmp, abs); return; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const busy = code === 'EBUSY' || ((code === 'EPERM' || code === 'EACCES') && platform === 'win32');
      if (!busy) throw e;
      if (i >= LOCK_RETRIES) throw new SafeFileError('locked', `${path.basename(abs)} is open in another program; nothing was changed. Close it and try again`);
      sleep(25 * 2 ** i);
    }
  }
}

function fsyncDir(dir: string, platform: NodeJS.Platform): void {
  if (platform === 'win32') return; // Windows has no directory fsync; the rename is already durable there.
  if (hooks.fsyncDir) { hooks.fsyncDir(dir); return; }
  let fd: number | null = null;
  try { fd = fs.openSync(dir, fs.constants.O_RDONLY); fs.fsyncSync(fd); } catch { /* some file systems refuse it; the data is flushed already */ } finally { if (fd !== null) fs.closeSync(fd); }
}

/** Is `text` something Girru may put into a project file? */
function checkText(text: string | Buffer, maxBytes: number, relative: string): Buffer {
  const bytes = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  if (bytes.length > maxBytes) throw new SafeFileError('too_large', `${relative} would be larger than ${Math.round(maxBytes / 1024)} KB`);
  if (bytes.includes(0)) throw new SafeFileError('not_text', `${relative} would not be a text file`);
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw new SafeFileError('not_text', `${relative} would not be valid UTF-8 text`);
  return bytes;
}

/**
 * Write `text` to `relative` inside `folder`, safely and atomically. Throws a
 * SafeFileError and leaves the file as it was when any check fails.
 */
export function safeWriteFile(folder: string, relative: string, text: string | Buffer, opts: SafeWriteOptions = {}): SafeWriteResult {
  const platform = opts.platform ?? process.platform;
  const maxBytes = opts.maxBytes ?? SAFE_FILE_MAX_BYTES;
  const root = safeRoot(folder);
  const parts = safeParts(relative);
  const name = parts[parts.length - 1];
  const abs = path.join(root, ...parts);
  const limit = platform === 'win32' ? WIN_MAX_PATH : POSIX_MAX_PATH;
  // The temp name is longer than the target's; it has to fit too.
  if (abs.length + 40 > limit) throw new SafeFileError('path_too_long', `${relative}: the full path is longer than this system allows`);
  const bytes = checkText(text, maxBytes, relative);

  const { dir, stat: dirStat } = checkDirs(root, parts.slice(0, -1), opts.createDirs !== false);
  removeStaleTemps(dir, name);
  const before = readTarget(abs, maxBytes);
  if (!before) {
    const twin = caseTwin(dir, name);
    if (twin) throw new SafeFileError('case_collision', `${relative} collides with ${twin} (names that differ only by case)`);
  } else {
    const real = fs.realpathSync.native(abs);
    if (real !== abs) throw new SafeFileError(fold(real) === fold(abs) ? 'case_collision' : 'link', `${relative} is spelled ${path.basename(real)} on disk`);
  }
  const beforeSha = before ? sha256(before.bytes) : null;
  if (opts.expectSha256 !== undefined && opts.expectSha256 !== beforeSha) throw new SafeFileError('changed', `${relative} changed since it was read; read it again`);
  const afterSha = sha256(bytes);
  if (beforeSha === afterSha) return { action: 'unchanged', file: abs, sha256: afterSha };

  const mode = before ? before.stat.mode & 0o777 : (opts.mode ?? 0o644);
  const tmp = path.join(dir, `.${name}.girru-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), mode);
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    fs.fsyncSync(fd);
    const t = fs.fstatSync(fd);
    if (!t.isFile() || t.nlink !== 1) throw new SafeFileError('changed', `${relative}: the temp file was changed by someone else`);
    fs.closeSync(fd);
    fd = null;
    if (platform !== 'win32') fs.chmodSync(tmp, mode);

    hooks.beforeRename?.(tmp, abs);
    // Re-check after open: the same folder, and the same target, as the ones checked above.
    const dirNow = lstatOrNull(dir);
    if (!dirNow || dirNow.isSymbolicLink() || !sameNode(dirNow, dirStat) || fs.realpathSync.native(dir) !== dir) throw new SafeFileError('changed', `${relative}: its folder changed during the write; nothing was changed`);
    const now = lstatOrNull(abs);
    if (before ? (!now || now.isSymbolicLink() || !sameNode(now, before.stat)) : now) throw new SafeFileError('changed', `${relative} changed during the write; nothing was changed`);
    if (before && opts.expectSha256 !== undefined) {
      const again = readTarget(abs, maxBytes);
      if (!again || sha256(again.bytes) !== beforeSha) throw new SafeFileError('changed', `${relative} changed during the write; nothing was changed`);
    }
    renameOver(tmp, abs, platform);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fsyncDir(dir, platform);
  return { action: before ? 'update' : 'create', file: abs, sha256: afterSha };
}

/**
 * The same for a file whose full path Girru got from elsewhere (Git's own
 * `info/exclude` of a worktree lives outside the project folder): `root` is the
 * folder it must stay in; outside it, only the file's own folder is trusted.
 */
export function safeWriteAt(root: string, file: string, text: string | Buffer, opts: SafeWriteOptions = {}): SafeWriteResult {
  const realRoot = safeRoot(root);
  const fromSelectedRoot = path.relative(path.resolve(root), path.resolve(root, file));
  const selectedChild = fromSelectedRoot && !fromSelectedRoot.startsWith('..') && !path.isAbsolute(fromSelectedRoot);
  const resolved = selectedChild ? path.resolve(realRoot, fromSelectedRoot) : path.resolve(realRoot, file);
  const rel = path.relative(realRoot, resolved);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return safeWriteFile(realRoot, rel.split(path.sep).join('/'), text, opts);
  return safeWriteFile(path.dirname(resolved), path.basename(resolved), text, opts);
}
