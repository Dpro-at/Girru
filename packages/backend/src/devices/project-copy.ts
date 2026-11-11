/**
 * CP10a “Copy it from This Mac” (D9, for projects without GitHub): a project's files travel once to
 * another of the owner's computers, inside the encrypted channel, after the owner allowed it on the
 * computer that has them. Ignored files (.gitignore) and build folders stay behind; files that look
 * like secrets never leave; links are skipped. The receiving computer writes them only into a new folder.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { secretPath, confusingSegment } from './work-result.js';
import { redactImportText } from '../memory/import/redact.js';
import { minimalChildEnv } from '../tools/exec-policy.js';

export const COPY_MAX_FILES = 5000;
export const COPY_MAX_RAW = 60 * 1024 * 1024;
export const COPY_MAX_PACKED = 12 * 1024 * 1024;
export const COPY_PART_CHARS = 16_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', 'coverage', 'venv', '.venv', '__pycache__', 'target', 'vendor', '.idea', '.DS_Store']);

function gitList(folder: string): Promise<string[] | null> {
  return new Promise(resolve => execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-pager', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: folder, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
    env: minimalChildEnv({ GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }),
  }, (err, stdout) => resolve(err ? null : String(stdout).split('\u0000').filter(Boolean))));
}
function walk(folder: string, rel = '', out: string[] = []): string[] {
  for (const name of readdirSync(path.join(folder, rel))) {
    if (SKIP_DIRS.has(name)) continue;
    const r = rel ? `${rel}/${name}` : name, st = lstatSync(path.join(folder, r));
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(folder, r, out); else if (st.isFile()) out.push(r);
    if (out.length > COPY_MAX_FILES) break;
  }
  return out;
}

/**
 * One listed file, read through a single descriptor. The name is opened without following a final link
 * (O_NOFOLLOW where the system has it) and without waiting on a pipe or device (O_NONBLOCK). After the
 * open, the name must still be a plain file with the same identity (dev+ino) as the open descriptor, and
 * its real path must sit inside the project; so a link (also on Windows, which has no O_NOFOLLOW), a file
 * swapped for a link, or a link in a parent folder never carries another file off this computer.
 */
export function readListedFile(full: string, realRoot: string): { bytes: Buffer; st: { size: number; mode: number } } | 'skip' | 'missing' {
  let fd: number;
  try { fd = openSync(full, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'skip'; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return 'skip';
    let named, real;
    try { named = lstatSync(full); real = realpathSync(full); } catch { return 'skip'; }
    if (named.isSymbolicLink() || !named.isFile() || named.dev !== st.dev || named.ino !== st.ino) return 'skip';
    if (!real.startsWith(realRoot + path.sep)) return 'skip';
    if (st.size > COPY_MAX_RAW) throw Error('computer_project_too_large');
    return { bytes: readFileSync(fd), st: { size: st.size, mode: st.mode } };
  } finally { closeSync(fd); }
}

/** The project packed for the trip: its files (not ignored, not secret, no links), gzip, then base64. */
export async function packProject(folder: string): Promise<{ text: string; files: number; size: number; sha256: string; skipped: number; secrets: number }> {
  if (!path.isAbsolute(folder) || !existsSync(folder)) throw Error('computer_project_folder_missing');
  const listed = (await gitList(folder)) ?? walk(folder);
  const realRoot = realpathSync(folder);
  const files: { p: string; m: number; d: string }[] = [];
  let raw = 0, skipped = 0, secrets = 0;
  for (const rel of listed) {
    if (files.length >= COPY_MAX_FILES) throw Error('computer_project_too_large');
    if (rel.split('/').some(n => SKIP_DIRS.has(n)) || secretPath(rel)) { skipped++; continue; }
    const read = readListedFile(path.join(folder, rel), realRoot);
    if (read === 'missing') continue;
    if (read === 'skip') { skipped++; continue; }
    const { bytes, st } = read;
    raw += st.size; if (raw > COPY_MAX_RAW) throw Error('computer_project_too_large');
    // A file whose text holds something that looks like a key or password stays behind (the parts are not readable on the way).
    if (bytes.length <= 2 * 1024 * 1024 && !bytes.subarray(0, 8000).includes(0) && redactImportText(bytes.toString('utf8')).total) { skipped++; secrets++; continue; }
    files.push({ p: rel, m: st.mode & 0o111 ? 0o755 : 0o644, d: bytes.toString('base64') });
  }
  const text = gzipSync(Buffer.from(JSON.stringify({ v: 1, files }))).toString('base64');
  if (text.length > COPY_MAX_PACKED * 4 / 3) throw Error('computer_project_too_large');
  return { text, files: files.length, size: text.length, sha256: createHash('sha256').update(text).digest('hex'), skipped, secrets };
}

export const copyParts = (text: string) => Array.from({ length: Math.max(1, Math.ceil(text.length / COPY_PART_CHARS)) }, (_, i) => text.slice(i * COPY_PART_CHARS, (i + 1) * COPY_PART_CHARS));

/** A path that may be written inside the new folder: relative, inside it, never git internals or a secret. */
export function safeCopyPath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 600 || p.startsWith('/') || p.includes('\\') || /[\x00-\x1f\x7f]/.test(p)) return false;
  const parts = p.split('/');
  return !parts.some(n => !n || n === '.' || n === '..' || n.toLowerCase() === '.git' || confusingSegment(n)) && !secretPath(p);
}

/** Write the copy into `parent/name` (a new folder), after checking it arrived whole. */
export function unpackProject(text: string, expected: { size: number; sha256: string }, parent: string, name: string): { folder: string; files: number } {
  if (text.length !== expected.size || createHash('sha256').update(text).digest('hex') !== expected.sha256) throw Error('computer_project_copy_changed');
  if (!path.isAbsolute(parent) || !existsSync(parent)) throw Error('computer_project_folder_invalid');
  const clean = name.replace(/[^A-Za-z0-9 _.-]/g, '-').trim().slice(0, 80);
  if (!clean || clean === '.' || clean === '..') throw Error('computer_project_folder_invalid');
  const folder = path.join(parent, clean);
  if (existsSync(folder)) throw Error('computer_project_folder_exists');
  const data = JSON.parse(gunzipSync(Buffer.from(text, 'base64'), { maxOutputLength: COPY_MAX_RAW * 2 }).toString('utf8'));
  if (data?.v !== 1 || !Array.isArray(data.files) || data.files.length > COPY_MAX_FILES) throw Error('computer_project_copy_invalid');
  for (const f of data.files) if (!safeCopyPath(f?.p) || typeof f.d !== 'string' || ![0o644, 0o755].includes(f.m)) throw Error('computer_project_copy_invalid');
  mkdirSync(folder, { mode: 0o755 });
  try {
    for (const f of data.files) {
      const full = path.join(folder, f.p);
      if (!full.startsWith(folder + path.sep)) throw Error('computer_project_copy_invalid');
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, Buffer.from(f.d, 'base64'), { mode: f.m, flag: 'wx' });
    }
  } catch (error) { rmSync(folder, { recursive: true, force: true }); throw error; }
  return { folder, files: data.files.length };
}
