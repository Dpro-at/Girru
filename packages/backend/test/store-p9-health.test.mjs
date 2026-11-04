// STORE-MAP-01 P9 (GIRRU_STORE_P9) FAIL4–FAIL6, OPS6, A6: failures counted, health, support file,
// the coding apps' handoff queue and the scheduled read-only memory doctor.
//  - off: nothing is counted, no doctor job is scheduled, the routes answer 404;
//  - a failure is counted (ids only); the second of a kind within a day raises ONE notice;
//  - the health view has five rows and turns a row to "needs you" after a failure;
//  - the support file holds counts and ids, never memory text or the home folder;
//  - handoff_write while Girru is away waits in a 0600 queue, read tools say memory is offline,
//    the queue is sent when Girru is back (this folder only) and a refused note is dropped;
//  - the doctor job only reads: it records its counts and changes no memory;
//  - the note a reply gets when memory is unavailable never invites guessing.
// Run: node --import tsx --test test/store-p9-health.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets, no network, no real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p9-health-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.GIRRU_BACKUPS_DIR = join(dir, 'Girru Backups');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['GIRRU_STORE_P9', 'GIRRU_STORE_P3', 'GIRRU_STORE_P2', 'GIRRU_MEMORY_HELPER']) delete process.env[k]; // the helper row has its own test (memory-helper-install)
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'p9h-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
const H = await load('src/memory/health.ts');
const Q = await load('src/memory/bridge/handoff-queue.ts');
const { BridgeClientError } = await load('src/memory/bridge/mcp-server.ts');
const J = await load('src/memory/jobs.ts');
const { getMemoryStorage } = await load('src/memory/storage.ts');
await getMemoryStorage().initialize();
db.prepare(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind)
  VALUES ('h-1', ?, 'fact', 'The vault code is purple-otter-42', 'factual', 'active', '{}', 0.5, ?, 0, 'owner')`).run(OWNER, new Date().toISOString());
db.prepare(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind)
  VALUES ('h-2', ?, 'fact', 'The vault code is purple-otter-42', 'factual', 'active', '{}', 0.5, ?, 0, 'owner')`).run(OWNER, new Date().toISOString());
const events = (kind) => db.prepare('SELECT COUNT(*) AS n FROM memory_health_events WHERE owner_id = ? AND kind = ?').get(OWNER, kind).n;
const notices = () => db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?").get(OWNER).n;

test('off: nothing is counted and no doctor job is scheduled', async () => {
  await H.recordHealthEvent(OWNER, 'save_failed', 'a-1');
  assert.equal(events('save_failed'), 0);
  await J.ensureMemoryJobs();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cron_jobs WHERE name LIKE 'memory-doctor-%'").get().n, 0);
  assert.deepEqual(await J.runMemoryJob({ job: 'doctor', userId: OWNER }), { skipped: 'off' });
});

test('failures are counted; the second of a kind in a day raises one notice', async () => {
  process.env.GIRRU_STORE_P9 = '1';
  const before = notices();
  await H.recordHealthEvent(OWNER, 'save_failed', 'a-1');
  assert.equal(notices(), before);
  await H.recordHealthEvent(OWNER, 'save_failed', 'not an id: some memory text');
  await H.recordHealthEvent(OWNER, 'save_failed', 'a-1');
  assert.equal(events('save_failed'), 3);
  assert.equal(notices(), before + 1, 'one notice for the burst');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_health_events WHERE ref LIKE '%memory text%'").get().n, 0, 'refs are ids only');
  const h = await H.memoryHealth(OWNER);
  assert.deepEqual(h.rows.map((r) => r.id), ['remembering', 'saving', 'backups', 'coding_apps', 'background']);
  const saving = h.rows.find((r) => r.id === 'saving');
  assert.equal(saving.state, 'needs_you');
  assert.equal(saving.word, '3 not saved');
  assert.equal(h.rows.find((r) => r.id === 'remembering').state, 'ok');
  assert.equal(h.rows.find((r) => r.id === 'backups').word, 'No backup yet');
  delete process.env.GIRRU_STORE_P9;
});

test('the doctor job only reads and records its counts', async () => {
  process.env.GIRRU_STORE_P9 = '1';
  await J.ensureMemoryJobs();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cron_jobs WHERE name = ?").get(`memory-doctor-${OWNER}`).n, 1);
  const r = await J.runMemoryJob({ job: 'doctor', userId: OWNER });
  assert.equal(r.counts.duplicate, 1);
  assert.equal(events('doctor'), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ?").get(OWNER).n, 2, 'nothing fixed by itself');
  const bg = (await H.memoryHealth(OWNER)).rows.find((x) => x.id === 'background');
  assert.equal(bg.state, 'needs_you');
  const sum = Object.values(r.counts).reduce((a, b) => a + b, 0);
  assert.equal(bg.word, `${sum} to tidy`); // the duplicate and the two rows without a vector
  delete process.env.GIRRU_STORE_P9;
});

test('the support file holds counts and ids, never memory text or the home folder', async () => {
  process.env.GIRRU_STORE_P9 = '1';
  const b = await H.supportBundle(OWNER);
  const text = JSON.stringify(b);
  assert.equal(b.kind, 'girru-support-bundle');
  assert.equal(b.memory.byKind.owner, 2);
  assert.doesNotMatch(text, /purple-otter|vault code/);
  assert.ok(!text.includes(dir), 'no home or data path');
  assert.ok(!text.includes(process.env.JWT_SECRET) && !text.includes(process.env.ENCRYPTION_KEY));
  delete process.env.GIRRU_STORE_P9;
});

test('coding apps: a handoff waits while Girru is away and is sent when it is back', async () => {
  const configDir = join(dir, 'cli-config');
  mkdirSync(configDir, { recursive: true });
  let up = false;
  const got = [];
  const inner = { async call(tool, args) {
    if (!up) throw new BridgeClientError('Cannot reach Girru at http://127.0.0.1:41522. Is it running?');
    if (args.refuse) throw new BridgeClientError('Girru refused the call (400).');
    got.push([tool, args]); return { text: 'ok' };
  } };
  const b = Q.queueingBackend(inner, { configDir, cwd: '/work/alpha' });
  assert.equal((await b.call('handoff_write', { done: ['A'] })).text, Q.QUEUED_TEXT);
  assert.equal((await b.call('memory_handoff', { done: ['B'] })).text, Q.QUEUED_TEXT);
  assert.equal((await b.call('project_brief', {})).text, Q.OFFLINE_READ_TEXT);
  const other = Q.queueingBackend(inner, { configDir, cwd: '/work/beta' });
  await other.call('handoff_write', { done: ['C'] });
  await b.call('handoff_write', { done: ['D'], refuse: true });
  const file = join(configDir, Q.QUEUE_FILE);
  assert.equal(statSync(file).mode & 0o077, 0, 'owner only');
  assert.equal(Q.queuedHandoffs(configDir), 4);
  process.env.GIRRU_STORE_P9 = '1';
  assert.equal((await H.memoryHealth(OWNER)).rows.find((r) => r.id === 'coding_apps').word, '4 handoffs waiting');
  delete process.env.GIRRU_STORE_P9;
  up = true;
  assert.equal((await b.call('project_brief', {})).text, 'ok');
  assert.equal(got[0][0], 'project_brief');
  assert.deepEqual(got.slice(1).map(([t, a]) => [t, a.done[0]]), [['handoff_write', 'A'], ['memory_handoff', 'B']], 'this folder\'s notes, oldest first; the refused one dropped');
  assert.equal(Q.queuedHandoffs(configDir), 1, 'the other folder\'s note waits');
  assert.match(readFileSync(file, 'utf8'), /beta/);
  await other.call('latest_handoff', {});
  assert.equal(existsSync(file), false);
});

test('the note for a reply without memory never invites guessing', () => {
  assert.match(H.MEMORY_UNAVAILABLE_NOTE, /not available/);
  assert.match(H.MEMORY_UNAVAILABLE_NOTE, /Never invent/);
});

test('routes: off = 404, owner gets health and the support file', async () => {
  const { generateToken } = await load('src/auth/jwt.ts');
  const { buildServer } = await load('src/api/app.ts');
  const app = await buildServer({ logger: false });
  await app.ready();
  const call = (url) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${generateToken(OWNER, 1)}` } });
  assert.equal((await call('/api/memory/health')).statusCode, 404);
  process.env.GIRRU_STORE_P9 = '1';
  const h = await call('/api/memory/health');
  assert.equal(h.statusCode, 200, h.body);
  assert.equal(h.json().rows.length, 5);
  const s = await call('/api/memory/health/support');
  assert.equal(s.statusCode, 200);
  assert.match(s.headers['content-disposition'], /girru-support-/);
  assert.doesNotMatch(s.body, /purple-otter/);
  delete process.env.GIRRU_STORE_P9;
  await app.close();
});
