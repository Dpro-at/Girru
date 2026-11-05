/**
 * Adding and removing apps from the Girru Store (APPS-06 step 2, board Apps6).
 *
 * Add (one job the window follows): get every file of the app's package from the
 * repository, check each against the size and checksum the reviewed index lists, put
 * them in the data folder (never the program folder), run only the app's own
 * migrations, turn it on, and start Girru again so its page and tools load.
 * An app may only make tables named after itself (<id>_...), so removing it can
 * never touch Girru's own data. Remove: when its tables hold rows, the owner is asked
 * once and Girru saves a copy of them first (next to the backups); adding the app
 * again brings that copy back. SQLite only, like every extension.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { installedAppsRoot, installedAppDir } from '../config/backend-root.js';
import { readStoreRepo, storeBase, type StorePackage } from './store-repo.js';
import type {RuntimeFetch} from './code-runtime.js';
import { workspaceBackupsDir } from './backups.js';

export type AddStep = 'getting' | 'checking' | 'setting-up' | 'adding';
export interface AddJob { id: string; app: string; step: AddStep; done: boolean; ok?: boolean; message?: string; restart?: 'auto' | 'manual' | 'none'; /** CODE-STORE-01: bytes of a large download so far, and in all. */ received?: number; total?: number }
const jobs = new Map<string, AddJob>();
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // no "--", no trailing "-": table prefixes can never overlap
const KEY = (id: string) => `store.installed.${id}`;
const prefixOf = (id: string) => `app_${id.replace(/-/g, '_')}__`;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
export type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

async function sql() {
  const { getDatabase } = await import('../db/index.js');
  return getDatabase().getDb() as { prepare(s: string): { get(...a: unknown[]): any; all(...a: unknown[]): any[]; run(...a: unknown[]): unknown }; exec(s: string): void; transaction<T>(fn: () => T): () => T };
}
const ensureSettings = (db: Awaited<ReturnType<typeof sql>>) => db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');

/** Apps added from the Store, with their version. */
export async function installedApps(): Promise<Record<string, { version: string; installedAt: string; source: 'store' | 'private'; name?: string }>> {
  try {
    // Reading never makes a table: no settings table yet means nothing was added.
    const db = await sql();
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'").get()) return {};
    const out: Record<string, { version: string; installedAt: string; source: 'store' | 'private'; name?: string }> = {};
    for (const r of db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'store.installed.%'").all() as Array<{ key: string; value: string }>) {
      try { const v = JSON.parse(r.value); out[r.key.slice('store.installed.'.length)] = { version: String(v.version), installedAt: String(v.installedAt), source: v.source === 'private' ? 'private' : 'store', ...(typeof v.name === 'string' ? { name: v.name } : {}) }; } catch { /* skip */ }
    }
    return out;
  } catch { return {}; }
}

/** SQL statements, split on ";" outside quotes, with comments removed. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '', quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; cur += ' '; continue; }
    if (c === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 1; cur += ' '; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') { quote = c === '[' ? ']' : c; cur += c; continue; }
    if (c === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (quote) throw new Error('a migration has an unclosed quote');
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const NAME = String.raw`(?:"([A-Za-z_][A-Za-z0-9_]*)"|\x60([A-Za-z_][A-Za-z0-9_]*)\x60|\[([A-Za-z_][A-Za-z0-9_]*)\]|([A-Za-z_][A-Za-z0-9_]*))`;
const CREATE_TABLE = new RegExp(String.raw`^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+${NAME}\s*\(`, 'i');
const CREATE_INDEX = new RegExp(String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+${NAME}\s+ON\s+${NAME}\s*\(`, 'i');
const nameOf = (m: RegExpExecArray, at: number) => (m[at] ?? m[at + 1] ?? m[at + 2] ?? m[at + 3]).toLowerCase();
/**
 * The tables an app's migrations make. Deny by default: every statement must be
 * CREATE TABLE IF NOT EXISTS or CREATE [UNIQUE] INDEX IF NOT EXISTS, and every name
 * (table, index, indexed table) must start with app_<id>__ — so an app can never
 * drop, change, read into or write to Girru's own tables.
 */
export function appTables(id: string, sqlFiles: string[]): string[] {
  const prefix = prefixOf(id), tables = new Set<string>();
  for (const text of sqlFiles) {
    for (const st of statements(text)) {
      const t = CREATE_TABLE.exec(st), x = t ? null : CREATE_INDEX.exec(st);
      if (!t && !x) throw new Error(`a migration does more than make its own tables (${st.slice(0, 40)}…)`);
      const names = t ? [nameOf(t, 1)] : [nameOf(x!, 1), nameOf(x!, 5)];
      for (const n of names) if (!n.startsWith(prefix)) throw new Error(`it makes a table (${n}) that is not named after it`);
      if (t) tables.add(names[0]);
    }
  }
  return [...tables];
}
const migrationFiles = (dir: string) => { const m = path.join(dir, 'migrations'); return fs.existsSync(m) ? fs.readdirSync(m).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(m, f)) : []; };

export function addJob(job: string): AddJob | null { return jobs.get(job) ?? null; }

/** Start adding a Store app; the window follows the job. */
export function startAdd(app: string, options: { fetch?: Fetch; runtimeFetch?:RuntimeFetch; restart?: () => boolean; onDone?: (job: AddJob) => void } = {}): AddJob {
  if(app==='agent-connect'){const active=[...jobs.values()].find(j=>j.app===app&&!j.done);if(active)return active;}
  return trackJob(app, (job) => add(job, options), options.onDone);
}

/** One job the window follows (Store apps, and the Code runtime of CODE-STORE-01): the same steps, one map. */
export function trackJob(app: string, run: (job: AddJob) => Promise<void>, onDone?: (job: AddJob) => void): AddJob {
  const job: AddJob = { id: randomUUID(), app, step: 'getting', done: false };
  jobs.set(job.id, job);
  setTimeout(() => jobs.delete(job.id), 3_600_000).unref?.();
  void run(job)
    .catch((error: unknown) => Object.assign(job, { done: true, ok: false, message: `It could not be added: ${error instanceof Error ? error.message : 'unknown error'}.` }))
    .finally(() => onDone?.(job));
  return job;
}

/** A package file path: plain relative segments of letters, digits, '.', '_' and '-' (no absolute paths, no backslashes). */
const SAFE_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

async function add(job: AddJob, { fetch: get = globalThis.fetch as unknown as Fetch, runtimeFetch, restart }: { fetch?: Fetch; runtimeFetch?:RuntimeFetch; restart?: () => boolean }) {
  const id = job.app;
  if (!ID.test(id)) throw new Error('unknown app');
  const repo = await readStoreRepo();
  const pkg: StorePackage | undefined = repo.packages?.[`girru:${id}`];
  const item = repo.index?.items.find((x) => x.id === `girru:${id}`);
  if (!item || !pkg) throw new Error('it is not in the Girru Store any more');
  if ((await installedApps())[id]?.source === 'private') throw new Error('you have a private app with the same name; remove it in My apps first');
  // 1. The reviewed file list must match its checksum and name only plain relative paths before anything is fetched.
  if (sha(JSON.stringify(pkg.files)) !== pkg.sha256) throw new Error('the package list does not match its checksum');
  if (!pkg.files.every((f) => SAFE_PATH.test(f.path) && !f.path.split('/').some((part) => part === '.' || part === '..'))) throw new Error('a file path leaves the app folder');
  // 2. Get every file, checked in memory against the reviewed size and sha256 before anything is written.
  const files: Array<{ path: string; bytes: Buffer }> = [];
  for (const f of pkg.files) {
    const res = await get(`${storeBase()}/apps/${id}/package/${f.path}`, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Girru' } });
    if (!res.ok) throw new Error(`the Girru Store answered ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length !== f.size || sha(bytes) !== f.sha256) throw new Error('a file is not what the Girru Store reviewed; try again later');
    files.push({ path: f.path, bytes });
  }
  // 3. Check that it is this app.
  job.step = 'checking';
  const plugin = JSON.parse(files.find((f) => f.path === 'agentplayer.plugin.json')!.bytes.toString('utf8')) as { id?: unknown; version?: unknown; main?: unknown };
  if (plugin.id !== id || plugin.version !== item.version || typeof plugin.main !== 'string' || !files.some((f) => f.path === plugin.main)) throw new Error('the package is not this app');
  const checkedMigrations = files.filter((f) => f.path.startsWith('migrations/') && f.path.endsWith('.sql'));
  const tables = appTables(id, checkedMigrations.map((f) => f.bytes.toString('utf8')));
  const migrations = checkedMigrations.filter((f) => f.path.split('/').length === 2)
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // 4. Set it up in the data folder: a new folder, then one rename.
  job.step = 'setting-up';
  const root = installedAppsRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const incoming = path.join(root, `.incoming-${id}-${randomUUID().slice(0, 8)}`);
  try {
    for (const f of files) {
      const target = path.join(incoming, ...f.path.split('/'));
      if (!target.startsWith(incoming + path.sep)) throw new Error('a file path leaves the app folder');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, f.bytes, { mode: 0o600 });
    }
    if(id==='agent-connect'){const descriptor=files.find(f=>f.path==='runtime-packages.npm');if(!descriptor)throw Error('Agent Connect has no reviewed runtime list.');await (await import('./store-package-runtime.js')).installRuntimePackages(incoming,descriptor.bytes,runtimeFetch);}
    const dest = path.join(root, id);
    const old = path.join(root, `.old-${id}-${Date.now()}`);
    const hadOld=fs.existsSync(dest);if(hadOld)fs.renameSync(dest,old);
    try{fs.renameSync(incoming,dest);}catch(error){if(hadOld)fs.renameSync(old,dest);throw error;}
    fs.rmSync(old, { recursive: true, force: true });
    // Only its own migrations, recorded as the extension runner records them; then the copy of its data, if one was saved.
    const db = await sql();
    db.transaction(() => {
      for (const file of migrations) {
        const name = file.path.slice('migrations/'.length);
        if (db.prepare('SELECT 1 FROM extension_migrations WHERE extension_id = ? AND filename = ?').get(id, name)) continue;
        // Execute the same verified bytes that passed the SQL allowlist, never a disk alias.
        db.exec(file.bytes.toString('utf8'));
        db.prepare('INSERT INTO extension_migrations (extension_id, filename) VALUES (?, ?)').run(id, name);
      }
    })();
    restoreCopy(db, id, tables);
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
  // 5. Turn it on; its page and tools load when Girru starts again.
  job.step = 'adding';
  const db = await sql(); ensureSettings(db);
  if(id==='agent-connect')db.prepare(`INSERT INTO extension_configs (extension_id,enabled,updated_at) VALUES (?,0,datetime('now')) ON CONFLICT(extension_id) DO UPDATE SET updated_at=datetime('now')`).run(id);
  else db.prepare(`INSERT INTO extension_configs (extension_id, enabled, updated_at) VALUES (?, 1, datetime('now')) ON CONFLICT(extension_id) DO UPDATE SET enabled = 1, updated_at = datetime('now')`).run(id);
  db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(KEY(id), JSON.stringify({ name:item.name,version: item.version, packageSha256: pkg.sha256, installedAt: new Date().toISOString() }), Date.now());
  const auto = restart?.() ?? false;
  Object.assign(job, { done: true, ok: true, restart: auto ? 'auto' : 'manual', message: auto ? `${item.name} is added. Girru starts again to finish.` : `${item.name} is added. Start Girru again to finish.` });
}

const copyDir = () => path.join(workspaceBackupsDir(), 'app-data');
const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
function latestCopy(id: string): string | null {
  try { const n = fs.readdirSync(copyDir()).filter((f) => f.startsWith(`${id}-`) && f.endsWith('.json')).sort().pop(); return n ? path.join(copyDir(), n) : null; } catch { return null; }
}
function restoreCopy(db: Awaited<ReturnType<typeof sql>>, id: string, tables: string[]) {
  const file = latestCopy(id);
  if (!file) return;
  const copy = JSON.parse(fs.readFileSync(file, 'utf8')) as { tables?: Record<string, Array<Record<string, unknown>>> };
  db.transaction(() => {
    for (const [table, rows] of Object.entries(copy.tables ?? {})) {
      if (!tables.includes(table)) continue;
      const cols = new Set((db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map((c) => c.name));
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => cols.has(k));
        if (keys.length) db.prepare(`INSERT OR IGNORE INTO ${quote(table)} (${keys.map(quote).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => row[k]));
      }
    }
  })();
}

/** What an added app keeps: its tables and how many rows each holds. */
export async function appData(id: string): Promise<Array<{ table: string; rows: number }>> {
  const dir = installedAppDir(id);
  if (!dir) return [];
  const tables = appTables(id, migrationFiles(dir).map((f) => fs.readFileSync(f, 'utf8')));
  const db = await sql();
  return tables.filter((t) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)).map((t) => ({ table: t, rows: Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(t)}`).get() as { n: number }).n) }));
}

export type RemoveResult = { ok: true; copy: string | null; restart: 'auto' | 'manual' } | { ok: false; code: 'not_found' | 'has_data' | 'refused'; message: string; data?: Array<{ table: string; rows: number }> };
/** Remove an added app. With rows in its tables, only with confirm: a copy of them is saved first. */
export async function removeApp(id: string, options: { confirm?: boolean; restart?: () => boolean } = {}): Promise<RemoveResult> {
  if(id==='agent-connect'&&[...jobs.values()].some(j=>j.app===id&&!j.done))return {ok:false,code:'refused',message:'Wait for Agent Connect to finish adding before removing it.'};
  if (!ID.test(id) || !(await installedApps())[id]) return { ok: false, code: 'not_found', message: 'This app was not added to Girru.' };
  if(id==='agent-connect'){await (await import('../../extensions/shared/channel-host.js')).stopAllChannels();(await import('../../extensions/shared/channel-library.js')).retireChannelLibrary();}
  const data = await appData(id);
  const rows = data.reduce((n, t) => n + t.rows, 0);
  if (rows > 0 && !options.confirm) return { ok: false, code: 'has_data', message: 'It keeps data of its own.', data };
  const db = await sql();
  let copy: string | null = null;
  if (rows > 0) {
    const tables: Record<string, unknown[]> = {};
    for (const t of data) tables[t.table] = db.prepare(`SELECT * FROM ${quote(t.table)}`).all();
    fs.mkdirSync(copyDir(), { recursive: true, mode: 0o700 });
    copy = path.join(copyDir(), `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(copy, JSON.stringify({ app: id, savedAt: new Date().toISOString(), tables }), { mode: 0o600 });
  }
  db.transaction(() => {
    for (const t of data) db.exec(`DROP TABLE IF EXISTS ${quote(t.table)}`);
    db.prepare('DELETE FROM extension_migrations WHERE extension_id = ?').run(id);
    if(id==='agent-connect')db.prepare('UPDATE extension_configs SET enabled=0, updated_at=CURRENT_TIMESTAMP WHERE extension_id=?').run(id);
    else db.prepare('DELETE FROM extension_configs WHERE extension_id = ?').run(id);
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(KEY(id));
  })();
  const dir = installedAppDir(id);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, copy, restart: options.restart?.() ? 'auto' : 'manual' };
}
