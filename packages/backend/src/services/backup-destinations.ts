/**
 * Off-site backup destinations (BACKUP-02, slices 3–4). The owner names one or
 * more places their encrypted backups are copied to — an external drive or a
 * NAS folder, an SFTP server, a WebDAV share, or S3-compatible object storage.
 * The cloud providers (Drive / Dropbox / OneDrive) slot into the same adapter
 * shape later, once the Girru Connect sign-in broker exists. Every destination
 * receives only the encrypted blob from backup-archive.ts, so the place never
 * sees the owner's data, keys, or any secret in clear (D2, D6: the local folder
 * stays the always-on baseline; these are extra copies).
 *
 *  - The list of places (labels + non-secret settings) lives in app_settings;
 *    any secret a place needs (an SFTP password or key, a WebDAV password, an
 *    S3 secret key) goes in the existing credential vault, referenced by id —
 *    never written into the destinations list or returned to the page.
 *  - A push encrypts the chosen backup once, uploads the blob + its sidecar,
 *    then reads the blob back and checks its hash (remote verify): proof the
 *    place kept the exact ciphertext. Per-place status (last ok, last error,
 *    last verify) is kept in a small state file.
 *  - Retention on the place mirrors the local backups: a blob whose backup no
 *    longer exists locally is removed from the place too.
 *
 * The network transports (HTTP for WebDAV/S3, SFTP over ssh2) live behind one
 * seam, so a test swaps in in-memory fakes and no socket is ever opened.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { pipeline } from 'node:stream/promises';
import { dataRoot, realish } from '../config/data-root.js';
import { BackupError, backupStatus, getBackup, workspaceName } from './backups.js';
import { encryptBackupArchive } from './backup-archive.js';
import { getCredentialVault } from '../encryption/credential-vault.js';
import { nodeHttpTransport, readText, drain, type HttpTransport } from './net/http-client.js';
import { ssh2SftpTransport, type SftpTransport } from './net/sftp-client.js';
import { signS3, encodePath, rfc3986, EMPTY_SHA256, UNSIGNED_PAYLOAD } from './net/s3-sigv4.js';

export type DestinationType = 'folder' | 'sftp' | 'webdav' | 's3' | 'gdrive' | 'dropbox' | 'onedrive';
/** Types the owner can add today; others are shown as "coming" and never faked. */
export const AVAILABLE_TYPES: readonly DestinationType[] = ['folder', 'sftp', 'webdav', 's3'];
/** Direct places still to build (none left). */
export const COMING_TYPES: readonly DestinationType[] = [];
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
/** A backup blob or its sidecar; the only names a place ever holds (plus a throwaway probe). */
const NAME_RE = /^[0-9]{8}-[0-9]{6}-[a-z-]+\.gbk(\.meta\.json)?$/;
function assertName(name: string): string {
  if (!NAME_RE.test(name) && !name.startsWith('.probe-')) throw new BackupError(400, 'invalid_name', 'Bad backup name');
  return name;
}

// --- the network transports, behind one swappable seam -----------------------

interface RemoteTransports { http: HttpTransport; sftp: SftpTransport }
let TRANSPORTS: RemoteTransports = { http: nodeHttpTransport, sftp: ssh2SftpTransport };
/** Test seam: replace the real network transports with in-memory fakes. Not used in production. */
export function __setRemoteTransports(t: Partial<RemoteTransports>): void { TRANSPORTS = { ...TRANSPORTS, ...t }; }

const emptyStatus = (): DestinationStatus => ({ lastPushAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, lastVerifiedAt: null, backups: 0 });
const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } };
function writePrivate(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const inside = (child: string, parent: string) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// --- the credential vault (secrets a remote place needs) ---------------------

async function vault() { const v = getCredentialVault(); if (!v.rows) await v.initialize(); return v; }
async function storeSecret(ownerId: string, destId: string, secret: Record<string, string>): Promise<string> {
  const v = await vault();
  const cred = await v.store({ name: `backup-destination:${destId}`, type: 'secret', data: secret, service: 'backup-destination', ownerId: ownerId || 'girru-backups', ownerType: ownerId ? 'user' : 'system' });
  return cred.id;
}
async function credsFor(dest: Destination): Promise<Record<string, string>> {
  if (!dest.credentialId) return {};
  try { const got = await (await vault()).retrieve(dest.credentialId); return (got?.data ?? {}) as Record<string, string>; }
  catch { throw new BackupError(502, 'no_credentials', 'This place’s sign-in could not be read'); }
}
async function forgetSecret(credentialId: string | null) {
  if (!credentialId) return;
  try { await (await vault()).delete(credentialId); } catch { /* best effort */ }
}

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

/** The folder a place writes into: <chosen folder>/girru-offsite/<workspace>. One workspace never mixes with another. */
function folderBase(dest: Destination): string {
  const folder = dest.config.folder;
  if (!folder) throw new BackupError(400, 'invalid_destination', 'This place has no folder');
  return path.join(folder, REMOTE_DIR, workspaceName());
}
function folderTarget(dest: Destination, name: string): string {
  assertName(name);
  const base = folderBase(dest);
  const target = path.join(base, name);
  if (!inside(target, base)) throw new BackupError(400, 'invalid_name', 'Bad backup name');
  return target;
}

// --- remote helpers (shared by the HTTP and SFTP adapters) -------------------

/** The path segments every remote place nests its blobs under. */
const remoteParts = (): string[] => [REMOTE_DIR, workspaceName()];

/** Prove a remote place is writable: put a throwaway probe and remove it. */
async function remoteProbe(adapter: Adapter, dest: Destination): Promise<void> {
  const name = `.probe-${randomBytes(8).toString('hex')}`;
  const tmp = path.join(os.tmpdir(), `girru-probe-${randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, 'ok', { mode: 0o600 });
  try { await adapter.put(dest, name, tmp); await adapter.remove(dest, name); } finally { fs.rmSync(tmp, { force: true }); }
}
async function saveStreamTo(body: Readable, localFile: string): Promise<void> {
  await pipeline(body, fs.createWriteStream(localFile, { mode: 0o600 }));
}

// --- WebDAV adapter (our own HTTP, https enforced off loopback) --------------

function webdavAuth(dest: Destination, creds: Record<string, string>): Record<string, string> {
  const user = dest.config.username ?? '';
  const pass = creds.password ?? '';
  return user || pass ? { authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') } : {};
}
const trimSlash = (s: string) => s.replace(/\/+$/, '');
function webdavBaseUrl(dest: Destination): string {
  let u = trimSlash(dest.config.url);
  for (const s of remoteParts()) u += '/' + encodeURIComponent(s);
  return u;
}
function webdavObjUrl(dest: Destination, name: string): string { return webdavBaseUrl(dest) + '/' + encodeURIComponent(assertName(name)); }
async function webdavSend(dest: Destination, method: string, url: string, opts: { bodyFile?: string; bodyText?: string; headers?: Record<string, string> } = {}) {
  const creds = await credsFor(dest);
  const headers = { ...webdavAuth(dest, creds), ...(opts.headers ?? {}) };
  let body: Readable | undefined; let contentLength: number | undefined;
  if (opts.bodyFile) { body = fs.createReadStream(opts.bodyFile); contentLength = fs.statSync(opts.bodyFile).size; }
  else if (opts.bodyText != null) { body = Readable.from(Buffer.from(opts.bodyText)); contentLength = Buffer.byteLength(opts.bodyText); }
  return TRANSPORTS.http.send({ method, url, headers, body, contentLength });
}
const ok2xx = (s: number) => s >= 200 && s < 300;

const webdavAdapter: Adapter = {
  type: 'webdav',
  async ensure(dest) {
    // Create girru-offsite and the workspace collection, parents first.
    let u = trimSlash(dest.config.url);
    for (const s of remoteParts()) {
      u += '/' + encodeURIComponent(s);
      const res = await webdavSend(dest, 'MKCOL', u);
      await drain(res.body);
      if (!ok2xx(res.status) && res.status !== 405 && res.status !== 301) {
        throw new BackupError(res.status === 401 ? 401 : 502, 'place_error', `The WebDAV place refused to make its folder (${res.status})`);
      }
    }
    await remoteProbe(webdavAdapter, dest);
  },
  async put(dest, name, localFile) {
    const res = await webdavSend(dest, 'PUT', webdavObjUrl(dest, name), { bodyFile: localFile });
    await drain(res.body);
    if (!ok2xx(res.status)) throw new BackupError(502, 'place_error', `The WebDAV place did not accept the backup (${res.status})`);
  },
  async get(dest, name, localFile) {
    const res = await webdavSend(dest, 'GET', webdavObjUrl(dest, name));
    if (res.status === 404) { await drain(res.body); throw new BackupError(404, 'not_on_place', 'The backup is not on the place'); }
    if (!ok2xx(res.status)) { await drain(res.body); throw new BackupError(502, 'place_error', `The WebDAV place could not return the backup (${res.status})`); }
    await saveStreamTo(res.body, localFile);
  },
  async list(dest) {
    const res = await webdavSend(dest, 'PROPFIND', webdavBaseUrl(dest) + '/', { bodyText: '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>', headers: { depth: '1', 'content-type': 'application/xml' } });
    if (!ok2xx(res.status)) { await drain(res.body); return []; }
    const xml = await readText(res.body, 1 << 20);
    const hrefs = [...xml.matchAll(/<[^>]*href>([^<]+)<\/[^>]*href>/gi)].map((m) => m[1]);
    const names = hrefs.map((h) => { let d = h; try { d = decodeURIComponent(h); } catch { /* keep raw */ } return trimSlash(d).split('/').pop() ?? ''; });
    return names.filter((n) => NAME_RE.test(n));
  },
  async remove(dest, name) {
    const res = await webdavSend(dest, 'DELETE', webdavObjUrl(dest, name));
    await drain(res.body);
    if (!ok2xx(res.status) && res.status !== 404) throw new BackupError(502, 'place_error', `The WebDAV place could not remove a backup (${res.status})`);
  },
};

// --- S3-compatible adapter (our own SigV4, path-style) -----------------------

function s3Prefix(dest: Destination): string {
  const p = dest.config.prefix ? dest.config.prefix.replace(/^\/+|\/+$/g, '') + '/' : '';
  return `${p}${REMOTE_DIR}/${workspaceName()}/`;
}
const s3Key = (dest: Destination, name: string) => s3Prefix(dest) + assertName(name);
async function s3Send(dest: Destination, method: string, opts: { key?: string; query?: Record<string, string>; payloadSha256: string; bodyFile?: string }) {
  const u = new URL(dest.config.endpoint);
  const bucket = dest.config.bucket;
  const creds = await credsFor(dest);
  const canonicalUri = '/' + encodePath(opts.key != null ? `${bucket}/${opts.key}` : bucket);
  const signed = signS3({ method, host: u.host, canonicalUri, query: opts.query, region: dest.config.region || 'us-east-1', accessKeyId: dest.config.accessKeyId, secretAccessKey: creds.secretAccessKey ?? '', payloadSha256: opts.payloadSha256 });
  let url = `${u.protocol}//${u.host}${canonicalUri}`;
  if (opts.query && Object.keys(opts.query).length) url += '?' + Object.keys(opts.query).sort().map((k) => `${rfc3986(k)}=${rfc3986(opts.query![k])}`).join('&');
  let body: Readable | undefined; let contentLength: number | undefined;
  if (opts.bodyFile) { body = fs.createReadStream(opts.bodyFile); contentLength = fs.statSync(opts.bodyFile).size; }
  return TRANSPORTS.http.send({ method, url, headers: signed, body, contentLength });
}
const s3AuthMsg = (s: number) => s === 403 || s === 401 ? 'The S3 place refused the sign-in' : `The S3 place returned an error (${s})`;

const s3Adapter: Adapter = {
  type: 's3',
  async ensure(dest) { await remoteProbe(s3Adapter, dest); },
  async put(dest, name, localFile) {
    const res = await s3Send(dest, 'PUT', { key: s3Key(dest, name), payloadSha256: UNSIGNED_PAYLOAD, bodyFile: localFile });
    await drain(res.body);
    if (!ok2xx(res.status)) throw new BackupError(res.status === 403 ? 403 : 502, 'place_error', s3AuthMsg(res.status));
  },
  async get(dest, name, localFile) {
    const res = await s3Send(dest, 'GET', { key: s3Key(dest, name), payloadSha256: EMPTY_SHA256 });
    if (res.status === 404) { await drain(res.body); throw new BackupError(404, 'not_on_place', 'The backup is not on the place'); }
    if (!ok2xx(res.status)) { await drain(res.body); throw new BackupError(502, 'place_error', s3AuthMsg(res.status)); }
    await saveStreamTo(res.body, localFile);
  },
  async list(dest) {
    const res = await s3Send(dest, 'GET', { query: { 'list-type': '2', prefix: s3Prefix(dest) }, payloadSha256: EMPTY_SHA256 });
    if (!ok2xx(res.status)) { await drain(res.body); return []; }
    const xml = await readText(res.body, 1 << 20);
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/gi)].map((m) => m[1]);
    const names = keys.map((k) => { let d = k; try { d = decodeURIComponent(k); } catch { /* keep raw */ } return d.split('/').pop() ?? ''; });
    return names.filter((n) => NAME_RE.test(n));
  },
  async remove(dest, name) {
    const res = await s3Send(dest, 'DELETE', { key: s3Key(dest, name), payloadSha256: EMPTY_SHA256 });
    await drain(res.body);
    if (!ok2xx(res.status) && res.status !== 404) throw new BackupError(502, 'place_error', s3AuthMsg(res.status));
  },
};

// --- SFTP adapter (ssh2, host-key pinned) ------------------------------------

function sftpRemoteDir(dest: Destination): string {
  const root = trimSlash(dest.config.path ?? '');
  return (root ? root + '/' : '') + remoteParts().join('/');
}
const sftpRemotePath = (dest: Destination, name: string) => sftpRemoteDir(dest) + '/' + assertName(name);
async function sftpConnect(dest: Destination) {
  const creds = await credsFor(dest);
  const { session, hostKey } = await TRANSPORTS.sftp.connect({
    host: dest.config.host, port: Number(dest.config.port || 22), username: dest.config.username,
    ...(creds.password ? { password: creds.password } : {}),
    ...(creds.privateKey ? { privateKey: creds.privateKey } : {}),
    ...(creds.passphrase ? { passphrase: creds.passphrase } : {}),
    ...(dest.config.hostKeyHash ? { pinnedHostKey: dest.config.hostKeyHash } : {}),
  }).catch((e: unknown) => { throw new BackupError(502, 'unreachable', e instanceof Error ? e.message.slice(0, 160) : 'The SFTP place could not be reached'); });
  // First connection: pin the host key so a later swap is refused.
  if (!dest.config.hostKeyHash && hostKey) dest.config.hostKeyHash = hostKey;
  return session;
}

const sftpAdapter: Adapter = {
  type: 'sftp',
  async ensure(dest) {
    const s = await sftpConnect(dest);
    try { await s.mkdirp(sftpRemoteDir(dest)); } finally { await s.close(); }
    await remoteProbe(sftpAdapter, dest);
  },
  async put(dest, name, localFile) {
    const s = await sftpConnect(dest);
    try { await s.mkdirp(sftpRemoteDir(dest)); await s.put(sftpRemotePath(dest, name), localFile); }
    catch (e) { throw new BackupError(502, 'place_error', e instanceof Error ? e.message.slice(0, 160) : 'The SFTP place did not accept the backup'); }
    finally { await s.close(); }
  },
  async get(dest, name, localFile) {
    const s = await sftpConnect(dest);
    try { await s.get(sftpRemotePath(dest, name), localFile); }
    catch (e) { throw new BackupError(404, 'not_on_place', e instanceof Error ? e.message.slice(0, 160) : 'The backup is not on the place'); }
    finally { await s.close(); }
  },
  async list(dest) {
    const s = await sftpConnect(dest);
    try { return (await s.list(sftpRemoteDir(dest))).filter((n) => NAME_RE.test(n)); }
    catch { return []; }
    finally { await s.close(); }
  },
  async remove(dest, name) {
    const s = await sftpConnect(dest);
    try { await s.remove(sftpRemotePath(dest, name)); } catch { /* already gone */ } finally { await s.close(); }
  },
};

const ADAPTERS: Record<string, Adapter> = { folder: folderAdapter, sftp: sftpAdapter, webdav: webdavAdapter, s3: s3Adapter };
function adapterFor(dest: Destination): Adapter {
  const a = ADAPTERS[dest.type];
  if (!a) throw new BackupError(400, 'type_not_ready', `Backups to ${dest.type} are not available yet`);
  return a;
}

// --- validation for a new place ----------------------------------------------

const reqStr = (v: unknown, field: string, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new BackupError(400, `invalid_${field}`, `Fill in the ${field}`);
  return v.trim();
};
const optStr = (v: unknown, field: string, max: number): string => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > max) throw new BackupError(400, `invalid_${field}`, `The ${field} is not valid`);
  return v.trim();
};
const optSecret = (v: unknown, max: number, field: string): string => {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > max) throw new BackupError(400, `invalid_${field}`, `The ${field} is not valid`);
  return v;
};
function cleanPort(v: unknown): number {
  if (v === undefined || v === null || v === '') return 22;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new BackupError(400, 'invalid_port', 'The port must be between 1 and 65535');
  return n;
}
/** Only https, except to a loopback host, so a place’s sign-in is never sent in the clear. */
function requireSecureUrl(raw: string, field: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new BackupError(400, `invalid_${field}`, 'The address is not a valid URL'); }
  const h = u.hostname;
  const loopback = h === '127.0.0.1' || h === '::1' || h === 'localhost' || h.endsWith('.localhost');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new BackupError(400, 'insecure', 'Use an https address so your sign-in is protected');
  return u;
}

interface Built { config: Record<string, string>; secret: Record<string, string> | null; dupKey: string }

function cleanFolderInput(input: Record<string, unknown>): Built {
  const folder = cleanFolder(input.folder);
  return { config: { folder }, secret: null, dupKey: folder };
}
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
function cleanSftpInput(o: Record<string, unknown>): Built {
  const host = reqStr(o.host, 'host', 255);
  if (/\s/.test(host)) throw new BackupError(400, 'invalid_host', 'The host is not valid');
  const port = cleanPort(o.port);
  const username = reqStr(o.username, 'username', 128);
  const dir = optStr(o.path, 'path', 1024).replace(/^\/+|\/+$/g, '');
  if (/(^|\/)\.\.(\/|$)/.test(dir)) throw new BackupError(400, 'invalid_path', 'The folder is not valid');
  const password = optSecret(o.password, 1024, 'password');
  const privateKey = optSecret(o.privateKey, 1 << 14, 'privateKey');
  const passphrase = optSecret(o.passphrase, 1024, 'passphrase');
  if (!password && !privateKey) throw new BackupError(400, 'no_secret', 'Give a password or a private key');
  const secret: Record<string, string> = {};
  if (password) secret.password = password;
  if (privateKey) secret.privateKey = privateKey;
  if (passphrase) secret.passphrase = passphrase;
  return { config: { host, port: String(port), username, ...(dir ? { path: dir } : {}) }, secret, dupKey: `${username}@${host}:${port}/${dir}` };
}
function cleanWebdavInput(o: Record<string, unknown>): Built {
  const u = requireSecureUrl(reqStr(o.url, 'url', 1024), 'url');
  const username = reqStr(o.username, 'username', 128);
  const password = optSecret(o.password, 1024, 'password');
  if (!password) throw new BackupError(400, 'no_secret', 'Give the password');
  const url = trimSlash(u.toString());
  return { config: { url, username }, secret: { password }, dupKey: url };
}
function cleanS3Input(o: Record<string, unknown>): Built {
  let ep = reqStr(o.endpoint, 'endpoint', 1024);
  if (!/^https?:\/\//i.test(ep)) ep = 'https://' + ep;
  const u = requireSecureUrl(ep, 'endpoint');
  const region = optStr(o.region, 'region', 64) || 'us-east-1';
  if (!/^[a-z0-9-]+$/i.test(region)) throw new BackupError(400, 'invalid_region', 'The region is not valid');
  const bucket = reqStr(o.bucket, 'bucket', 63);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i.test(bucket)) throw new BackupError(400, 'invalid_bucket', 'The bucket name is not valid');
  const prefix = optStr(o.prefix, 'prefix', 512).replace(/^\/+|\/+$/g, '');
  if (/(^|\/)\.\.(\/|$)/.test(prefix)) throw new BackupError(400, 'invalid_prefix', 'The prefix is not valid');
  const accessKeyId = reqStr(o.accessKeyId, 'accessKeyId', 128);
  const secretAccessKey = optSecret(o.secretAccessKey, 1024, 'secretAccessKey');
  if (!secretAccessKey) throw new BackupError(400, 'no_secret', 'Give the secret key');
  return { config: { endpoint: u.origin, region, bucket, ...(prefix ? { prefix } : {}), accessKeyId }, secret: { secretAccessKey }, dupKey: `${u.origin}/${bucket}/${prefix}` };
}

function buildInput(type: DestinationType, o: Record<string, unknown>): Built {
  switch (type) {
    case 'folder': return cleanFolderInput(o);
    case 'sftp': return cleanSftpInput(o);
    case 'webdav': return cleanWebdavInput(o);
    case 's3': return cleanS3Input(o);
    default: throw new BackupError(400, 'invalid_type', 'Unknown place');
  }
}
/** The same key the input builders compute, from a stored place, to catch duplicates. */
function dupKeyOf(d: Destination): string {
  const c = d.config;
  switch (d.type) {
    case 'folder': return c.folder ?? '';
    case 'sftp': return `${c.username}@${c.host}:${c.port || 22}/${(c.path ?? '')}`;
    case 'webdav': return trimSlash(c.url ?? '');
    case 's3': return `${c.endpoint}/${c.bucket}/${c.prefix ?? ''}`;
    default: return d.id;
  }
}
const DEFAULT_LABEL: Record<string, string> = { folder: 'External folder', sftp: 'SFTP server', webdav: 'WebDAV', s3: 'S3 storage' };

// --- the owner's actions -----------------------------------------------------

export async function listDestinations(): Promise<DestinationView[]> {
  const list = await loadDestinations();
  return list.map((d) => ({ ...d, status: statusOf(d.id) }));
}

export async function addDestination(input: unknown, ownerId = ''): Promise<DestinationView> {
  const o = (input ?? {}) as Record<string, unknown>;
  const type = o.type;
  if (typeof type === 'string' && (CLOUD_TYPES as readonly string[]).includes(type)) throw new BackupError(400, 'needs_connect', 'Cloud backups arrive with Girru Connect sign-in — coming soon');
  if (!(typeof type === 'string' && (AVAILABLE_TYPES as readonly string[]).includes(type))) {
    if (typeof type === 'string' && (COMING_TYPES as readonly string[]).includes(type)) throw new BackupError(400, 'type_not_ready', `Backups to ${type} are coming soon`);
    throw new BackupError(400, 'invalid_type', 'Unknown place');
  }
  const kind = type as DestinationType;
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim().slice(0, 120) : (DEFAULT_LABEL[kind] ?? 'Backup place');
  const built = buildInput(kind, o);

  const list = await loadDestinations();
  if (list.some((d) => d.type === kind && dupKeyOf(d) === built.dupKey)) throw new BackupError(409, 'exists', 'That place is already added');

  const id = uuidv4();
  const credentialId = built.secret && Object.keys(built.secret).length ? await storeSecret(ownerId, id, built.secret) : null;
  const dest: Destination = { id, type: kind, label, config: built.config, credentialId, enabled: true, createdAt: new Date().toISOString() };
  // Prove it works before saving it, so a broken place is never added. ensure may
  // record the SFTP host key fingerprint into dest.config so it is pinned from now on.
  try { await adapterFor(dest).ensure(dest); }
  catch (err) { await forgetSecret(credentialId); throw err; }
  list.push(dest);
  await saveDestinations(list);
  return { ...dest, status: emptyStatus() };
}

export async function removeDestination(id: string): Promise<void> {
  if (!ID_RE.test(id)) throw new BackupError(404, 'not_found', 'Place not found');
  const list = await loadDestinations();
  const found = list.find((d) => d.id === id);
  if (!found) throw new BackupError(404, 'not_found', 'Place not found');
  await saveDestinations(list.filter((d) => d.id !== id));
  // Leave the owner's backups where they are; only forget the place, its secret and its status.
  await forgetSecret(found.credentialId);
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
