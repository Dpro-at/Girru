// MODELS-01-INSTALL (GIRRU_MEMORY_HELPER): the memory helper installs itself in the background.
//  - off: nothing runs, nothing is fetched, no health row, the routes answer 404;
//  - start-up never waits for it (OPS3);
//  - loopback only: a non-loopback runtime URL is never called;
//  - a missing runtime is reported (never installed) and memory keeps the hash fallback;
//  - an installed runtime that is not running is started bound to 127.0.0.1;
//  - the embedding model is pulled with progress, checked, then the hash rows are re-embedded;
//  - a failed download falls back to hash recall, is retried later and goes on from the saved state;
//  - the state file holds codes and counts only (no memory text, no paths);
//  - the health view gets a "Memory helper" row.
// Run: node --import tsx --test test/memory-helper-install.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets. The Ollama API is a mock:
// no download, no internet, no runtime is installed or started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-memory-helper-')));
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
const OLLAMA = 'http://127.0.0.1:41599'; // nothing listens: every call goes to the mock below
process.env.OLLAMA_URL = OLLAMA;
delete process.env.MEMORY_EMBEDDINGS;
delete process.env.MEMORY_EMBEDDING_MODEL;
delete process.env.MEMORY_WORKER_MODEL;
process.env.MEMORY_GRAPH_MODEL = 'off';
const startedWith = process.env.GIRRU_MEMORY_HELPER;
delete process.env.GIRRU_MEMORY_HELPER;
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

// ---- The mock Ollama API (loopback only; anything else fails the test) ----
const ollama = { running: false, models: [], pullScript: null, calls: [], embedOk: true };
const enc = new TextEncoder();
const streamOf = (lines) => new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin !== OLLAMA) throw new Error(`unexpected network call in test: ${u.origin}`);
  ollama.calls.push(u.pathname);
  if (!ollama.running) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  if (u.pathname === '/api/version') return Response.json({ version: '0.0.0-test' });
  if (u.pathname === '/api/tags') return Response.json({ models: ollama.models.map((name) => ({ name, size: 1 })) });
  if (u.pathname === '/api/pull') {
    const { model } = JSON.parse(init.body);
    const lines = ollama.pullScript ? ollama.pullScript(model) : [
      { status: 'pulling manifest' },
      { status: 'pulling a', digest: 'sha256:a', total: 600, completed: 300 },
      { status: 'pulling a', digest: 'sha256:a', total: 600, completed: 600 },
      { status: 'pulling b', digest: 'sha256:b', total: 40, completed: 40 },
      { status: 'verifying sha256 digest' }, { status: 'success' },
    ];
    if (lines.at(-1)?.status === 'success') ollama.models.push(model.includes(':') ? model : `${model}:latest`);
    return new Response(streamOf(lines), { status: 200 });
  }
  if (u.pathname === '/api/embed') {
    if (!ollama.embedOk) return new Response('no', { status: 500 });
    const { input } = JSON.parse(init.body);
    return Response.json({ embeddings: input.map((t, i) => Array.from({ length: 16 }, (_, k) => ((t.length + i + k) % 7) + 1)) });
  }
  return new Response('not found', { status: 404 });
};

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'mh-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
const { getMemoryStorage } = await load('src/memory/storage.ts');
await getMemoryStorage().initialize();
const ins = (id, content, model) => db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, embedding_model, embedding_dims)
  VALUES (?, ?, 'fact', ?, ?, 'factual', 'active', '{}', 0.5, ?, 0, 'owner', ?, ?)`).run(id, OWNER, content, model ? JSON.stringify(Array(256).fill(0.01)) : null, new Date().toISOString(), model, model ? 256 : null);
ins('mh-1', 'The vault code is purple-otter-42', 'hash-v2');
ins('mh-2', 'Lena prefers tea in the morning', 'hash-v2');
ins('mh-3', 'An old row with no vector', null);

const Hp = await load('src/memory/helper.ts');
const H = await load('src/memory/health.ts');
const E = await load('src/memory/embedding.ts');
const stateFile = join(dir, '.data', 'memory-helper.json');
const models = () => db.prepare('SELECT embedding_model AS m, COUNT(*) AS n FROM memories WHERE user_id = ? GROUP BY 1 ORDER BY 1').all(OWNER);

let started = [];
let runtimeBin = null;
const clock = { t: Date.parse('2026-11-03T10:00:00Z') };
function fresh({ bin = null } = {}) {
  runtimeBin = bin; started = [];
  rmSync(stateFile, { force: true });
  Hp.resetMemoryHelperState();
  Hp.setMemoryHelperDeps({
    findRuntime: async () => runtimeBin,
    startRuntime: (b, hostPort) => { started.push({ b, hostPort }); ollama.running = true; },
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
  });
  ollama.calls = [];
}

test.after(async () => {
  await Hp.stopMemoryHelper();
  Hp.setMemoryHelperDeps(null);
  if (startedWith === undefined) delete process.env.GIRRU_MEMORY_HELPER; else process.env.GIRRU_MEMORY_HELPER = startedWith;
});

test('off: nothing runs, nothing is fetched, no health row', async () => {
  fresh();
  const s = await Hp.ensureMemoryHelper();
  assert.equal(s.enabled, false);
  Hp.startMemoryHelper(0);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(ollama.calls, []);
  assert.equal(existsSync(stateFile), false);
  process.env.GIRRU_STORE_P9 = '1';
  const h = await H.memoryHealth(OWNER);
  assert.equal(h.rows.some((r) => r.id === 'memory_helper'), false);
  delete process.env.GIRRU_STORE_P9;
});

test('the routes answer 404 while the switch is off', async () => {
  const Fastify = (await import(pathToFileURL(join(backendDir, 'node_modules/fastify/fastify.js')).href)).default;
  const { memoryHelperRoutes } = await load('src/api/routes/memory-helper.ts');
  const app = Fastify();
  await app.register(memoryHelperRoutes);
  assert.equal((await app.inject({ method: 'GET', url: '/api/memory/helper' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/memory/helper/retry' })).statusCode, 404);
  process.env.GIRRU_MEMORY_HELPER = '1';
  const r = await app.inject({ method: 'GET', url: '/api/memory/helper' });
  assert.ok([401, 403].includes(r.statusCode), `no owner, no state (got ${r.statusCode})`);
  delete process.env.GIRRU_MEMORY_HELPER;
  await app.close();
});

test('start-up never waits: startMemoryHelper returns at once', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  fresh();
  const t0 = performance.now();
  const ret = Hp.startMemoryHelper(60_000);
  assert.equal(ret, undefined);
  assert.ok(performance.now() - t0 < 50);
  assert.deepEqual(ollama.calls, [], 'nothing before the delay');
  await Hp.stopMemoryHelper();
});

test('loopback only: a runtime URL on another computer is never called', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  fresh();
  Hp.setMemoryHelperDeps({ baseUrl: () => 'http://192.168.1.20:11434', findRuntime: async () => '/x/ollama', startRuntime: () => assert.fail('must not start'), now: () => clock.t, sleep: async () => {} });
  const s = await Hp.ensureMemoryHelper();
  assert.equal(s.phase, 'fallback');
  assert.equal(s.reason, 'not_loopback');
  assert.deepEqual(ollama.calls, []);
});

test('the owner chose the hash model: nothing is downloaded', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  process.env.MEMORY_EMBEDDINGS = 'hash';
  fresh();
  const s = await Hp.ensureMemoryHelper();
  assert.equal(s.reason, 'hash_chosen');
  assert.deepEqual(ollama.calls, []);
  assert.equal(Hp.memoryHelperRow().state, 'ok');
  delete process.env.MEMORY_EMBEDDINGS;
});

test('runtime missing: reported (never installed), hash fallback kept, retried later', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  ollama.running = false;
  fresh({ bin: null });
  const s = await Hp.ensureMemoryHelper();
  assert.equal(s.phase, 'fallback');
  assert.equal(s.reason, 'runtime_missing');
  assert.equal(s.attempts, 1);
  assert.equal(s.nextTryAt, new Date(clock.t + Hp.RETRY_MS[0]).toISOString());
  assert.equal(started.length, 0);
  const row = Hp.memoryHelperRow();
  assert.equal(row.id, 'memory_helper');
  assert.equal(row.state, 'needs_you');
  assert.match(row.word, /Basic recall/);
  // Recall still works: the hash model answers.
  E.resetEmbeddingService();
  assert.equal((await E.getEmbeddingService().embedDetailed('hello')).model, 'hash-v2');
  await Hp.stopMemoryHelper();
});

test('installed, not running: started bound to 127.0.0.1, model pulled with progress, rows re-embedded', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  process.env.GIRRU_STORE_P9 = '1';
  ollama.running = false; ollama.models = ['qwen3:4b']; ollama.pullScript = null; ollama.embedOk = true;
  fresh({ bin: '/opt/test/ollama' });
  const s = await Hp.ensureMemoryHelper();
  assert.deepEqual(started, [{ b: '/opt/test/ollama', hostPort: '127.0.0.1:41599' }]);
  assert.equal(s.phase, 'ready', JSON.stringify({ phase: s.phase, reason: s.reason, error: s.error }));
  assert.equal(s.runtime.startedByGirru, true);
  assert.equal(s.sizeBytes, 640, 'size from the pull');
  assert.equal(s.completedBytes, 640);
  assert.ok(ollama.calls.includes('/api/pull'));
  assert.equal(s.reembedded, 3);
  assert.equal(s.remaining, 0);
  assert.deepEqual(models(), [{ m: 'ollama:qwen3-embedding:0.6b', n: 3 }]);
  const row = (await H.memoryHealth(OWNER)).rows.find((r) => r.id === 'memory_helper');
  assert.equal(row.word, 'Ready');
  assert.equal(row.state, 'ok');
  delete process.env.GIRRU_STORE_P9;
});

test('already installed: no download, only the check and the re-embed', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  ollama.running = true; ollama.models = ['qwen3-embedding:0.6b'];
  ins('mh-4', 'Saved while the model was down', 'hash-v2');
  fresh();
  const s = await Hp.ensureMemoryHelper();
  assert.equal(s.phase, 'ready');
  assert.equal(ollama.calls.includes('/api/pull'), false);
  assert.equal(s.reembedded, 1);
});

test('a failed download keeps hash recall, is retried later and goes on from the saved state', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  ollama.running = true; ollama.models = [];
  ins('mh-5', 'Another row on the hash model', 'hash-v2');
  ollama.pullScript = () => [
    { status: 'pulling a', digest: 'sha256:a', total: 600, completed: 250 },
    { error: 'write /Users/someone/.ollama/models/blobs/x: no space left on device' },
  ];
  fresh();
  const s = await Hp.ensureMemoryHelper();
  assert.equal(s.phase, 'fallback');
  assert.equal(s.reason, 'download_failed');
  assert.equal(s.error, 'disk_full');
  assert.equal(s.completedBytes, 250);
  assert.ok(s.nextTryAt);
  // The saved state: codes and counts only, never paths or memory text.
  const saved = readFileSync(stateFile, 'utf8');
  assert.equal(JSON.parse(saved).phase, 'fallback');
  assert.doesNotMatch(saved, /Users|someone|space left|purple|Lena/);
  // Quit and start again: the saved state is read, the next try finishes.
  Hp.resetMemoryHelperState();
  assert.equal(Hp.memoryHelperStatus().completedBytes, 250);
  ollama.pullScript = null;
  const again = await Hp.retryMemoryHelper();
  assert.equal(again.phase, 'ready');
  assert.equal(again.attempts, 0);
  assert.equal(models().find((r) => r.m === 'hash-v2'), undefined, 'no hash rows left');
});

test('repeated failures ask for the owner in the health row', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  ollama.running = true; ollama.models = [];
  ollama.pullScript = () => [{ error: 'pull model manifest: connection reset' }];
  fresh();
  for (let i = 0; i < 3; i++) await Hp.retryMemoryHelper();
  const row = Hp.memoryHelperRow();
  assert.equal(row.state, 'needs_you');
  assert.equal(row.detail.attempts, 3);
  assert.equal(row.detail.nextTryAt, new Date(clock.t + Hp.RETRY_MS[2]).toISOString());
  ollama.pullScript = null;
  await Hp.stopMemoryHelper();
});

test('the model is there but does not answer: hash fallback, nothing re-embedded', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  ollama.running = true; ollama.models = ['qwen3-embedding:0.6b']; ollama.embedOk = false;
  ins('mh-6', 'Row while embed fails', 'hash-v2');
  fresh();
  const s = await Hp.ensureMemoryHelper();
  assert.equal(s.reason, 'model_not_answering');
  assert.equal(models().find((r) => r.m === 'hash-v2').n, 1);
  ollama.embedOk = true;
  await Hp.stopMemoryHelper();
});

test('the small memory worker comes later, only when one is named', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  ollama.running = true; ollama.models = ['qwen3-embedding:0.6b'];
  fresh();
  assert.equal((await Hp.ensureMemoryHelper()).worker, null);
  process.env.MEMORY_WORKER_MODEL = 'tiny-worker:1b';
  fresh();
  const s = await Hp.ensureMemoryHelper();
  assert.equal(s.phase, 'ready');
  assert.equal(s.worker.model, 'tiny-worker:1b');
  assert.equal(s.worker.phase, 'ready');
  const pulls = ollama.calls.filter((c) => c === '/api/pull').length;
  assert.equal(pulls, 1, 'only the worker was pulled');
  delete process.env.MEMORY_WORKER_MODEL;
});

test('one run at a time: a second call joins the first', async () => {
  process.env.GIRRU_MEMORY_HELPER = '1';
  ollama.running = true; ollama.models = ['qwen3-embedding:0.6b'];
  fresh();
  const [a, b] = await Promise.all([Hp.ensureMemoryHelper(), Hp.ensureMemoryHelper()]);
  assert.equal(a.phase, 'ready');
  assert.deepEqual(a, b);
  assert.equal(ollama.calls.filter((c) => c === '/api/version').length, 1);
});
