/**
 * The Code app from the Girru Store (CODE-STORE-01, D-CODE-STORE).
 *
 * The Code editor (Nabu) is a Store app, not part of the Girru release. Its program
 * is a native runtime (well over a gigabyte unpacked), so the Store item lists one
 * archive per platform with its size and SHA-256 instead of a file package. Adding
 * Code is one job the window follows, like any Store app:
 *
 *   getting     stream the archive for this computer to disk, hashing as it arrives
 *               (the size must match; a stalled download stops after 60 s)
 *   checking    the SHA-256 must match the reviewed index, else nothing is unpacked
 *   setting-up  unpack into a new folder (own tar reader: plain files and folders only,
 *               every path inside the folder, no links, size and count limits) and
 *               check it is a protocol-1 Code runtime
 *   adding      point `current.json` at the new folder (one rename); the folder it replaced
 *               stays (a running editor may use it) until the next update
 *
 * The folder is Girru's per-computer app folder the desktop passes in
 * (GIRRU_APP_RUNTIMES_DIR), so every workspace shares one copy; the desktop bridge
 * finds Code there as well as inside the app (a developer build may still bundle it).
 * An update is the same job with the newer version; the running editor keeps its
 * folder until it starts again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { dataPath } from '../config/data-root.js';
import { readStoreRepo, runtimeUrlAllowed, type RepoRead, type RuntimeArchive, type RuntimePlatform, type StoreRuntime } from './store-repo.js';
import { trackJob, type AddJob } from './store-install.js';

export const CODE_ITEM = 'girru:code';
/** Files every Code runtime has (the desktop's check-bundle-inputs.cjs lists the same). */
export const CODE_FILES = ['nabu/runtime.json', 'nabu/dpro/editor-runtime.mjs', 'editor/out/server-main.js', 'editor/product.json'];
const MAX_UNPACKED = 8 * 1024 ** 3;
const MAX_ENTRIES = 400_000;
const STALL_MS = 60_000;
const DIR_NAME = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?-[a-f0-9]{8}$/;

export type RuntimeFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | null }>;

/** This computer, in the Store's archive names. */
export function runtimePlatform(platform: string = process.platform, arch: string = process.arch): RuntimePlatform | null {
  const key = `${platform}-${arch}`;
  return (['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'] as const).find((x) => x === key) ?? null;
}

/** Girru's per-computer app folder (from the desktop app), else the data folder (a server without the desktop app). */
export function runtimesRoot(): string {
  const env = (process.env.GIRRU_APP_RUNTIMES_DIR ?? '').trim();
  return env && path.isAbsolute(env) ? path.resolve(env) : dataPath('app-runtimes');
}
const codeRoot = () => path.join(runtimesRoot(), 'code');
/** True only in the desktop app: there the editor can open, so Code can be installed. */
export const codeStoreActive = () => !!(process.env.GIRRU_APP_RUNTIMES_DIR ?? '').trim();
/** The desktop app found a complete Code runtime inside itself (a developer build). */
export const codeBundled = () => process.env.GIRRU_CODE_RUNTIME_BUNDLED === '1';

export interface InstalledRuntime { version: string; dir: string; sha256: string; installedAt: string }
/** The installed Code runtime, from `current.json`: a folder directly inside the code folder, never a link. */
export function installedCodeRuntime(root: string = codeRoot()): InstalledRuntime | null {
  try {
    const raw = fs.readFileSync(path.join(root, 'current.json'), 'utf8');
    if (raw.length > 4096) return null;
    const c = JSON.parse(raw) as Record<string, unknown>;
    if (typeof c.dir !== 'string' || !DIR_NAME.test(c.dir) || typeof c.version !== 'string' || !c.dir.startsWith(`${c.version}-`) || typeof c.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(c.sha256)) return null;
    const dir = path.join(root, c.dir);
    const info = fs.lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || !runtimeComplete(dir)) return null;
    return { version: c.version, dir, sha256: c.sha256, installedAt: typeof c.installedAt === 'string' ? c.installedAt : '' };
  } catch { return null; }
}

/** A complete protocol-1 Code runtime in this folder (no links on the way to its files). */
export function runtimeComplete(dir: string): boolean {
  try {
    for (const name of CODE_FILES) {
      let at = dir;
      for (const part of name.split('/')) { at = path.join(at, part); if (fs.lstatSync(at).isSymbolicLink()) return false; }
      if (!fs.statSync(at).isFile()) return false;
    }
    const r = JSON.parse(fs.readFileSync(path.join(dir, 'nabu', 'runtime.json'), 'utf8')) as Record<string, unknown>;
    return r.protocolVersion === 1 && r.entry === 'dpro/editor-runtime.mjs';
  } catch { return false; }
}

export type CodeRuntimeState = 'bundled' | 'installed' | 'missing' | 'unsupported' | 'unavailable';
export interface CodeRuntimeStatus {
  /** bundled: inside the app; installed: from the Store; missing: can be installed; unsupported: no archive for this computer; unavailable: not the desktop app. */
  state: CodeRuntimeState;
  platform: RuntimePlatform | null;
  version: string | null;
  /** The Store's version when it differs from the installed one. */
  update: string | null;
  /** The Store's version and download size for this computer. */
  available: { version: string; size: number } | null;
  /** The job adding or updating Code right now. */
  job: string | null;
}
let running: AddJob | null = null;

const archiveFor = (runtime: StoreRuntime | undefined, platform: RuntimePlatform | null): RuntimeArchive | null => (runtime && platform ? runtime.archives[platform] ?? null : null);

/** Where Code stands on this computer, and what the Store offers for it. */
export async function codeRuntimeStatus(options: { repo?: () => Promise<RepoRead>; platform?: RuntimePlatform | null } = {}): Promise<CodeRuntimeStatus> {
  const platform = options.platform === undefined ? runtimePlatform() : options.platform;
  const job = running && !running.done ? running.id : null;
  if (!codeStoreActive()) return { state: codeBundled() ? 'bundled' : 'unavailable', platform, version: null, update: null, available: null, job: null };
  const repo = await (options.repo ?? readStoreRepo)().catch((): RepoRead => ({ index: null, asOf: null, fresh: false }));
  const runtime = repo.runtimes?.[CODE_ITEM];
  const archive = archiveFor(runtime, platform);
  const available = archive && runtime ? { version: runtime.version, size: archive.size } : null;
  if (codeBundled()) return { state: 'bundled', platform, version: null, update: null, available, job };
  const installed = installedCodeRuntime();
  if (installed) return { state: 'installed', platform, version: installed.version, update: available && available.version !== installed.version ? available.version : null, available, job };
  return { state: available ? 'missing' : 'unsupported', platform, version: null, update: null, available, job };
}

/** Start adding (or updating) Code; one job at a time, the window follows it. */
export async function startCodeInstall(options: { fetch?: RuntimeFetch; repo?: () => Promise<RepoRead>; platform?: RuntimePlatform | null } = {}): Promise<{ ok: true; job: AddJob } | { ok: false; code: 'not_installable' | 'not_found'; message: string }> {
  if (running && !running.done) return { ok: true, job: running };
  if (!codeStoreActive()) return { ok: false, code: 'not_installable', message: 'Code opens only in the Girru desktop app.' };
  if (codeBundled()) return { ok: false, code: 'not_installable', message: 'Code comes with this Girru. It is already in My apps.' };
  const platform = options.platform === undefined ? runtimePlatform() : options.platform;
  const repo = await (options.repo ?? readStoreRepo)();
  const runtime = repo.runtimes?.[CODE_ITEM];
  const archive = archiveFor(runtime, platform);
  if (!runtime || !archive) return { ok: false, code: 'not_found', message: 'The Girru Store has no Code for this computer yet.' };
  const job = trackJob('code', (j) => installRuntime(j, runtime.version, archive, options.fetch), (j) => { if (running === j) running = null; });
  running = job;
  return { ok: true, job };
}

async function installRuntime(job: AddJob, version: string, archive: RuntimeArchive, get: RuntimeFetch = globalThis.fetch as unknown as RuntimeFetch) {
  if (!runtimeUrlAllowed(archive.url)) throw new Error('the download address is not a Girru Store release');
  const root = codeRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('the app folder is a link');
  const previous = installedCodeRuntime(root)?.dir ?? null;
  sweep(root, [], true);
  await enoughSpace(root, archive.size);
  const tag = randomBytes(4).toString('hex');
  const download = path.join(root, `.download-${tag}.tar.gz`);
  const incoming = path.join(root, `.incoming-${tag}`);
  try {
    // 1. Getting: to disk, hashed as it arrives, never more than the reviewed size.
    job.step = 'getting'; job.received = 0; job.total = archive.size;
    const hash = await downloadTo(archive, download, get, (n) => { job.received = n; });
    // 2. Checking: the reviewed checksum, before anything is unpacked.
    job.step = 'checking';
    if (hash !== archive.sha256) throw new Error('the download does not match the Girru Store checksum, so nothing was installed');
    // 3. Setting up: a new folder, plain files only, then the runtime check.
    job.step = 'setting-up';
    fs.mkdirSync(incoming, { mode: 0o700 });
    await unpackTarGz(download, incoming);
    if (!runtimeComplete(incoming)) throw new Error('the download is not a Code editor for Girru');
    const declared = (JSON.parse(fs.readFileSync(path.join(incoming, 'nabu', 'runtime.json'), 'utf8')) as { version?: unknown }).version;
    if (declared !== undefined && declared !== version) throw new Error('the download is a different Code version than the Girru Store lists');
    // 4. Adding: one rename makes it the current Code; older folders go (a running editor keeps its own until it starts again).
    job.step = 'adding';
    const name = `${version}-${tag}`;
    fs.renameSync(incoming, path.join(root, name));
    const tmp = path.join(root, `.current-${tag}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ version, dir: name, sha256: archive.sha256, installedAt: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(tmp, path.join(root, 'current.json'));
    // The version a running editor may still use stays until the next update.
    sweep(root, [name, ...(previous ? [path.basename(previous)] : [])], false);
    Object.assign(job, { done: true, ok: true, restart: 'none', message: `Code ${version} is installed.` });
  } finally {
    fs.rmSync(download, { force: true });
    fs.rmSync(incoming, { recursive: true, force: true });
  }
}

/** Remove leftovers: half-finished downloads always; after an update, versions older than the one it replaced. */
function sweep(root: string, keep: string[], leftoversOnly: boolean) {
  let names: string[] = [];
  try { names = fs.readdirSync(root); } catch { return; }
  for (const n of names) {
    const leftover = /^\.(download|incoming|current)-[a-f0-9]{8}/.test(n);
    if (leftover || (!leftoversOnly && DIR_NAME.test(n) && !keep.includes(n))) { try { fs.rmSync(path.join(root, n), { recursive: true, force: true }); } catch { /* in use (Windows): next time */ } }
  }
}

export async function enoughSpace(root: string, size: number, label = 'Code') {
  try {
    const s = await fs.promises.statfs(root);
    if (Number(s.bavail) * Number(s.bsize) < size * 4) throw Object.assign(new Error(`there is not enough free disk space (${label} needs about four times its download)`), { space: true });
  } catch (error) { if ((error as { space?: boolean }).space) throw error; /* no statfs here: try anyway */ }
}

export async function downloadTo(archive: RuntimeArchive, file: string, get: RuntimeFetch, progress: (n: number) => void): Promise<string> {
  const control = new AbortController();
  let timer = setTimeout(() => control.abort(), STALL_MS);
  const fresh = () => { clearTimeout(timer); timer = setTimeout(() => control.abort(), STALL_MS); };
  const out = await fs.promises.open(file, 'wx', 0o600);
  const hash = createHash('sha256');
  let received = 0;
  try {
    const res = await get(archive.url, { signal: control.signal, headers: { 'User-Agent': 'Girru', Accept: 'application/octet-stream' } });
    if (!res.ok || !res.body) throw new Error(`the download answered ${res.status}`);
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      fresh();
      received += chunk.byteLength;
      if (received > archive.size) throw new Error('the download is larger than the Girru Store lists');
      hash.update(chunk);
      await out.write(chunk);
      progress(received);
    }
    if (received !== archive.size) throw new Error(`the download stopped at ${mb(received)} of ${mb(archive.size)}; check the internet connection and try again`);
    return hash.digest('hex');
  } catch (error) {
    if (control.signal.aborted) throw new Error(received ? `the download stopped at ${mb(received)} of ${mb(archive.size)}; check the internet connection and try again` : 'the download did not start; check the internet connection and try again');
    if (error instanceof Error && /larger than the Girru Store lists|answered \d+/.test(error.message)) throw error;
    // fetch failed / socket closed: no network, or the connection dropped half-way.
    throw new Error(received ? `the download stopped at ${mb(received)} of ${mb(archive.size)}; check the internet connection and try again` : 'Girru could not reach the download; check the internet connection and try again');
  } finally { clearTimeout(timer); await out.close(); }
}

const mb = (n: number) => { const v = n / 1048576; return `${v < 10 ? v.toFixed(1) : Math.round(v)} MB`; };

/**
 * Remove Code that was added from the Store: only Girru's own code folder (every version and
 * current.json). A Code that comes inside the app, or one being added right now, stays.
 */
export function removeCodeRuntime(): { ok: true } | { ok: false; code: 'not_found' | 'refused'; message: string } {
  if (!codeStoreActive() || codeBundled()) return { ok: false, code: 'refused', message: 'Code comes with this Girru; it cannot be removed here.' };
  if (running && !running.done) return { ok: false, code: 'refused', message: 'Code is being added right now. Remove it when that has finished.' };
  const root = codeRoot();
  if (!installedCodeRuntime(root)) return { ok: false, code: 'not_found', message: 'Code is not installed.' };
  if (fs.lstatSync(root).isSymbolicLink()) return { ok: false, code: 'refused', message: 'The app folder is a link; Girru leaves it alone.' };
  fs.rmSync(root, { recursive: true, force: true });
  return { ok: true };
}

/** Bytes from a stream, in exact amounts or in pieces. */
function byteReader(source: AsyncIterable<Buffer>) {
  const it = source[Symbol.asyncIterator]();
  let buf: Buffer = Buffer.alloc(0), ended = false;
  const fill = async (n: number) => { while (buf.length < n && !ended) { const r = await it.next(); if (r.done) ended = true; else buf = buf.length ? Buffer.concat([buf, r.value]) : r.value; } };
  return {
    async exact(n: number): Promise<Buffer | null> { await fill(n); if (buf.length < n) return null; const out = buf.subarray(0, n); buf = buf.subarray(n); return out; },
    async some(max: number): Promise<Buffer | null> { await fill(1); if (!buf.length) return null; const k = Math.min(max, buf.length); const out = buf.subarray(0, k); buf = buf.subarray(k); return out; },
  };
}
const field = (h: Buffer, at: number, len: number) => { const s = h.subarray(at, at + len); const z = s.indexOf(0); return (z < 0 ? s : s.subarray(0, z)).toString('utf8'); };
const octal = (h: Buffer, at: number, len: number) => {
  if (h[at] & 0x80) throw new Error('the archive has an entry that is too large');
  const t = field(h, at, len).trim();
  if (!/^[0-7]*$/.test(t)) throw new Error('the archive is damaged');
  return t ? parseInt(t, 8) : 0;
};
/** A path inside the folder: plain relative parts only (no "..", no drive or stream names, no backslashes). */
export function safeEntryPath(name: string): string[] | null {
  const n = name.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!n || n.length > 1024 || n.startsWith('/') || /[\\:\0]/.test(n)) return null;
  const parts = n.split('/');
  if (parts.length > 64 || parts.some((p) => !p || p === '.' || p === '..' || p.length > 255)) return null;
  return parts;
}

/**
 * Unpack a .tar.gz into an empty folder Girru just made. Only plain files and folders:
 * links, devices and anything else stop the install, so the folder never points outside itself.
 */
export async function unpackTarGz(file: string, dest: string, limits: { bytes?: number; entries?: number } = {}): Promise<{ files: number; bytes: number }> {
  const maxBytes = limits.bytes ?? MAX_UNPACKED, maxEntries = limits.entries ?? MAX_ENTRIES;
  const read = byteReader(fs.createReadStream(file).pipe(createGunzip()) as AsyncIterable<Buffer>);
  let files = 0, bytes = 0, entries = 0;
  let nextName: string | null = null;
  const body = async (size: number, sink: ((b: Buffer) => Promise<void>) | null) => {
    let left = size;
    while (left > 0) { const b = await read.some(Math.min(left, 1 << 20)); if (!b) throw new Error('the archive ends too early'); left -= b.length; if (sink) await sink(b); }
    const pad = (512 - (size % 512)) % 512;
    if (pad && !(await read.exact(pad))) throw new Error('the archive ends too early');
  };
  const small = async (size: number) => { if (size > 1 << 20) throw new Error('the archive is damaged'); const parts: Buffer[] = []; await body(size, async (b) => { parts.push(Buffer.from(b)); }); return Buffer.concat(parts).toString('utf8'); };
  for (;;) {
    const h = await read.exact(512);
    if (!h) throw new Error('the archive ends too early');
    if (h.every((x) => x === 0)) break;
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw new Error('the archive is damaged');
    if (++entries > maxEntries) throw new Error('the archive has too many files');
    const type = String.fromCharCode(h[156] || 48), size = octal(h, 124, 12);
    if (type === 'x') { const pax = await small(size); for (const rec of pax.split('\n')) { const m = /^\d+ path=(.*)$/s.exec(rec); if (m) nextName = m[1]; else if (/^\d+ linkpath=/.test(rec)) throw new Error('the archive has a link'); } continue; }
    if (type === 'g') { await small(size); continue; }
    if (type === 'L') { nextName = (await small(size)).replace(/\0+$/, ''); continue; }
    const prefix = field(h, 345, 155), raw = nextName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    nextName = null;
    if (type !== '0' && type !== '5') throw new Error('the archive has a link or a special file');
    const parts = safeEntryPath(raw);
    if (!parts) throw new Error('a file path leaves the app folder');
    const target = path.join(dest, ...parts);
    const rel = path.relative(dest, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('a file path leaves the app folder');
    if (type === '5') { if (size) throw new Error('the archive is damaged'); fs.mkdirSync(target, { recursive: true, mode: 0o755 }); continue; }
    bytes += size;
    if (bytes > maxBytes) throw new Error('the archive unpacks to more than Girru allows');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    const out = await fs.promises.open(target, 'wx', octal(h, 100, 8) & 0o111 ? 0o755 : 0o644);
    try { await body(size, async (b) => { await out.write(b); }); } finally { await out.close(); }
    files++;
  }
  return { files, bytes };
}
