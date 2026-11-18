// STORE-MAP-01 P0 baseline: a throwaway data folder for every measurement.
// Must be imported FIRST (before any backend module): it moves the process
// into a new temp folder, points the database and HOME there, uses random
// test-only secrets and allows loopback network only (local Ollama). The
// real `.data` folder and the app ports 42521/42522 are never touched.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const backendDir = process.cwd();
/** A backend module path as an import URL (a bare C: path is not a valid ESM specifier on Windows). */
export const moduleUrl = (...parts) => pathToFileURL(join(...parts)).href;
if (!backendDir.endsWith(join('packages', 'backend'))) {
  throw new Error('Run from packages/backend: node --import tsx scripts/memory-baseline/<script>.mjs');
}

// GIRRU_BENCH_DATA: an existing throwaway folder to share instead of making a new one, so several
// processes can open ONE database (agents.mjs: many agents at once). Only that folder's owner removes it.
const shared = process.env.GIRRU_BENCH_DATA;
export const dataRoot = shared || mkdtempSync(join(tmpdir(), 'girru-p0-'));
export const sharedData = !!shared;
mkdirSync(join(dataRoot, '.data'), { recursive: true });
process.chdir(dataRoot);
process.env.HOME = dataRoot;
process.env.AGENT_PLAYER_DATA_DIR = join(dataRoot, '.data');
process.env.DATABASE_PATH = join(dataRoot, '.data', 'agent-player.db');
// Shared runs need the SAME secrets in every process (the encryption key is part of the data).
process.env.JWT_SECRET ||= randomBytes(64).toString('hex'); // throwaway
process.env.ENCRYPTION_KEY ||= randomBytes(32).toString('hex'); // throwaway
process.env.MEMORY_GRAPH_MODEL = 'off';
delete process.env.DATABASE_URL; // SQLite only; PostgreSQL is not measured here

export const OLLAMA = 'http://127.0.0.1:11434';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const BLOCKED_PORTS = new Set(['42521', '42522']);
export const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  if (!LOOPBACK.has(u.hostname) || BLOCKED_PORTS.has(u.port)) throw new Error(`blocked network call: ${url}`);
  return realFetch(url, init);
};

export function cleanup() {
  try { process.chdir(backendDir); } catch { /* ignore */ }
  if (sharedData) return; // another process owns it
  rmSync(dataRoot, { recursive: true, force: true });
}

/** Run `fn` with console.log/warn silenced (the backend logs a lot on start). */
export async function quietly(fn) {
  const l = console.log, w = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = l; console.warn = w; }
}

/** Open the throwaway database and run the app's own initialization. */
export async function openDb() {
  const { getDatabase, closeDatabase } = await import(moduleUrl(backendDir, 'src/db/database.ts'));
  const db = getDatabase();
  await quietly(() => db.initialize());
  return { db, closeDatabase };
}

export function addUser(db, id, role = 'owner') {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`)
    .run(id, `${id}@example.test`, id, role);
}

/** Is a local Ollama model available (never a remote one)? */
export async function ollamaHas(model) {
  try {
    const res = await realFetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const { models = [] } = await res.json();
    return models.some((m) => m.name === model || m.name === `${model}:latest`);
  } catch { return false; }
}

export function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

export function argValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
