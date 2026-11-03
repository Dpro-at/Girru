/**
 * Automatic backup (BACKUP-01, board Backup1). Like a cron job: every day at 03:00
 * (or as soon as the computer is awake after that) and before every update, Girru
 * copies the whole data folder to a folder outside it that only the owner can open.
 *
 *  - SQLite stores are copied with SQLite's own online backup (Girru keeps running),
 *    checked with `PRAGMA integrity_check`, then gzip'd. Other files are copied; a
 *    file that did not change since the last backup is a hard link to it.
 *  - The memory and uploads folders that live outside the data root (legacy layout)
 *    are part of it; `.env` and `secrets.env` are kept for a new computer but a
 *    restore never puts them back (they are configuration, not data).
 *  - Keeps the last 14 days and the last 4 Sundays; before-update and before-restore
 *    backups 30 days; the newest always.
 *  - Restore is a restart: a marker in the data folder, read on the next start
 *    (config/load-env.ts) before any store opens. Girru backs up first, so a restore
 *    can be undone by restoring that backup.
 *
 * SQLite only: on PostgreSQL the database is backed up with pg_dump outside the app.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGzip, createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { dataRoot, dataPathOr, mainDatabasePath, realish, defaultBackupsFolder, backupsFolder, setSavedBackupsFolder } from '../config/data-root.js';

export type BackupKind = 'daily' | 'manual' | 'before-update' | 'before-restore';
export const BACKUP_KINDS: readonly BackupKind[] = ['daily', 'manual', 'before-update', 'before-restore'];
export const DAILY_AT = '03:00';
export const KEEP_DAYS = 14;
export const KEEP_SUNDAYS = 4;
export const KEEP_UPDATE_DAYS = 30;

const ID = /^\d{8}-\d{6}-(daily|manual|before-update|before-restore)$/;
const MANIFEST = 'manifest.json';
const STATE_FILE = 'backups-state.json';
export const RESTORE_MARKER = 'restore-pending.json';
/** Top-level names in the data root that are never part of a backup. */
const KEY_FILE = 'backups.key';
const SKIP_TOP = new Set(['backups', 'logs', 'tmp', 'run', 'home', 'browser', 'python', 'node_modules', STATE_FILE, RESTORE_MARKER, KEY_FILE]);
/** The SQLite stores Girru itself writes (relative to the data root). Every other file, uploads included, is copied byte for byte. */
const STORES = ['audit/audit.db', 'encryption/keys.db', 'encryption/credentials.db', 'multi-agent/orchestrator.db', 'webhooks/webhooks.db', 'memory/memory.db'];
/** Saved, but a restore leaves the current ones (configuration and identity). */
const KEEP_ON_RESTORE = new Set(['secrets.env', 'instance.json', '.env']);
const CLOUD = /(Library\/Mobile Documents|iCloud|Dropbox|Google Drive|OneDrive|CloudStorage|Box Sync)/i;

type Root = 'data' | 'database' | 'memory' | 'uploads' | 'config';
interface Entry { root: Root; path: string; type: 'sqlite' | 'file'; size: number; mtimeMs: number; stored: number; sha256?: string; check?: 'ok' | 'failed' }
export interface Manifest { version: 1; id: string; kind: BackupKind; at: string; checked: boolean; entries: Entry[]; mac?: string }
export interface BackupInfo { id: string; kind: BackupKind; at: string; checked: boolean; size: number; parts: { data: boolean; audit: boolean; keys: boolean }; keepUntil: string | null }

export class BackupError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }

// --- where -------------------------------------------------------------------

const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
function readJson<T>(file: string): T | null { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } }
function writePrivate(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export { defaultBackupsFolder, backupsFolder };
/** One sub-folder per workspace, so a test copy and the real data never mix. */
function workspaceName(): string {
  const id = readJson<{ id?: unknown }>(path.join(dataRoot(), 'instance.json'))?.id;
  // The data folder's own path is part of the name: a copy of the same workspace (a test copy) never shares its backups.
  const where = createHash('sha256').update(realish(dataRoot())).digest('hex').slice(0, 6);
  return `workspace-${typeof id === 'string' && /^[0-9a-f-]{8,}$/i.test(id) ? id.slice(0, 8) : 'local'}-${where}`;
}
export function workspaceBackupsDir(folder = backupsFolder()): string { return path.join(folder, workspaceName()); }
export const isCloudFolder = (folder: string) => CLOUD.test(folder);

/** Where the backups go: absolute, outside every data folder, created owner-only. */
const FOLDER_KEY = 'backups.folder';
const APP_SETTINGS_SQL = 'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)';
/** On start: the owner's folder from the database. Before the database opens (a restore), read it read-only. */
export async function loadBackupsFolder(): Promise<void> {
  const { q } = await import('../repositories/sql-steps.js');
  const row = await q.one<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', FOLDER_KEY).catch(() => null);
  setSavedBackupsFolder(row?.value ?? null);
}
function loadBackupsFolderOffline(): void {
  try {
    const db = new Database(mainDatabasePath(), { readonly: true, fileMustExist: true });
    try { setSavedBackupsFolder((db.prepare('SELECT value FROM app_settings WHERE key = ?').get(FOLDER_KEY) as { value?: string } | undefined)?.value ?? null); } finally { db.close(); }
  } catch { setSavedBackupsFolder(null); }
}

export async function setBackupsFolder(input: unknown): Promise<{ folder: string; cloud: boolean }> {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024) throw new BackupError(400, 'invalid_folder', 'Choose a folder');
  const raw = input.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(raw)) throw new BackupError(400, 'invalid_folder', 'The folder must be a full path');
  // Only in your home folder or on an external drive, on the canonical path (a link cannot point elsewhere).
  const folder = path.resolve(realish(path.resolve(raw)));
  const home = path.resolve(realish(os.homedir())) + path.sep;
  const drives = process.platform === 'darwin' ? '/Volumes/' : process.platform === 'linux' ? '/media/' : home;
  if (!folder.startsWith(home) && !folder.startsWith(drives) && !(process.platform === 'linux' && folder.startsWith('/mnt/'))) throw new BackupError(400, 'invalid_folder', 'Choose a folder in your home folder or on an external drive');
  for (const d of dataFolders()) if (inside(folder, realish(d)) || inside(realish(d), folder)) throw new BackupError(400, 'invalid_folder', 'Backups must be kept outside the data folder');
  const { q } = await import('../repositories/sql-steps.js');
  await q.run(APP_SETTINGS_SQL);
  await q.run('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', FOLDER_KEY, folder, Date.now());
  // Read back from the database: every path the backups use comes from the saved setting, not the request.
  await loadBackupsFolder();
  const saved = backupsFolder();
  try { fs.mkdirSync(saved, { recursive: true, mode: 0o700 }); } catch {
    await q.run('DELETE FROM app_settings WHERE key = ?', FOLDER_KEY);
    await loadBackupsFolder();
    throw new BackupError(400, 'invalid_folder', 'That folder cannot be made');
  }
  return { folder: saved, cloud: isCloudFolder(saved) };
}

function auditPath() { return path.resolve(process.env.AUDIT_DB_PATH || dataPathOr('./.data/audit/audit.db', 'audit', 'audit.db')); }
function memoryDir() { return path.resolve(dataPathOr('../../.data/memory', 'memory')); }
function uploadsDir() { return path.resolve(process.env.UPLOADS_DIR || dataPathOr('../../.data/uploads', 'uploads')); }
function dataFolders(): string[] { return [path.resolve(dataRoot()), memoryDir(), uploadsDir()]; }
/** Each root's folder; memory and uploads only when they sit outside the data root. */
function roots(): Partial<Record<Root, string>> {
  const data = path.resolve(dataRoot());
  const out: Partial<Record<Root, string>> = { data, config: process.cwd() };
  const main = path.resolve(mainDatabasePath());
  if (!inside(main, data)) out.database = path.dirname(main);
  if (!inside(memoryDir(), data)) out.memory = memoryDir();
  if (!inside(uploadsDir(), data)) out.uploads = uploadsDir();
  return out;
}

// --- list and retention --------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
export const backupId = (at: Date, kind: BackupKind) => `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${kind}`;
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Ids that retention removes (newest first input or not). Pure, for the tests. */
export function expiredBackups(list: Array<{ id: string; at: string; kind: BackupKind }>, now: Date): string[] {
  const sorted = [...list].sort((a, b) => b.at.localeCompare(a.at));
  const keep = new Set<string>(sorted.slice(0, 1).map((b) => b.id));
  const day = 86_400_000;
  const sundays: string[] = [];
  for (const b of sorted) {
    const age = now.getTime() - new Date(b.at).getTime();
    if (b.kind === 'before-update' || b.kind === 'before-restore') { if (age <= KEEP_UPDATE_DAYS * day) keep.add(b.id); continue; }
    if (age <= KEEP_DAYS * day) { keep.add(b.id); continue; }
    const d = new Date(b.at);
    if (d.getDay() === 0 && !sundays.includes(localDay(d)) && sundays.length < KEEP_SUNDAYS) { sundays.push(localDay(d)); keep.add(b.id); }
  }
  return sorted.filter((b) => !keep.has(b.id)).map((b) => b.id);
}
function keepUntil(b: { id: string; at: string; kind: BackupKind }, all: Array<{ id: string; at: string; kind: BackupKind }>): string | null {
  const days = b.kind === 'before-update' || b.kind === 'before-restore' ? KEEP_UPDATE_DAYS : KEEP_DAYS;
  const plain = new Date(new Date(b.at).getTime() + days * 86_400_000);
  // A kept Sunday stays longer than its 14 days: until four newer Sundays exist.
  if (days === KEEP_DAYS && new Date(b.at).getDay() === 0) {
    const later = new Set(all.filter((x) => x.at > b.at && new Date(x.at).getDay() === 0 && x.kind !== 'before-update' && x.kind !== 'before-restore').map((x) => localDay(new Date(x.at))));
    if (later.size < KEEP_SUNDAYS) return null;
  }
  return plain.toISOString();
}

function readManifest(dir: string): Manifest | null {
  const m = readJson<Manifest>(path.join(dir, MANIFEST));
  return m && m.version === 1 && typeof m.id === 'string' && ID.test(m.id) && Array.isArray(m.entries) ? m : null;
}
function manifests(): Manifest[] {
  const dir = workspaceBackupsDir();
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => ID.test(n)).map((n) => readManifest(path.join(dir, n))).filter((m): m is Manifest => !!m && ID.test(m.id)).sort((a, b) => b.at.localeCompare(a.at));
}
const isAudit = (e: Entry) => e.root === 'data' && path.join(path.resolve(dataRoot()), e.path) === auditPath();
const isMain = (e: Entry) => (e.root === 'data' && path.join(path.resolve(dataRoot()), e.path) === path.resolve(mainDatabasePath())) || (e.root === 'database' && e.path === path.basename(mainDatabasePath()));
const info = (m: Manifest, all: Manifest[]): BackupInfo => ({
  id: m.id, kind: m.kind, at: m.at, checked: m.checked, size: m.entries.reduce((s, e) => s + (e.stored || 0), 0),
  parts: { data: m.entries.some((e) => isMain(e) && e.check === 'ok'), audit: m.entries.some((e) => isAudit(e) && e.check === 'ok'), keys: m.entries.some((e) => e.root === 'data' && e.path.startsWith('encryption' + path.sep) && (e.type === 'file' || e.check === 'ok')) },
  keepUntil: keepUntil(m, all),
});

interface State { lastAttemptAt?: string; lastOkAt?: string; lastError?: string | null; lastErrorAt?: string | null; lastRestore?: { id: string; at: string; ok: boolean; error?: string } }
const stateFile = () => path.join(dataRoot(), STATE_FILE);
const readState = (): State => readJson<State>(stateFile()) ?? {};
function patchState(p: Partial<State>) { try { writePrivate(stateFile(), { ...readState(), ...p }); } catch { /* the backup itself matters more */ } }

/** When the next daily backup runs: today 03:00 if not done since, else tomorrow 03:00. */
export function nextDaily(now: Date, lastOkAt: string | null): Date {
  const [h, m] = DAILY_AT.split(':').map(Number);
  const slot = new Date(now); slot.setHours(h, m, 0, 0);
  if (now < slot) slot.setDate(slot.getDate() - 1);
  if (!lastOkAt || new Date(lastOkAt) < slot) return now;
  const next = new Date(slot); next.setDate(next.getDate() + 1);
  return next;
}

export function backupStatus(now: Date = new Date()) {
  const all = manifests();
  const state = readState();
  const folder = backupsFolder();
  return {
    available: true,
    folder, cloud: isCloudFolder(folder), defaultFolder: defaultBackupsFolder(),
    runsAt: DAILY_AT, keeps: { days: KEEP_DAYS, sundays: KEEP_SUNDAYS, beforeUpdateDays: KEEP_UPDATE_DAYS },
    running: !!running,
    last: all[0] ? info(all[0], all) : null,
    next: nextDaily(now, all[0]?.at ?? null).toISOString(),
    lastError: state.lastError && (!state.lastOkAt || (state.lastErrorAt ?? '') > state.lastOkAt) ? { message: state.lastError, at: state.lastErrorAt } : null,
    lastRestore: state.lastRestore ?? null,
    backups: all.map((m) => info(m, all)),
  };
}
export function getBackup(id: string): BackupInfo & { dir: string } {
  if (!ID.test(id)) throw new BackupError(404, 'not_found', 'Backup not found');
  const all = manifests();
  const m = all.find((x) => x.id === id);
  if (!m) throw new BackupError(404, 'not_found', 'Backup not found');
  // The folder name comes from the backup found on disk, never from the request.
  return { ...info(m, all), dir: path.join(workspaceBackupsDir(), m.id) };
}

// --- making one --------------------------------------------------------------------

/** A store of Girru's own: the main database or one on the fixed list, and a real SQLite file. */
function isStore(rootKind: Root, rel: string, src: string): boolean {
  if (rootKind === 'database') return isSqlite(src);
  if (rootKind !== 'data') return false;
  const p = rel.split(path.sep).join('/');
  const known = path.join(path.resolve(dataRoot()), rel) === path.resolve(mainDatabasePath()) || path.join(path.resolve(dataRoot()), rel) === auditPath() || STORES.includes(p);
  return known && isSqlite(src);
}

// --- manifest signature: an HMAC with a key that stays in the data folder, and each stored file's SHA-256 ---
function backupKey(create: boolean): Buffer | null {
  const file = path.join(dataRoot(), KEY_FILE);
  try { const k = fs.readFileSync(file); if (k.length === 32) return k; } catch { /* none yet */ }
  if (!create) return null;
  const k = randomBytes(32);
  fs.writeFileSync(file, k, { mode: 0o600, flag: 'wx' });
  return k;
}
const macOf = (m: Manifest, key: Buffer) => { const { mac: _mac, ...rest } = m; return createHmac('sha256', key).update(JSON.stringify(rest)).digest('hex'); };
function signed(m: Manifest): boolean {
  const key = backupKey(false);
  if (!key || typeof m.mac !== 'string' || !/^[0-9a-f]{64}$/.test(m.mac)) return false;
  return timingSafeEqual(Buffer.from(m.mac, 'hex'), Buffer.from(macOf(m, key), 'hex'));
}
async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}
/** Before a restore: the signature, and every stored file a plain file with its recorded hash. */
async function verified(dir: string, m: Manifest): Promise<string | null> {
  if (!signed(m)) return 'The backup is not signed by this workspace';
  for (const e of m.entries) {
    if (typeof e.sha256 !== 'string') return 'A part of the backup has no checksum';
    const f = path.join(dir, e.root, e.path);
    const st = fs.lstatSync(f, { throwIfNoEntry: false });
    // No links, not even in a parent folder: the real path must stay inside the backup.
    if (!st || !st.isFile() || !inside(f, dir) || !inside(realish(f), realish(dir))) return 'A part of the backup is missing';
    if ((await sha256(f)) !== e.sha256) return 'A part of the backup was changed';
  }
  return null;
}
/** Copy one stored file into the data folder and check exactly those bytes; the restore uses only that copy. */
async function checkedCopy(stored: string, e: Entry, near: string): Promise<string> {
  const st = fs.lstatSync(stored);
  if (!st.isFile()) throw new Error('A part of the backup is not a file');
  const copy = near + '.restoring-src';
  fs.copyFileSync(stored, copy);
  fs.chmodSync(copy, 0o600);
  if ((await sha256(copy)) !== e.sha256) { fs.rmSync(copy, { force: true }); throw new Error('A part of the backup was changed'); }
  return copy;
}

const isSqlite = (file: string) => {
  try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd); return b.toString('latin1') === 'SQLite format 3\0'; } catch { return false; }
};
const SIDE = /-(wal|shm|journal)$|\.tmp$|\.restoring(-src)?$/;
/** Every file to save in a root: regular files only, no symlinks, no SQLite side files. */
function walk(root: string, rootKind: Root): Array<{ rel: string; st: fs.Stats }> {
  if (rootKind === 'config' || rootKind === 'database') return (rootKind === 'config' ? ['.env'] : [path.basename(mainDatabasePath())]).map((rel) => ({ rel, st: fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false }) })).filter((x): x is { rel: string; st: fs.Stats } => !!x.st && x.st.isFile());
  const out: Array<{ rel: string; st: fs.Stats }> = [];
  const visit = (rel: string) => {
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(root, rel)); } catch { return; }
    for (const name of names) {
      const r = rel ? path.join(rel, name) : name;
      if (!rel && rootKind === 'data' && SKIP_TOP.has(name)) continue;
      if (name === 'node_modules' || SIDE.test(name)) continue;
      const st = fs.lstatSync(path.join(root, r));
      if (st.isDirectory()) visit(r);
      else if (st.isFile()) out.push({ rel: r, st });
    }
  };
  visit('');
  return out;
}

async function sqliteCopy(src: string, dest: string): Promise<'ok' | 'failed'> {
  const tmp = dest + '.tmp';
  if (src === path.resolve(mainDatabasePath())) {
    const { getDatabase } = await import('../db/index.js');
    await getDatabase().backup(tmp);
  } else {
    const db = new Database(src, { readonly: true, fileMustExist: true });
    try { await db.backup(tmp); } finally { db.close(); }
  }
  let check: 'ok' | 'failed' = 'failed';
  // The copy keeps the source's journal mode; a plain file needs no -wal/-shm to open later.
  const copy = new Database(tmp, { fileMustExist: true });
  try { copy.pragma('journal_mode = DELETE'); check = (copy.pragma('integrity_check', { simple: true }) as string) === 'ok' ? 'ok' : 'failed'; } finally { copy.close(); }
  await pipeline(fs.createReadStream(tmp), createGzip({ level: 6 }), fs.createWriteStream(dest, { mode: 0o600 }));
  fs.rmSync(tmp, { force: true });
  return check;
}

let running: Promise<BackupInfo> | null = null;

/** Make one backup now. One at a time: a second call waits for the running one. */
export function backUpNow(kind: BackupKind = 'manual', now: Date = new Date()): Promise<BackupInfo> {
  if (!BACKUP_KINDS.includes(kind)) return Promise.reject(new BackupError(400, 'invalid_kind', 'Unknown backup kind'));
  if (running) return running;
  running = make(kind, now).finally(() => { running = null; });
  return running;
}

async function make(kind: BackupKind, now: Date): Promise<BackupInfo> {
  const { dbDriver } = await import('../db/pg/config.js');
  if (dbDriver() === 'postgres') throw new BackupError(501, 'not_supported_on_postgres', 'On PostgreSQL, back up the database with pg_dump outside the app');
  patchState({ lastAttemptAt: new Date().toISOString() });
  const base = workspaceBackupsDir();
  // Two backups in the same second: the second takes the next free second.
  let id = backupId(now, kind);
  for (let i = 1; i < 60 && fs.existsSync(path.join(base, id)); i++) id = backupId(new Date(now.getTime() + i * 1000), kind);
  const dir = path.join(base, id);
  try {
    fs.mkdirSync(path.dirname(base), { recursive: true, mode: 0o700 });
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    fs.chmodSync(base, 0o700);
    if (fs.existsSync(dir)) throw new BackupError(409, 'exists', 'A backup was just made');
    fs.mkdirSync(dir, { mode: 0o700 });
    // Unchanged files link to the last backup only when that backup is signed by this workspace.
    const previous = manifests().find((m) => signed(m));
    const prevDir = previous ? path.join(base, previous.id) : null;
    const prev = new Map(previous?.entries.map((e) => [`${e.root}:${e.path}`, e]) ?? []);
    const entries: Entry[] = [];
    for (const [rootKind, root] of Object.entries(roots()) as Array<[Root, string]>) {
      for (const { rel, st } of walk(root, rootKind)) {
        const src = path.join(root, rel);
        const dest = path.join(dir, rootKind, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        if (isStore(rootKind, rel, src)) {
          let check: 'ok' | 'failed' = 'failed';
          try { check = await sqliteCopy(src, dest); } catch (err) {
            // The main database must be in every backup; another store that cannot be read is noted, not fatal.
            if (isMain({ root: rootKind, path: rel } as Entry)) throw err;
            fs.rmSync(dest, { force: true }); fs.rmSync(dest + '.tmp', { force: true });
            fs.copyFileSync(src, dest); fs.chmodSync(dest, 0o600);
          }
          entries.push({ root: rootKind, path: rel, type: 'sqlite', size: st.size, mtimeMs: st.mtimeMs, stored: fs.statSync(dest).size, sha256: await sha256(dest), check });
          continue;
        }
        const old = prev.get(`${rootKind}:${rel}`);
        let linked = false;
        if (old && prevDir && old.type === 'file' && old.size === st.size && old.mtimeMs === st.mtimeMs) {
          try {
            fs.linkSync(path.join(prevDir, rootKind, rel), dest);
            // The linked bytes must still be the ones the signed backup recorded; otherwise copy from the source.
            linked = !!old.sha256 && fs.lstatSync(dest).isFile() && (await sha256(dest)) === old.sha256;
            if (!linked) fs.rmSync(dest, { force: true });
          } catch { fs.rmSync(dest, { force: true }); }
        }
        if (!linked) { fs.copyFileSync(src, dest); fs.chmodSync(dest, 0o600); }
        entries.push({ root: rootKind, path: rel, type: 'file', size: st.size, mtimeMs: st.mtimeMs, stored: linked ? 0 : st.size, sha256: await sha256(dest) });
      }
    }
    if (!entries.some((e) => isMain(e))) throw new BackupError(500, 'no_database', 'The database was not found');
    const manifest: Manifest = { version: 1, id, kind, at: now.toISOString(), checked: entries.every((e) => e.type === 'file' || e.check === 'ok'), entries };
    manifest.mac = macOf(manifest, backupKey(true)!);
    writePrivate(path.join(dir, MANIFEST), manifest);
    patchState({ lastOkAt: new Date().toISOString(), ...(manifest.checked ? { lastError: null, lastErrorAt: null } : { lastError: 'A part of the backup did not pass its check', lastErrorAt: new Date().toISOString() }) });
    prune(now);
    const all = manifests();
    return info(all.find((m) => m.id === id) ?? manifest, all);
  } catch (err) {
    if (!(err instanceof BackupError && err.code === 'exists')) fs.rmSync(dir, { recursive: true, force: true });
    patchState({ lastError: err instanceof BackupError ? err.message : 'The backup could not be made', lastErrorAt: new Date().toISOString() });
    throw err;
  }
}

/** Retention, plus folders a crashed backup left without a manifest (older than an hour). */
export function prune(now: Date = new Date()): string[] {
  const base = workspaceBackupsDir();
  const all = manifests();
  const gone = expiredBackups(all, now);
  for (const id of gone) fs.rmSync(path.join(base, id), { recursive: true, force: true });
  try {
    for (const n of fs.readdirSync(base)) {
      if (!ID.test(n) || readManifest(path.join(base, n))) continue;
      if (now.getTime() - fs.statSync(path.join(base, n)).mtimeMs > 3_600_000) fs.rmSync(path.join(base, n), { recursive: true, force: true });
    }
  } catch { /* no folder yet */ }
  return gone;
}

/** Delete one backup (the owner, in the app). */
export function deleteBackup(id: string): void {
  const b = getBackup(id);
  fs.rmSync(b.dir, { recursive: true, force: true });
}

// --- the daily job ---------------------------------------------------------------

/** One check (every minute while the background is on): makes the daily backup when it is due. */
export async function runDueBackup(now: Date = new Date()): Promise<boolean> {
  const { dbDriver } = await import('../db/pg/config.js');
  if (dbDriver() === 'postgres' || running) return false;
  const last = manifests()[0]?.at ?? null;
  if (nextDaily(now, last) > now) return false;
  // After a failure, try again once an hour, not every minute.
  const tried = readState().lastAttemptAt;
  if (tried && now.getTime() - new Date(tried).getTime() < 3_600_000 && (!last || tried > last)) return false;
  await backUpNow('daily', now).catch(() => undefined);
  return true;
}

let timer: NodeJS.Timeout | null = null;
export function startDailyBackups(): void {
  if (timer) return;
  timer = setInterval(() => { void runDueBackup().catch(() => false); }, 60_000);
  timer.unref();
  setTimeout(() => { void runDueBackup().catch(() => false); }, 30_000).unref();
}

// --- restore -------------------------------------------------------------------------

/**
 * STORE-MAP-01 P4 (D8): true when backup `id` passed its check, its signed
 * list still verifies, and it holds the data file `rel` (e.g. memory/memory.db)
 * with a passed integrity check. Used before a step deletes that file.
 */
export async function backupHolds(id: string, rel: string): Promise<boolean> {
  const b = getBackup(id);
  if (!b.checked) return false;
  const m = readManifest(b.dir);
  if (!m || m.id !== id || !m.checked || (await verified(b.dir, m))) return false;
  return m.entries.some((e) => e.root === 'data' && e.path.split(/[\\/]/).join('/') === rel && e.check !== 'failed');
}

/** Ask for a restore: back up now, then leave the marker for the next start. The caller restarts. */
export async function requestRestore(id: string): Promise<{ undoId: string }> {
  const b = getBackup(id);
  if (!b.checked) throw new BackupError(409, 'not_checked', 'This backup did not pass its check, so it cannot be restored');
  const m = readManifest(b.dir);
  const bad = m ? await verified(b.dir, m) : 'The backup is missing';
  if (bad) throw new BackupError(409, 'not_verified', `${bad}, so it cannot be restored`);
  const undo = await backUpNow('before-restore');
  writePrivate(path.join(dataRoot(), RESTORE_MARKER), { id: b.id, folder: workspaceBackupsDir(), at: new Date().toISOString() });
  return { undoId: undo.id };
}

async function gunzipTo(src: string, dest: string) {
  await pipeline(fs.createReadStream(src), createGunzip(), fs.createWriteStream(dest, { mode: 0o600 }));
}

/**
 * On start, before any store opens: put a requested backup in place. The marker is
 * removed first, so a restore that fails never repeats. Returns what happened.
 */
export async function applyPendingRestore(): Promise<{ id: string; ok: boolean; error?: string } | null> {
  const marker = path.join(dataRoot(), RESTORE_MARKER);
  const ask = readJson<{ id?: unknown; folder?: unknown }>(marker);
  if (!ask) return null;
  loadBackupsFolderOffline();
  fs.rmSync(marker, { force: true });
  const id = typeof ask.id === 'string' ? ask.id : '';
  const result = (ok: boolean, error?: string) => { patchState({ lastRestore: { id, at: new Date().toISOString(), ok, ...(error ? { error } : {}) } }); return { id, ok, ...(error ? { error } : {}) }; };
  if (!ID.test(id) || typeof ask.folder !== 'string' || path.resolve(ask.folder) !== workspaceBackupsDir()) return result(false, 'The restore request was not valid');
  const dir = path.join(workspaceBackupsDir(), id);
  const m = readManifest(dir);
  if (!m || m.id !== id || !m.checked) return result(false, 'The backup is missing or did not pass its check');
  const bad = await verified(dir, m);
  if (bad) return result(false, bad);
  const where = roots();
  try {
    for (const e of m.entries) {
      const root = where[e.root];
      if (!root || e.root === 'config' || KEEP_ON_RESTORE.has(e.path) || (e.root === 'data' && SKIP_TOP.has(e.path.split(/[\\/]/)[0])) || path.isAbsolute(e.path) || e.path.split(/[\\/]/).includes('..')) continue;
      const target = path.join(root, e.path);
      if (!inside(target, root)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const tmp = target + '.restoring';
      const copy = await checkedCopy(path.join(dir, e.root, e.path), e, target);
      if (e.type === 'sqlite') { await gunzipTo(copy, tmp); fs.rmSync(copy, { force: true }); }
      else fs.renameSync(copy, tmp);
      for (const side of ['-wal', '-shm', '-journal']) fs.rmSync(target + side, { force: true });
      fs.renameSync(tmp, target);
    }
    // Files made after the backup leave (they are in the before-restore backup).
    for (const [rootKind, root] of Object.entries(where) as Array<[Root, string]>) {
      if (rootKind === 'config') continue;
      const saved = new Set(m.entries.filter((e) => e.root === rootKind).map((e) => e.path));
      for (const { rel } of walk(root, rootKind)) if (!saved.has(rel) && !KEEP_ON_RESTORE.has(rel)) fs.rmSync(path.join(root, rel), { force: true });
    }
    return result(true);
  } catch (err) {
    return result(false, err instanceof Error ? err.message.slice(0, 200) : 'The restore failed');
  }
}
