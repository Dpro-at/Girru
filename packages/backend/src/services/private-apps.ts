/**
 * Private apps (board SA6): an app someone made for themselves and does not publish.
 * The owner adds it from a folder on this computer; Girru checks it the way it checks
 * an app from the Girru Store (an app file with its id, version and main file; package
 * file rules; migrations that only make its own app_<id>__ tables), copies it into the
 * data folder and turns it on. It is marked private, stays on this computer and is never
 * listed in the Girru Store. Removing it works like removing a Store app (removeApp).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extensionsRoot, installedAppsRoot } from '../config/backend-root.js';
import { appTables, installedApps } from './store-install.js';

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // same rule as Store apps: table prefixes can never overlap
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/; // same file rules as a Store package
const PACKAGE_EXT = /\.(js|mjs|json|sql|md|css|svg|png|txt)$/;
const MAX_FILES = 300, MAX_BYTES = 5 * 1024 * 1024;
const KEY = (id: string) => `store.installed.${id}`;

export type PrivateAddResult =
  | { ok: true; id: string; name: string; restart: 'auto' | 'manual' }
  | { ok: false; code: 'invalid_folder' | 'refused' | 'exists'; message: string };

async function sql() {
  const { getDatabase } = await import('../db/index.js');
  return getDatabase().getDb() as { prepare(s: string): { get(...a: unknown[]): any; run(...a: unknown[]): unknown }; exec(s: string): void; transaction<T>(fn: () => T): () => T };
}

/** The app's files, read in memory first: only regular files under the package rules, no links. */
function readFolder(root: string): Array<{ path: string; bytes: Buffer }> {
  const out: Array<{ path: string; bytes: Buffer }> = [];
  let total = 0;
  const walk = (dir: string, parts: string[]) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (!SEGMENT.test(entry.name) || parts.length >= 8) throw new Error(`"${[...parts, entry.name].join('/')}" is not an allowed file name`);
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`"${[...parts, entry.name].join('/')}" is a link; copy the real file in`);
      if (entry.isDirectory()) { walk(full, [...parts, entry.name]); continue; }
      if (!entry.isFile()) continue;
      const rel = [...parts, entry.name].join('/');
      if (!PACKAGE_EXT.test(rel)) throw new Error(`"${rel}" is not a file type an app may have`);
      const bytes = fs.readFileSync(full);
      total += bytes.length;
      out.push({ path: rel, bytes });
      if (out.length > MAX_FILES || total > MAX_BYTES) throw new Error('the app is too big (300 files or 5 MB at most)');
    }
  };
  walk(root, []);
  return out;
}

/**
 * Add a private app from a folder inside the owner's home folder. Owner only (the route
 * checks), from this computer only; nothing is written until every check passes.
 */
export async function addPrivateApp(folder: string, options: { home?: string; restart?: () => boolean } = {}): Promise<PrivateAddResult> {
  const fail = (message: string, code: 'invalid_folder' | 'refused' | 'exists' = 'refused'): PrivateAddResult => ({ ok: false, code, message });
  const home = fs.realpathSync(options.home ?? os.homedir());
  let root: string;
  try { root = fs.realpathSync(path.resolve(home, folder)); } catch { return fail('That folder was not found.', 'invalid_folder'); }
  // Only folders inside your home folder, and never Girru's own data or program folders.
  if (!root.startsWith(home + path.sep)) return fail('Choose a folder inside your home folder.', 'invalid_folder');
  if (!fs.statSync(root).isDirectory()) return fail('That is not a folder.', 'invalid_folder');
  const apps = path.resolve(installedAppsRoot());
  if (root === apps || root.startsWith(apps + path.sep)) return fail('That folder is already part of Girru.', 'invalid_folder');

  let files: Array<{ path: string; bytes: Buffer }>;
  try { files = readFolder(root); } catch (error) { return fail(`It cannot be added: ${(error as Error).message}.`); }
  const manifest = files.find((f) => f.path === 'agentplayer.plugin.json');
  if (!manifest) return fail('The folder has no app file (agentplayer.plugin.json).');
  let plugin: { id?: unknown; name?: unknown; version?: unknown; main?: unknown };
  try { plugin = JSON.parse(manifest.bytes.toString('utf8')); } catch { return fail('The app file is not valid JSON.'); }
  const id = typeof plugin.id === 'string' ? plugin.id : '';
  if(['agent-connect','call-center','trading','browser'].includes(id))return fail('This id is reserved for its reviewed Girru Store app.','exists');
  if (!ID.test(id) || id.length > 64) return fail('The app id must be lower-case letters and numbers joined by single dashes.');
  if (typeof plugin.version !== 'string' || !plugin.version.trim() || typeof plugin.main !== 'string' || !files.some((f) => f.path === plugin.main)) return fail('The app file needs a version and a main file that is in the folder.');
  const name = typeof plugin.name === 'string' && plugin.name.trim() ? plugin.name.trim().slice(0, 80) : id;
  let shipped: string[] = [];
  try { shipped = fs.readdirSync(extensionsRoot()); } catch { /* none */ }
  if (shipped.includes(id)) return fail(`"${id}" is the name of an app that comes with Girru. Give yours another id.`, 'exists');
  const before = (await installedApps())[id];
  if (before && before.source !== 'private') return fail(`"${id}" is already added from the Girru Store.`, 'exists');
  let tables: string[];
  try { tables = appTables(id, files.filter((f) => f.path.startsWith('migrations/') && f.path.endsWith('.sql')).map((f) => f.bytes.toString('utf8'))); }
  catch (error) { return fail(`It cannot be added: ${(error as Error).message}.`); }

  // Set it up in the data folder: a new folder, then one rename (an older copy of the same private app is replaced).
  const base = installedAppsRoot();
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const incoming = path.join(base, `.incoming-${id}-${randomUUID().slice(0, 8)}`);
  try {
    for (const f of files) {
      const target = path.join(incoming, ...f.path.split('/'));
      if (!target.startsWith(incoming + path.sep)) throw new Error('a file path leaves the app folder');
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, f.bytes, { mode: 0o600 });
    }
    const dest = path.join(base, id), old = path.join(base, `.old-${id}-${Date.now()}`);
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(incoming, dest);
    fs.rmSync(old, { recursive: true, force: true });
    const db = await sql();
    db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
    db.transaction(() => {
      for (const f of files.filter((x) => /^migrations\/[^/]+\.sql$/.test(x.path)).sort((a, b) => a.path.localeCompare(b.path))) {
        const file = f.path.slice('migrations/'.length);
        if (db.prepare('SELECT 1 FROM extension_migrations WHERE extension_id = ? AND filename = ?').get(id, file)) continue;
        db.exec(f.bytes.toString('utf8'));
        db.prepare('INSERT INTO extension_migrations (extension_id, filename) VALUES (?, ?)').run(id, file);
      }
      db.prepare(`INSERT INTO extension_configs (extension_id, enabled, updated_at) VALUES (?, 1, datetime('now')) ON CONFLICT(extension_id) DO UPDATE SET enabled = 1, updated_at = datetime('now')`).run(id);
      db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(KEY(id), JSON.stringify({ version: plugin.version, installedAt: new Date().toISOString(), source: 'private', name, tables }), Date.now());
    })();
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
  return { ok: true, id, name, restart: options.restart?.() ? 'auto' : 'manual' };
}
