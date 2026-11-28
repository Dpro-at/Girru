// MEM-PANEL-01: the memory helper place — RAM limit, night writer, Stop, per-project last night, routes and tools.
//  - RAM limit: auto = a quarter of the computer's RAM, light ≈ 1.25 GiB (search only), custom = whole GB;
//  - the night writer must already be on this computer and fit the limit with the search model; light keeps it off;
//  - night work waits under 2 GB of available RAM (not when the owner starts it), Stop ends it after the step;
//  - last night is kept per project (files read, summary written);
//  - routes and agent tools are owner only, with the same checks.
// Run: node --import tsx --test test/memory-helper-place.test.mjs
// Throwaway DB + data dir + HOME, random test-only secrets; the local runtime is a mock (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-helper-place-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
const OLLAMA = 'http://127.0.0.1:41598';
process.env.OLLAMA_URL = OLLAMA;
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
process.env.GIRRU_MEMORY_HELPER = '1';
delete process.env.MEMORY_WORKER_MODEL;
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const GIB = 1024 ** 3;
const rt = { installed: [], loaded: [], unloaded: [] };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.origin !== OLLAMA) throw new Error(`unexpected network call in test: ${u.origin}`);
  if (u.pathname === '/api/tags') return Response.json({ models: rt.installed.map(([name, size]) => ({ name, size })) });
  if (u.pathname === '/api/ps') return Response.json({ models: rt.loaded.map(([name, size]) => ({ name, size })) });
  if (u.pathname === '/api/generate') { const b = JSON.parse(init.body); rt.unloaded.push(b); rt.loaded = rt.loaded.filter(([n]) => n !== b.model); return Response.json({ done: true }); }
  throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
};

const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
const OWNER = 'hp-owner';
addUser(OWNER, 'owner');
addUser('hp-user', 'user');

const S = await import('../src/memory/helper-settings.ts');
const N = await import('../src/memory/night-work.ts');
const EMBED = 'qwen3-embedding:0.6b';
let available = 16 * GIB;
const fresh = (totalGb = 32) => {
  rmSync(join(dir, '.data', S.SETTINGS_FILE), { force: true });
  S.resetHelperSettings();
  S.setRamDeps({ totalBytes: () => totalGb * GIB, availableBytes: async () => available });
  rt.installed = [[EMBED, 639 * 1024 ** 2], ['qwen3:4b', 2.5 * GIB], ['llama-big:70b', 40 * GIB]];
  rt.loaded = [[EMBED, 1 * GIB]];
  rt.unloaded = [];
};
test.after(() => { S.setRamDeps(null); closeDatabase(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

test('RAM limit: auto is a quarter, light is about 1 GB, custom is checked whole GB', async () => {
  fresh(32);
  assert.deepEqual(S.helperSettings().ram, { mode: 'auto', customGb: null });
  assert.equal(S.limitBytes(), 8 * GIB);
  await S.setHelperSettings({ ram: { mode: 'light' } }, EMBED);
  assert.equal(S.limitBytes(), S.LIGHT_LIMIT_BYTES);
  await S.setHelperSettings({ ram: { mode: 'custom', customGb: 12 } }, EMBED);
  assert.equal(S.limitBytes(), 12 * GIB);
  for (const bad of [{ ram: { mode: 'custom' } }, { ram: { mode: 'custom', customGb: 0 } }, { ram: { mode: 'custom', customGb: 33 } }, { ram: { mode: 'custom', customGb: 2.5 } }, { ram: { mode: 'huge' } }, { other: 1 }, [], { worker: '../etc' }]) {
    await assert.rejects(S.setHelperSettings(bad, EMBED), (e) => e.code === 'invalid_settings', JSON.stringify(bad));
  }
  // Saved in the data folder, read back after a restart.
  S.resetHelperSettings();
  assert.deepEqual(S.helperSettings().ram, { mode: 'custom', customGb: 12 });
  assert.doesNotMatch(readFileSync(join(dir, '.data', S.SETTINGS_FILE), 'utf8'), /password|token|content/i);
});

test('the night writer: on this computer, fits the RAM limit, off in light; the env still wins', async () => {
  fresh(32);
  await assert.rejects(S.setHelperSettings({ worker: 'mistral:7b' }, EMBED), (e) => e.code === 'worker_not_installed');
  await assert.rejects(S.setHelperSettings({ worker: 'llama-big:70b' }, EMBED), (e) => e.code === 'worker_too_big');
  const ok = await S.setHelperSettings({ worker: 'qwen3:4b' }, EMBED);
  assert.equal(ok.worker, 'qwen3:4b');
  assert.equal(S.chosenWorker(), 'qwen3:4b');
  const c = await S.workerCandidates(EMBED);
  assert.deepEqual(c.map((x) => [x.model, x.fits, x.chosen]), [['qwen3:4b', true, true], ['llama-big:70b', false, false]], 'smallest first, no search model');
  // Light keeps the writer off (the choice stays for later) and refuses a new one.
  await S.setHelperSettings({ ram: { mode: 'light' } }, EMBED);
  assert.equal(S.chosenWorker(), null);
  assert.equal(S.helperSettings().worker, 'qwen3:4b');
  await assert.rejects(S.setHelperSettings({ worker: 'qwen3:4b' }, EMBED), (e) => e.code === 'worker_off_in_light');
  assert.ok((await S.workerCandidates(EMBED)).every((x) => !x.fits));
  // A smaller custom limit that no longer fits the writer is refused while the writer is chosen.
  await assert.rejects(S.setHelperSettings({ ram: { mode: 'custom', customGb: 2 } }, EMBED), (e) => e.code === 'worker_too_big');
  await S.setHelperSettings({ ram: { mode: 'custom', customGb: 2 }, worker: null }, EMBED);
  assert.equal(S.chosenWorker(), null);
  process.env.MEMORY_WORKER_MODEL = 'env-model:1b';
  assert.equal(S.chosenWorker(), 'env-model:1b');
  process.env.MEMORY_WORKER_MODEL = 'off';
  assert.equal(S.chosenWorker(), null);
  delete process.env.MEMORY_WORKER_MODEL;
});

test('RAM view: what the models use now, the limit and what is available', async () => {
  fresh(32); available = 18 * GIB;
  rt.loaded = [[EMBED, 1 * GIB], ['qwen3:4b', 3.5 * GIB]];
  const v = await S.ramView();
  assert.equal(v.totalBytes, 32 * GIB); assert.equal(v.limitBytes, 8 * GIB); assert.equal(v.mode, 'auto');
  assert.equal(v.modelsBytes, 4.5 * GIB); assert.equal(v.availableBytes, 18 * GIB); assert.equal(v.lowFreeBytes, 2 * GIB);
  available = 1 * GIB; assert.equal(await S.ramTooLow(), true);
  available = 16 * GIB; assert.equal(await S.ramTooLow(), false);
});

const at = (h, m = 0, d = 12) => new Date(2026, 10, d, h, m);
const idle = async () => ({ idleSeconds: 900, onPower: true });

test('night work: waits under 2 GB free RAM unless the owner starts it; Stop ends it after the step', async () => {
  fresh(32);
  const order = [];
  const steps = {
    readFiles: async () => { order.push('read'); return { files: 5, projects: 2, proposals: 1, bySlug: { girru: 3, flowxtra: 2 } }; },
    summaries: async () => { order.push('summaries'); return { names: ['Girru'], slugs: ['girru'] }; },
    tidy: async () => { order.push('tidy'); return { keys: 0, duplicates: 0 }; },
  };
  const low = await N.runNightWork(OWNER, { steps, now: () => at(1, 30), state: idle, ramLow: async () => true });
  assert.equal(low.stopped, 'low_ram'); assert.deepEqual(order, []);
  const started = await N.runNightWork(OWNER, { steps, now: () => at(1, 40), state: idle, ramLow: async () => true, force: true });
  assert.equal(started.stopped, 'done', 'Run now does not wait for RAM');
  assert.deepEqual(started.byProject, { girru: { files: 3, summary: true }, flowxtra: { files: 2, summary: false } });
  assert.deepEqual(started.summaries, ['Girru']);
  assert.equal((await N.lastNight(OWNER)).byProject.girru.files, 3);
  // Stop while reading: the next steps do not run; nothing is marked done.
  order.length = 0;
  assert.equal(N.stopNightWorkFor(OWNER), false, 'nothing runs');
  const stopSteps = { ...steps, readFiles: async () => { order.push('read'); assert.equal(N.nightRunning(OWNER).step, 'read'); assert.equal(N.stopNightWorkFor(OWNER), true); return { files: 1, projects: 1, proposals: 0 }; } };
  const stopped = await N.runNightWork(OWNER, { steps: stopSteps, now: () => at(1, 10, 13), state: idle, ramLow: async () => false });
  assert.equal(stopped.stopped, 'stopped'); assert.deepEqual(order, ['read']);
  assert.deepEqual(N.nightRunning(OWNER), { running: false, step: null });
  // The next run is not stopped by the old request.
  const again = await N.runNightWork(OWNER, { steps, now: () => at(1, 20, 13), state: idle, ramLow: async () => false });
  assert.equal(again.stopped, 'done');
  // tick does nothing while RAM is low.
  let ran = 0;
  await N.tick({ steps: { ...steps, readFiles: async () => { ran++; return { files: 0, projects: 0, proposals: 0 }; } }, now: () => at(2, 0, 20), state: idle, ramLow: async () => true });
  assert.equal(ran, 0);
});

test('the night writer leaves the RAM when the night work ends', async () => {
  fresh(32);
  await S.setHelperSettings({ worker: 'qwen3:4b' }, EMBED);
  rt.loaded = [[EMBED, 1 * GIB], ['qwen3:4b', 3.5 * GIB]];
  const none = { readFiles: async () => ({ files: 0, projects: 0, proposals: 0 }), summaries: async () => [], tidy: async () => ({ keys: 0, duplicates: 0 }) };
  await N.runNightWork(OWNER, { steps: none, now: () => at(1, 0, 21), state: idle, ramLow: async () => false });
  assert.deepEqual(rt.unloaded, [{ model: 'qwen3:4b', keep_alive: 0 }]);
  assert.deepEqual(rt.loaded.map(([n]) => n), [EMBED], 'the search model stays');
});

test('routes: owner only; GET shows RAM, settings and candidates; PUT checks; night stop', async () => {
  fresh(32);
  const { registerAuthGate } = await import('../src/auth/auth-gate.ts');
  const { memoryHelperRoutes } = await import('../src/api/routes/memory-helper.ts');
  const { memoryScopeRoutes } = await import('../src/api/routes/memory-scopes.ts');
  const { generateToken } = await import('../src/auth/jwt.ts');
  const { default: Fastify } = await import('fastify');
  const app = Fastify();
  registerAuthGate(app);
  await app.register(memoryHelperRoutes);
  await app.register(memoryScopeRoutes);
  await app.ready();
  const call = (who, method, url, payload) => app.inject({ method, url, payload, headers: who ? { authorization: `Bearer ${generateToken(who, 1)}` } : {} });
  try {
    assert.equal((await call(null, 'GET', '/api/memory/helper')).statusCode, 401);
    assert.equal((await call('hp-user', 'GET', '/api/memory/helper')).statusCode, 403);
    const g = await call(OWNER, 'GET', '/api/memory/helper');
    assert.equal(g.statusCode, 200);
    const v = g.json();
    assert.equal(v.ram.limitBytes, 8 * GIB); assert.equal(v.settings.ram.mode, 'auto');
    assert.deepEqual(v.candidates.map((c) => c.model), ['qwen3:4b', 'llama-big:70b']);
    assert.equal(typeof v.row.word, 'string');
    assert.equal((await call('hp-user', 'PUT', '/api/memory/helper/settings', { ram: { mode: 'light' } })).statusCode, 403);
    assert.equal((await call(OWNER, 'PUT', '/api/memory/helper/settings', { ram: { mode: 'nope' } })).statusCode, 400);
    const big = await call(OWNER, 'PUT', '/api/memory/helper/settings', { worker: 'llama-big:70b' });
    assert.equal(big.statusCode, 409); assert.equal(big.json().code, 'worker_too_big');
    const put = await call(OWNER, 'PUT', '/api/memory/helper/settings', { ram: { mode: 'custom', customGb: 12 } });
    assert.equal(put.statusCode, 200); assert.equal(put.json().ram.limitBytes, 12 * GIB);
    const night = (await call(OWNER, 'GET', '/api/memory/scopes/night')).json();
    assert.equal(night.running, false); assert.equal(night.step, null);
    assert.deepEqual((await call(OWNER, 'POST', '/api/memory/scopes/night/stop', {})).json(), { stopped: false });
    assert.equal((await call('hp-user', 'POST', '/api/memory/scopes/night/stop', {})).statusCode, 403);
  } finally { await app.close(); }
});

test('agent tools: owner own turn only; settings need the settings approval; status has no memory text', async () => {
  fresh(32);
  const T = await import('../src/tools/memory/index.ts');
  const { approvalCategory } = await import('../src/tools/approvals.ts');
  const { DEFAULT_AGENT_TOOLS } = await import('../src/tools/grants.ts');
  const { storedRunAllowsTool } = await import('../src/memory/encryption/stored-run-tool-policy.ts');
  const ctx = { workspaceDir: dir, userId: OWNER, agentId: 'hp-agent', memoryDrawers: [{ kind: 'owner' }] };
  for (const name of ['memory_helper_status', 'memory_helper_settings', 'memory_night_run', 'memory_night_stop']) assert.ok(DEFAULT_AGENT_TOOLS.includes(name), name);
  assert.equal(approvalCategory({ name: 'memory_helper_settings' }), 'settings');
  assert.equal(approvalCategory({ name: 'memory_helper_status' }), null);
  assert.equal(storedRunAllowsTool('memory_helper_status'), true);
  assert.ok((await T.memoryHelperStatusTool.execute({}, { ...ctx, userId: 'hp-user' })).error, 'not the owner');
  assert.ok((await T.memoryHelperStatusTool.execute({}, { ...ctx, toolPolicy: { channel: 'telegram' } })).error, 'outsider turn');
  const st = await T.memoryHelperStatusTool.execute({}, ctx);
  assert.ok(!st.error, st.error);
  assert.match(st.content[0].text, /RAM: models use/);
  assert.equal(st.data.ram.limitBytes, 8 * GIB);
  const bad = await T.memoryHelperSettingsTool.execute({ worker: 'llama-big:70b' }, ctx);
  assert.match(bad.error, /worker_too_big/);
  const good = await T.memoryHelperSettingsTool.execute({ ram: { mode: 'light' } }, ctx);
  assert.ok(!good.error, good.error); assert.match(good.content[0].text, /night writer off \(light\)/);
  const stop = await T.memoryNightStopTool.execute({}, ctx);
  assert.equal(stop.data.stopped, false);
});
