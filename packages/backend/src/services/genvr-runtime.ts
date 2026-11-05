/** GenVR's reviewed Store runtime. Projects, accounts and world data never live here. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { PIN, completeGenvrRuntime, installedGenvrRuntime } from '../config/genvr-runtime-path.cjs';
import { runtimePlatform, unpackTarGz, type RuntimeFetch } from './code-runtime.js';
import { genvrRuntimesRoot, genvrStoreActive, genvrBundled } from '../config/genvr-runtime.js';
export { genvrStoreActive, genvrBundledRoot, genvrRuntime, genvrInstalled, genvrBundled } from '../config/genvr-runtime.js';
import { readStoreRepo, runtimeUrlAllowed, type RepoRead, type RuntimePlatform, type StoreRuntime, type RuntimeArchive } from './store-repo.js';
import { readRegularFile } from './read-regular-file.js';
import { trackJob, type AddJob } from './store-install.js';

export const GENVR_ITEM = 'girru:genvr';
let running: AddJob | null = null;
type Options = { repo?: () => Promise<RepoRead>; platform?: RuntimePlatform | null; fetch?: RuntimeFetch; restart?: () => boolean; root?: string; pin?: typeof PIN };
const archiveFor = (runtime: StoreRuntime | undefined, platform: RuntimePlatform | null) => runtime && platform ? runtime.archives[platform] ?? null : null;
const compatible = (runtime: StoreRuntime, archive: RuntimeArchive, pin = PIN) => runtime.version === pin.version && archive.sha256 === pin.archiveSha256 && archive.size === pin.size;

export async function genvrRuntimeStatus(options: Options = {}) {
  const platform = options.platform === undefined ? runtimePlatform() : options.platform;
  const pin = options.pin ?? PIN, root = options.root ?? genvrRuntimesRoot();
  const installed = installedGenvrRuntime(root, pin);
  const bundled = !options.root && genvrBundled();
  const repo = await (options.repo ?? readStoreRepo)().catch((): RepoRead => ({ index: null, asOf: null, fresh: false }));
  const runtime = repo.runtimes?.[GENVR_ITEM], archive = archiveFor(runtime, platform);
  const available = runtime && archive && compatible(runtime, archive, pin) ? { version: runtime.version, size: archive.size } : null;
  return { state: !options.root && !genvrStoreActive() && !bundled ? 'unavailable' : installed ? 'installed' : bundled ? 'bundled' : !platform ? 'unsupported' : 'missing', platform, version: installed?.version ?? (bundled ? pin.version : null), update: null, available, job: running && !running.done ? running.id : null };
}

export async function startGenvrInstall(options: Options = {}) {
  if (running && !running.done) return { ok: true as const, job: running };
  const pin = options.pin ?? PIN, root = options.root ?? genvrRuntimesRoot();
  if (!options.root && !genvrStoreActive()) return { ok: false as const, code: 'not_installable' as const, message: 'Adding GenVR needs the app runtime folder configured by Girru.' };
  if (!options.root && genvrBundled()) return { ok: false as const, code: 'not_installable' as const, message: 'GenVR comes with this developer build.' };
  const platform = options.platform === undefined ? runtimePlatform() : options.platform;
  const repo = await (options.repo ?? readStoreRepo)(), runtime = repo.runtimes?.[GENVR_ITEM], archive = archiveFor(runtime, platform);
  if (!runtime || !archive) return { ok: false as const, code: 'not_found' as const, message: 'The Girru Store has no GenVR for this computer yet.' };
  if (!compatible(runtime, archive, pin)) return { ok: false as const, code: 'not_installable' as const, message: 'This GenVR version needs a matching Girru update.' };
  // Reserve after asynchronous catalogue reads as well: two clicks still start only one download.
  if (running && !running.done) return { ok: true as const, job: running };
  const job = trackJob('genvr', j => install(j, archive, { ...options, root, pin }), j => { if (running === j) running = null; });
  running = job;
  return { ok: true as const, job };
}

class InstallError extends Error {}
const VERSION_DIR = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?-[a-f0-9]{8}$/;
function sweep(root: string, keep: Set<string>) {
  for (const name of fs.readdirSync(root)) {
    if (keep.has(name) || (!VERSION_DIR.test(name) && !/^\.(?:incoming|download|current)-[a-f0-9]{8}$/.test(name))) continue;
    try { const file = path.join(root, name); if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file); else fs.rmSync(file, { recursive: true, force: true }); } catch { /* a closing host can release its old program files on the next attempt */ }
  }
}
async function download(archive: RuntimeArchive, file: string, get: RuntimeFetch, job: AddJob) {
  if (!runtimeUrlAllowed(archive.url)) throw new InstallError('The GenVR download address is not a reviewed release.');
  const out = await fs.promises.open(file, 'wx', 0o600);
  const control = new AbortController(); let timer = setTimeout(() => control.abort(), 60000);
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => control.abort(), 60000); };
  const hash = createHash('sha256'); let received = 0;
  try {
    const response = await get(archive.url, { signal: control.signal, headers: { 'User-Agent': 'Girru' } });
    if (!response.ok || !response.body) throw new InstallError('The GenVR download could not be started.');
    job.total = archive.size; job.received = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      reset(); const data = Buffer.from(chunk); received += data.length;
      if (received > archive.size) throw new InstallError('The GenVR download is larger than expected.');
      hash.update(data); await out.writeFile(data); job.received = received;
    }
    if (received !== archive.size) throw new InstallError('The GenVR download stopped early. Try again.');
    if (hash.digest('hex') !== archive.sha256) throw new InstallError('The GenVR download did not pass its integrity check.');
  } finally { clearTimeout(timer); control.abort(); await out.close(); }
}

async function sdkManifest(incoming: string, pin: typeof PIN) {
  const packageFile = path.join(incoming, 'package/package.json');
  const pkg = JSON.parse((await readRegularFile(packageFile, 65536)).data.toString('utf8'));
  if (pkg.name !== '3d-world-sdk' || pkg.version !== pin.version) throw new InstallError('The archive is not the expected GenVR version.');
  const files: Record<string, string> = {};
  const add = (file: string) => {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const st = fs.fstatSync(fd); if (!st.isFile() || st.size > 128 * 1024 * 1024) throw new InstallError('A GenVR asset is too large.');
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let total = 0;
      for (;;) { const n = fs.readSync(fd, buffer, 0, buffer.length, null); if (!n) break; total += n; if (total > 128 * 1024 * 1024) throw new InstallError('A GenVR asset is too large.'); hash.update(buffer.subarray(0, n)); }
      files[path.relative(path.join(incoming, 'package'), file).split(path.sep).join('/')] = hash.digest('hex');
    } finally { fs.closeSync(fd); }
  };
  const walk = (folder: string) => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); if (entry.isDirectory()) walk(file); else if (entry.isFile()) add(file); else throw new InstallError('GenVR runtime links are not allowed.'); } };
  walk(path.join(incoming, 'package/dist'));
  for (const file of ['LICENSE', 'README.md']) add(path.join(incoming, 'package', file));
  fs.writeFileSync(path.join(incoming, 'manifest.json'), JSON.stringify({ package: '3d-world-sdk', version: pin.version, archiveSha256: pin.archiveSha256, files }));
  if (!completeGenvrRuntime(incoming, pin)) throw new InstallError('The GenVR runtime did not pass its compatibility check.');
}

async function install(job: AddJob, archive: RuntimeArchive, options: Options & { root: string; pin: typeof PIN }) {
  const root = path.join(options.root, 'genvr'), id = randomBytes(4).toString('hex');
  const incoming = path.join(root, `.incoming-${id}`), downloadFile = path.join(root, `.download-${id}`), pointer = path.join(root, `.current-${id}`);
  let safeRoot = false;
  try {
    fs.mkdirSync(options.root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(options.root).isSymbolicLink()) throw new InstallError('The app runtime folder is a link.');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink()) throw new InstallError('The GenVR runtime folder is a link.');
    safeRoot = true;
    const previous = installedGenvrRuntime(options.root, options.pin)?.dir;
    sweep(root, new Set(previous ? [previous] : []));
    const free = fs.statfsSync(root);
    if (Number(free.bavail) * Number(free.bsize) < archive.size * 4) throw new InstallError('There is not enough free space to add GenVR.');
    await download(archive, downloadFile, options.fetch ?? globalThis.fetch as unknown as RuntimeFetch, job);
    job.step = 'checking';
    fs.mkdirSync(incoming, { mode: 0o700 }); job.step = 'setting-up';
    await unpackTarGz(downloadFile, incoming, { bytes: 512 * 1024 * 1024, entries: 50000 });
    await sdkManifest(incoming, options.pin);
    const dir = `${options.pin.version}-${id}`;
    fs.renameSync(incoming, path.join(root, dir));
    fs.writeFileSync(pointer, JSON.stringify({ version: options.pin.version, dir, sha256: archive.sha256, installedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
    job.step = 'adding'; fs.renameSync(pointer, path.join(root, 'current.json'));
    job.ok = true; job.done = true; job.message = 'GenVR was added. Your existing projects are kept.';
    try { job.restart = options.restart?.() ? 'auto' : 'manual'; } catch { job.restart = 'manual'; }
    if(job.restart==='manual')job.message='GenVR was added. Restart Girru to open it. Your existing projects are kept.';
  } catch (error) { throw error instanceof InstallError ? error : new InstallError('GenVR could not be added safely. Check available space and try again.'); }
  finally { if (safeRoot) for (const file of [incoming, downloadFile, pointer]) { try { fs.rmSync(file, { recursive: true, force: true }); } catch { /* temporary software files can be cleaned on the next attempt */ } } }
}

/** Remove only the active SDK pointer/files; never world folders, accounts or database tables. */
export function removeGenvrRuntime(options: Pick<Options, 'root' | 'pin' | 'restart'> = {}) {
  if(running&&!running.done)return {ok:false as const,code:'refused' as const,message:'Wait for GenVR to finish adding before removing it.'};
  const root = options.root ?? genvrRuntimesRoot(), installed = installedGenvrRuntime(root, options.pin ?? PIN);
  if (!installed) return { ok: false as const, code: 'not_found' as const, message: 'GenVR is not installed here.' };
  try {
    fs.unlinkSync(path.join(root, 'genvr/current.json'));
    sweep(path.join(root, 'genvr'), new Set());
    let restart: 'auto' | 'manual' = 'manual';
    try { if (options.restart?.()) restart = 'auto'; } catch { /* removal already committed; the owner can restart manually */ }
    return { ok: true as const, restart };
  } catch { return { ok: false as const, code: 'refused' as const, message: 'GenVR could not be removed. Try again after closing it.' }; }
}
