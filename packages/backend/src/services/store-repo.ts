/**
 * The Girru Store repository as a catalogue source (APPS-06 step 1, D-STORE-REPO).
 *
 * github.com/Dpro-at/girru-store keeps one folder per item and an index.json built
 * from them. Girru reads that index when the Store opens (at most every few hours),
 * keeps the last good copy (checked) in the database, and shows it when there is no
 * internet ("showing the store from <date>"). Reading never installs anything.
 * Everything goes through parseStoreIndex, so the repository cannot widen what the
 * Store shows. Items are free only; the repository's `pricing` field is ignored
 * until paid apps open (STORE-PAID-01).
 */
import { parseStoreIndex, type StoreIndex } from './store-index.js';

/** The repository's files on GitHub; GIRRU_STORE_URL points a test run at its own copy (https, or http on 127.0.0.1). */
export function storeBase(): string {
  const env = (process.env.GIRRU_STORE_URL ?? '').trim().replace(/\/+$/, '');
  return /^(https:\/\/|http:\/\/127\.0\.0\.1:\d+)/.test(env) ? env : 'https://raw.githubusercontent.com/Dpro-at/girru-store/main';
}
export const STORE_INDEX_URL = 'https://raw.githubusercontent.com/Dpro-at/girru-store/main/index.json';
const MAX_AGE_MS = 6 * 3_600_000;
const MAX_BYTES = 2 * 1024 * 1024;
const ID = /^(?=[a-z0-9-]{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** An app's package (APPS-06): every file with its size and checksum, as the reviewed index lists them. */
export interface PackageFile { path: string; sha256: string; size: number }
export interface StorePackage { files: PackageFile[]; sha256: string }
export interface RepoRead { index: StoreIndex | null; packages?: Record<string, StorePackage>; runtimes?: Record<string, StoreRuntime>; asOf: string | null; fresh: boolean }

/**
 * CODE-STORE-01: an app whose program is a native runtime too large for a package
 * (the Code editor). The reviewed index lists one archive per platform with its
 * size and SHA-256; Girru downloads only the one for this computer and checks it.
 */
export interface RuntimeArchive { url: string; sha256: string; size: number }
export interface StoreRuntime { version: string; protocolVersion: 1; archives: Partial<Record<RuntimePlatform, RuntimeArchive>> }
export const RUNTIME_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'] as const;
export type RuntimePlatform = typeof RUNTIME_PLATFORMS[number];
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,40})?$/;
const MAX_ARCHIVE = 4 * 1024 ** 3;
/**
 * Release downloads of the two repositories that publish Girru runtimes only: the Girru Store
 * and nabu-code (the Code editor, public since 2026-11-04). Tests: http on 127.0.0.1. Every
 * download is still checked against the size and SHA-256 the reviewed index lists.
 */
export function runtimeUrlAllowed(value: string): boolean {
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  if (u.username || u.password || u.search || u.hash) return false;
  if (u.protocol === 'http:' && u.hostname === '127.0.0.1' && (process.env.GIRRU_STORE_URL ?? '').startsWith('http://127.0.0.1:')) return /\.tar\.gz$/.test(u.pathname);
  return u.protocol === 'https:' && u.hostname === 'github.com' && !u.port && /^\/(?:Dpro-at\/girru-store|9mtm\/nabu-code)\/releases\/download\/[A-Za-z0-9_.+-]+\/[A-Za-z0-9_.+-]+\.tar\.gz$/.test(u.pathname);
}
/** A runtime as the repository lists it; anything outside these rules is refused. */
export function parseRuntime(raw: unknown): StoreRuntime {
  const r = raw as { version?: unknown; protocolVersion?: unknown; archives?: unknown };
  if (!r || typeof r !== 'object' || typeof r.version !== 'string' || !VERSION.test(r.version) || r.protocolVersion !== 1 || !r.archives || typeof r.archives !== 'object' || Array.isArray(r.archives)) throw new TypeError('store runtime');
  const archives: StoreRuntime['archives'] = {};
  for (const [key, value] of Object.entries(r.archives as Record<string, unknown>)) {
    const a = value as Record<string, unknown>;
    if (!(RUNTIME_PLATFORMS as readonly string[]).includes(key) || !a || typeof a.url !== 'string' || a.url.length > 500 || !runtimeUrlAllowed(a.url) || typeof a.sha256 !== 'string' || !HEX.test(a.sha256) || !Number.isSafeInteger(a.size) || (a.size as number) < 1 || (a.size as number) > MAX_ARCHIVE) throw new TypeError('store runtime');
    archives[key as RuntimePlatform] = { url: a.url, sha256: a.sha256, size: a.size as number };
  }
  if (!Object.keys(archives).length) throw new TypeError('store runtime');
  return { version: r.version, protocolVersion: 1, archives };
}
/** The runtimes of the repository's apps, by Girru id; an item with a broken runtime has none. */
export function runtimesFrom(raw: unknown): Record<string, StoreRuntime> {
  const out: Record<string, StoreRuntime> = {};
  for (const x of ((raw as { items?: unknown })?.items as Array<Record<string, unknown>> | undefined) ?? []) {
    if (x && typeof x.id === 'string' && ID.test(x.id) && x.kind === 'app' && x.runtime) { try { out[`girru:${x.id}`] = parseRuntime(x.runtime); } catch { /* listed, not installable */ } }
  }
  return out;
}
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PACKAGE_EXT = /\.(js|mjs|json|sql|md|css|svg|png|txt)$/; // lower case only: the type check and the SQL check see the same files
const HEX = /^[a-f0-9]{64}$/;
/** A package as the repository lists it; anything outside these rules is refused. */
export function parsePackage(raw: unknown): StorePackage {
  const p = raw as { files?: unknown; sha256?: unknown };
  if (!p || typeof p !== 'object' || !Array.isArray(p.files) || p.files.length < 1 || p.files.length > 300 || typeof p.sha256 !== 'string' || !HEX.test(p.sha256)) throw new TypeError('store package');
  let total = 0;
  const seen = new Set<string>();
  const files = (p.files as Array<Record<string, unknown>>).map((f) => {
    if (!f || typeof f.path !== 'string' || typeof f.sha256 !== 'string' || !HEX.test(f.sha256) || !Number.isSafeInteger(f.size) || (f.size as number) < 0) throw new TypeError('store package');
    const parts = f.path.split('/');
    if (seen.has(f.path) || parts.length > 8 || !parts.every((x) => SEGMENT.test(x)) || !PACKAGE_EXT.test(f.path)) throw new TypeError('store package');
    seen.add(f.path); total += f.size as number;
    return { path: f.path, sha256: f.sha256, size: f.size as number };
  });
  if (total > 5 * 1024 * 1024 || !files.some((f) => f.path === 'agentplayer.plugin.json')) throw new TypeError('store package');
  return { files, sha256: p.sha256 };
}
/** The packages of the repository's apps, by Girru id; an item with a broken package has none. */
export function packagesFrom(raw: unknown): Record<string, StorePackage> {
  const out: Record<string, StorePackage> = {};
  for (const x of ((raw as { items?: unknown })?.items as Array<Record<string, unknown>> | undefined) ?? []) {
    if (x && typeof x.id === 'string' && ID.test(x.id) && x.kind === 'app' && x.package) { try { out[`girru:${x.id}`] = parsePackage(x.package); } catch { /* listed, not installable */ } }
  }
  return out;
}
type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** The repository's index in Girru's catalogue shape: ids get the "girru:" prefix, sources are Girru's. */
export function fromRepo(raw: unknown): StoreIndex {
  const r = raw as { schema?: unknown; featured?: unknown; collections?: unknown; items?: unknown };
  if (!r || typeof r !== 'object' || !Array.isArray(r.items) || !Array.isArray(r.collections)) throw new TypeError('store index');
  const id = (x: unknown) => { if (typeof x !== 'string' || !ID.test(x)) throw new TypeError('store index'); return `girru:${x}`; };
  return parseStoreIndex({
    schema: r.schema,
    featured: typeof r.featured === 'string' && ID.test(r.featured) ? `girru:${r.featured}` : null,
    collections: (r.collections as Array<Record<string, unknown>>).map((c) => ({ id: c?.id, title: c?.title, items: Array.isArray(c?.items) ? (c.items as unknown[]).filter((x) => typeof x === 'string' && ID.test(x)).map(id) : [] })),
    items: (r.items as Array<Record<string, unknown>>).map((x) => {
      if (!x || typeof x !== 'object') throw new TypeError('store index');
      const { pricing: _pricing, package: _package, runtime: _runtime, ...rest } = x;
      return { ...rest, id: id(x.id), source: 'girru' };
    }),
  });
}

// The last good copy: the checked index (never the raw answer), kept in app_settings.
const CACHE_KEY = 'store.girru-store';
const APP_SETTINGS_SQL = 'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)';
async function readCache(): Promise<{ fetchedAt: string; index: StoreIndex; packages: Record<string, StorePackage>; runtimes: Record<string, StoreRuntime> } | null> {
  try {
    const { q } = await import('../repositories/sql-steps.js');
    const row = await q.one<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', CACHE_KEY);
    if (!row) return null;
    const c = JSON.parse(row.value) as { fetchedAt?: unknown; index?: unknown; packages?: unknown; runtimes?: unknown };
    if (typeof c.fetchedAt !== 'string' || Number.isNaN(Date.parse(c.fetchedAt))) return null;
    const packages: Record<string, StorePackage> = {};
    for (const [k, v] of Object.entries((c.packages as Record<string, unknown>) ?? {})) if (/^girru:[a-z0-9-]{1,64}$/.test(k)) packages[k] = parsePackage(v);
    const runtimes: Record<string, StoreRuntime> = {};
    for (const [k, v] of Object.entries((c.runtimes as Record<string, unknown>) ?? {})) if (/^girru:[a-z0-9-]{1,64}$/.test(k)) { try { runtimes[k] = parseRuntime(v); } catch { /* dropped */ } }
    return { fetchedAt: c.fetchedAt, index: parseStoreIndex(c.index), packages, runtimes };
  } catch { return null; }
}
async function writeCache(fetchedAt: string, index: StoreIndex, packages: Record<string, StorePackage>, runtimes: Record<string, StoreRuntime>) {
  try {
    const { q } = await import('../repositories/sql-steps.js');
    await q.run(APP_SETTINGS_SQL);
    await q.run('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', CACHE_KEY, JSON.stringify({ fetchedAt, index, packages, runtimes }), Date.now());
  } catch { /* the Store still shows what it read now */ }
}

/**
 * The repository's index: the cached copy while it is young, else a fresh read;
 * when the read fails, the last good copy with its date (or nothing the first time).
 * GIRRU_STORE_REPO=off leaves the repository out (tests, closed networks).
 */
export async function readStoreRepo(options: { now?: Date; fetch?: Fetch; fresh?: boolean } = {}): Promise<RepoRead> {
  if ((process.env.GIRRU_STORE_REPO ?? '').trim().toLowerCase() === 'off') return { index: null, asOf: null, fresh: true };
  const now = options.now ?? new Date();
  const cached = await readCache();
  if (cached && !options.fresh && now.getTime() - Date.parse(cached.fetchedAt) < MAX_AGE_MS) return { index: cached.index, packages: cached.packages, runtimes: cached.runtimes, asOf: cached.fetchedAt, fresh: true };
  try {
    const get = options.fetch ?? (globalThis.fetch as unknown as Fetch);
    const res = await get(`${storeBase()}/index.json`, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': 'Girru' } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error('too large');
    const raw = JSON.parse(text) as unknown;
    const index = fromRepo(raw);
    const packages = packagesFrom(raw);
    const runtimes = runtimesFrom(raw);
    const fetchedAt = now.toISOString();
    await writeCache(fetchedAt, index, packages, runtimes);
    return { index, packages, runtimes, asOf: fetchedAt, fresh: true };
  } catch {
    return cached ? { index: cached.index, packages: cached.packages, runtimes: cached.runtimes, asOf: cached.fetchedAt, fresh: false } : { index: null, asOf: null, fresh: false };
  }
}
