/**
 * Off-site backup destinations (BACKUP-02, slice 3). The owner names one or more
 * places their encrypted backups are copied to — an external drive or a NAS
 * folder today, with SFTP / WebDAV / S3 and the cloud providers slotting into the
 * same adapter shape later. Every destination receives only the encrypted blob
 * from backup-archive.ts, so the place never sees the owner's data (D2, D6: the
 * local folder stays the always-on baseline; these are extra copies).
 *
 *  - The list of places (labels + non-secret settings) lives in app_settings;
 *    any secret a place needs (an SFTP password, an S3 key) goes in the existing
 *    credential vault, referenced by id — never written here.
 *  - A push encrypts the chosen backup once, uploads the blob + its sidecar, then
 *    reads the blob back and checks its hash (remote verify): proof the place kept
 *    the exact ciphertext. Per-place status (last ok, last error, last verify) is
 *    kept in a small state file.
 *  - Retention on the place mirrors the local backups: a blob whose backup no
 *    longer exists locally is removed from the place too.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { pipeline } from 'node:stream/promises';
import { dataRoot, realish } from '../config/data-root.js';
import { BackupError, backupStatus, getBackup, workspaceName } from './backups.js';
import { encryptBackupArchive } from './backup-archive.js';

export type DestinationType = 'folder' | 'sftp' | 'webdav' | 's3' | 'gdrive' | 'dropbox' | 'onedrive';
/** Types the owner can add today; others are shown as "coming" and never faked. */
export const AVAILABLE_TYPES: readonly DestinationType[] = ['folder'];
/** Direct places still to build. */
export const COMING_TYPES: readonly DestinationType[] = ['sftp', 'webdav', 's3'];
/** Cloud places that wait on the Girru Connect sign-in broker (GIRRU-CONNECT-01); the token would live only on the computer. */
export const CLOUD_TYPES: readonly DestinationType[] = ['gdrive', 'dropbox', 'onedrive'];
const ALL_TYPES: readonly DestinationType[] = ['folder', 'sftp', 'webdav', 's3', 'gdrive', 'dropbox', 'onedrive'];

export interface DestinationStatus {
  lastPushAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastVerifiedAt: string | null;
  backups: number;
}
export interface Destination {
  id: string;
  type: DestinationType;
  label: string;
  /** Non-secret settings only (a folder path, an S3 bucket/region). Secrets live in the vault. */
  config: Record<string, string>;
  credentialId: string | null;
  enabled: boolean;
  createdAt: string;
}
export interface DestinationView extends Destination { status: DestinationStatus }

const DEST_KEY = 'backups.destinations';
const STATE_FILE = 'backup-destinations-state.json';
const APP_SETTINGS_SQL = 'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)';
const ID_RE = /^[0-9a-f-]{36}$/i;
const REMOTE_DIR = 'girru-offsite';

const emptyStatus = (): DestinationStatus => ({ lastPushAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, lastVerifiedAt: null, backups: 0 });
const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } };
function writePrivate(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// --- the list of places (app_settings) ---------------------------------------

async function loadDestinations(): Promise<Destination[]> {
  const { q } = await import('../repositories/sql-steps.js');
  const row = await q.one<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', DEST_KEY).catch(() => null);
  const list = row ? readJsonString(row.value) : [];
  return list.filter(isDestination);
}
function readJsonString(s: string): unknown[] { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } }
function isDestination(d: unknown): d is Destination {
  const o = d as Partial<Destination> | null;
  return !!o && typeof o.id === 'string' && typeof o.type === 'string' && ALL_TYPES.includes(o.type as DestinationType)
    && typeof o.label === 'string' && typeof o.config === 'object' && o.config !== null && typeof o.createdAt === 'string';
}
async function saveDestinations(list: Destination[]): Promise<void> {
  const { q } = await import('../repositories/sql-steps.js');
  await q.run(APP_SETTINGS_SQL);
  await q.run('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', DEST_KEY, JSON.stringify(list), Date.now());
}

// --- per-place status (state file) -------------------------------------------

const stateFile = () => path.join(dataRoot(), STATE_FILE);
const readState = (): Record<string, DestinationStatus> => readJson<Record<string, DestinationStatus>>(stateFile()) ?? {};
function patchStatus(id: string, p: Partial<DestinationStatus>) {
  try { const s = readState(); s[id] = { ...emptyStatus(), ...s[id], ...p }; writePrivate(stateFile(), s); } catch { /* the copy itself matters more */ }
}
const statusOf = (id: string): DestinationStatus => readState()[id] ?? emptyStatus();

// --- adapters ----------------------------------------------------------------

/** One place Girru can copy an encrypted blob to and read it back for verification. */
interface Adapter {
  readonly type: DestinationType;
  /** Make the place ready (create the base folder, prove it is writable). */
  ensure(dest: Destination): Promise<void>;
  put(dest: Destination, name: string, localFile: string): Promise<void>;
  get(dest: Destination, name: string, localFile: string): Promise<void>;
  list(dest: Destination): Promise<string[]>;
  remove(dest: Destination, name: string): Promise<void>;
}

/** Create a file that must not already exist and must not be a symlink, and write `write` through it. */
const O_SAFE = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
async function writeNew(file: string, write: (fd: number) => Promise<void> | void): Promise<void> {
  const fd = fs.openSync(file, O_SAFE, 0o600);
  try { await write(fd); } finally { fs.closeSync(fd); }
}

/** A folder on this computer, an external drive or a mounted NAS share. */
const folderAdapter: Adapter = {
  type: 'folder',
  async ensure(dest) {
    const base = folderBase(dest);
    fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    assertRealBase(dest, base);
    // Prove it is writable with a throwaway probe that can neither clobber nor follow a planted link.
    const probe = path.join(base, `.probe-${randomBytes(8).toString('hex')}`);
    try { await writeNew(probe, (fd) => { fs.writeSync(fd, 'ok'); }); } finally { fs.rmSync(probe, { force: true }); }
  },
  async put(dest, name, localFile) {
    const target = folderTarget(dest, name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.uploading-${randomBytes(8).toString('hex')}`;
    try {
      await writeNew(tmp, (fd) => pipeline(fs.createReadStream(localFile), fs.createWriteStream(tmp, { fd, autoClose: false })));
      fs.renameSync(tmp, target); // rename does not follow the final component: a link at `target` is replaced, not written through
    } catch (err) { fs.rmSync(tmp, { force: true }); throw err; }
  },
  async get(dest, name, localFile) {
    // O_NOFOLLOW: a link planted at the stored name is refused rather than read through.
    const src = folderTarget(dest, name);
    const fd = fs.openSync(src, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try { await pipeline(fs.createReadStream(src, { fd, autoClose: false }), fs.createWriteStream(localFile, { mode: 0o600 })); } finally { fs.closeSync(fd); }
  },
  async list(dest) { try { return fs.readdirSync(folderBase(dest)); } catch { return []; } },
  async remove(dest, name) { fs.rmSync(folderTarget(dest, name), { force: true }); },
};

/** The place's backup folder must be a real directory under the chosen folder, never reached through a symlink. */
function assertRealBase(dest: Destination, base: string): void {
  const folder = dest.config.folder;
  try {
    const expected = path.join(fs.realpathSync(folder), REMOTE_DIR, workspaceName());
    if (fs.realpathSync(base) !== expected) throw new BackupError(400, 'invalid_destination', 'The backup folder on the place is not where it should be');
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError(400, 'invalid_destination', 'The backup folder on the place could not be opened');
  }
}

const ADAPTERS: Record<string, Adapter> = { folder: folderAdapter };
function adapterFor(dest: Destination): Adapter {
  const a = ADAPTERS[dest.type];
  if (!a) throw new BackupError(400, 'type_not_ready', `Backups to ${dest.type} are not available yet`);
  return a;
}

/** The folder a place writes into: <chosen folder>/girru-offsite/<workspace>. One workspace never mixes with another. */
function folderBase(dest: Destination): string {
  const folder = dest.config.folder;
  if (!folder) throw new BackupError(400, 'invalid_destination', 'This place has no folder');
  return path.join(folder, REMOTE_DIR, workspaceName());
}
function folderTarget(dest: Destination, name: string): string {
  if (!/^[0-9]{8}-[0-9]{6}-[a-z-]+\.gbk(\.meta\.json)?$/.test(name) && !name.startsWith('.probe-')) throw new BackupError(400, 'invalid_name', 'Bad backup name');
  const base = folderBase(dest);
  const target = path.join(base, name);
  if (!inside(target, base)) throw new BackupError(400, 'invalid_name', 'Bad backup name');
  return target;
}

// --- validation for a new place ----------------------------------------------

function cleanFolder(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 1024) throw new BackupError(400, 'invalid_folder', 'Choose a folder');
  const raw = input.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(raw)) throw new BackupError(400, 'invalid_folder', 'The folder must be a full path');
  const folder = path.resolve(realish(path.resolve(raw)));
  // A place is encrypted, so a cloud-synced folder is allowed; only the data folder is off limits.
  const data = path.resolve(realish(dataRoot()));
  if (inside(folder, data) || inside(data, folder)) throw new BackupError(400, 'invalid_folder', 'Backups must be kept outside the data folder');
  return folder;
}

// --- the owner's actions -----------------------------------------------------

export async function listDestinations(): Promise<DestinationView[]> {
  const list = await loadDestinations();
  return list.map((d) => ({ ...d, status: statusOf(d.id) }));
}

export async function addDestination(input: unknown): Promise<DestinationView> {
  const o = (input ?? {}) as Record<string, unknown>;
  const type = o.type;
  if (type !== 'folder') {
    if (typeof type === 'string' && (CLOUD_TYPES as readonly string[]).includes(type)) throw new BackupError(400, 'needs_connect', 'Cloud backups arrive with Girru Connect sign-in — coming soon');
    if (typeof type === 'string' && (COMING_TYPES as readonly string[]).includes(type)) throw new BackupError(400, 'type_not_ready', `Backups to ${type} are coming soon`);
    throw new BackupError(400, 'invalid_type', 'Unknown place');
  }
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 120) : 'External folder';
  const folder = cleanFolder(o.folder);
  const dest: Destination = { id: uuidv4(), type: 'folder', label, config: { folder }, credentialId: null, enabled: true, createdAt: new Date().toISOString() };
  // Prove it works before saving it, so a broken place is never added.
  await adapterFor(dest).ensure(dest);
  const list = await loadDestinations();
  if (list.some((d) => d.type === 'folder' && d.config.folder === folder)) throw new BackupError(409, 'exists', 'That folder is already a backup place');
  list.push(dest);
  await saveDestinations(list);
  return { ...dest, status: emptyStatus() };
}

export async function removeDestination(id: string): Promise<void> {
  if (!ID_RE.test(id)) throw new BackupError(404, 'not_found', 'Place not found');
  const list = await loadDestinations();
  if (!list.some((d) => d.id === id)) throw new BackupError(404, 'not_found', 'Place not found');
  await saveDestinations(list.filter((d) => d.id !== id));
  // Leave the owner's backups where they are; only forget the place. Drop its status.
  try { const s = readState(); delete s[id]; writePrivate(stateFile(), s); } catch { /* best effort */ }
}

async function getDestination(id: string): Promise<Destination> {
  if (!ID_RE.test(id)) throw new BackupError(404, 'not_found', 'Place not found');
  const d = (await loadDestinations()).find((x) => x.id === id);
  if (!d) throw new BackupError(404, 'not_found', 'Place not found');
  return d;
}

/** Check a place is reachable and writable right now, without sending a backup. */
export async function testDestination(id: string): Promise<{ ok: true }> {
  const dest = await getDestination(id);
  try { await adapterFor(dest).ensure(dest); patchStatus(id, { lastError: null, lastErrorAt: null }); return { ok: true }; }
  catch (err) { const msg = err instanceof Error ? err.message.slice(0, 200) : 'The place could not be reached'; patchStatus(id, { lastError: msg, lastErrorAt: new Date().toISOString() }); throw err instanceof BackupError ? err : new BackupError(502, 'unreachable', msg); }
}

/**
 * Encrypt the chosen backup (or the newest checked one) and copy it to one place,
 * then read it back and check its hash. The place only ever holds ciphertext.
 */
export async function pushToDestination(id: string, backupId?: string): Promise<DestinationView> {
  const dest = await getDestination(id);
  const adapter = adapterFor(dest);
  const target = resolveBackup(backupId);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-offsite-'));
  patchStatus(id, { lastPushAt: new Date().toISOString() });
  try {
    const blob = path.join(staging, `${target.id}.gbk`);
    const meta = await encryptBackupArchive(target.id, target.dir, blob);
    await adapter.ensure(dest);
    await adapter.put(dest, `${target.id}.gbk`, blob);
    await adapter.put(dest, `${target.id}.gbk.meta.json`, `${blob}.meta.json`);
    // Remote verify: read the blob back and confirm the stored bytes are exactly ours.
    const check = path.join(staging, 'verify.gbk');
    await adapter.get(dest, `${target.id}.gbk`, check);
    const got = await fileSha256(check);
    if (got !== meta.cipherSha256) throw new BackupError(502, 'verify_failed', 'The place did not store the backup correctly');
    const kept = await mirrorRetention(dest, adapter);
    patchStatus(id, { lastOkAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString(), lastError: null, lastErrorAt: null, backups: kept });
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : 'The backup could not be sent';
    patchStatus(id, { lastError: msg, lastErrorAt: new Date().toISOString() });
    throw err instanceof BackupError ? err : new BackupError(502, 'push_failed', msg);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return { ...dest, status: statusOf(id) };
}

/** A place keeps the same backups the computer keeps: remove blobs whose backup is gone locally. */
async function mirrorRetention(dest: Destination, adapter: Adapter): Promise<number> {
  const local = new Set(listLocalBackupIds());
  const names = await adapter.list(dest);
  const ids = new Set<string>();
  for (const name of names) {
    const m = /^([0-9]{8}-[0-9]{6}-[a-z-]+)\.gbk$/.exec(name);
    if (!m) continue;
    ids.add(m[1]);
    if (!local.has(m[1])) {
      await adapter.remove(dest, name).catch(() => undefined);
      await adapter.remove(dest, `${name}.meta.json`).catch(() => undefined);
      ids.delete(m[1]);
    }
  }
  return ids.size;
}

function listLocalBackupIds(): string[] {
  const s = backupStatus();
  return 'backups' in s ? s.backups.map((b) => b.id) : [];
}

/** The backup to send: the one asked for, else the newest that passed its check. */
function resolveBackup(backupId?: string): { id: string; dir: string } {
  if (backupId) { const b = getBackup(backupId); if (!b.checked) throw new BackupError(409, 'not_checked', 'This backup did not pass its check'); return { id: b.id, dir: b.dir }; }
  const s = backupStatus();
  const newest = 'backups' in s ? s.backups.find((b) => b.checked) : undefined;
  if (!newest) throw new BackupError(409, 'no_backup', 'There is no checked backup to send yet');
  return { id: newest.id, dir: getBackup(newest.id).dir };
}

async function fileSha256(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}
