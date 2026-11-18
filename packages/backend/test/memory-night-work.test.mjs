// MEM-READ-01 MR9: night work — hours, idle and charging, steps in order, the morning report.
// Run: node --import tsx --test test/memory-ask-agent.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-night-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'night-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
const N = await load('src/memory/night-work.ts');
const at = (h, m = 0, d = 12) => new Date(2026, 10, d, h, m);

test('hours, the night key, and when it is due', async () => {
  const s = { enabled: true, from: '01:00', to: '06:00', lastNight: null };
  assert.equal(N.inHours(s, at(1)), true); assert.equal(N.inHours(s, at(6)), false); assert.equal(N.inHours(s, at(0, 59)), false);
  assert.equal(N.inHours({ from: '22:00', to: '06:00' }, at(23)), true); assert.equal(N.inHours({ from: '22:00', to: '06:00' }, at(3)), true);
  assert.equal(N.nightKey({ from: '22:00', to: '06:00' }, at(3)), '2026-11-11');
  assert.equal(N.nightDue(s, at(2), { idleSeconds: 600, onPower: true }), true);
  assert.equal(N.nightDue(s, at(2), { idleSeconds: 600, onPower: false }), false, 'not on battery');
  assert.equal(N.nightDue(s, at(2), { idleSeconds: 5, onPower: true }), false, 'not while used');
  assert.equal(N.nightDue({ ...s, lastNight: '2026-11-12' }, at(2), { idleSeconds: 600, onPower: true }), false, 'once a night');
  assert.equal(N.nightDue(s, at(14), { idleSeconds: 1300, onPower: true }), true, 'off at night: next 20 idle minutes');
  assert.equal(N.nightDue(s, at(14), { idleSeconds: 300, onPower: true }), false);
  assert.equal(N.nightDue({ ...s, lastNight: '2026-11-11' }, at(14), { idleSeconds: 1300, onPower: true }), false, 'last night ran');
  assert.equal(N.nightDue({ ...s, enabled: false }, at(2), { idleSeconds: 600, onPower: true }), false);
});

test('settings: on by default, 01:00–06:00; owner changes are checked', async () => {
  assert.deepEqual(await N.nightSettings(OWNER), { enabled: true, from: '01:00', to: '06:00', lastNight: null });
  assert.deepEqual(await N.setNightSettings(OWNER, { from: '02:00' }), { enabled: true, from: '02:00', to: '06:00' });
  await assert.rejects(N.setNightSettings(OWNER, { from: '25:00' }), /HH:MM/);
  await assert.rejects(N.setNightSettings(OWNER, { at: 'now' }), /Use enabled/);
  await N.setNightSettings(OWNER, { from: '01:00' });
});

test('steps run in order and stop when the computer is used; the morning report waits until Done', async () => {
  const order = []; let idle = 900;
  const steps = { readFiles: async () => { order.push('read'); idle = 900; return { files: 214, projects: 4, proposals: 9 }; }, summaries: async () => { order.push('summaries'); return ['grenzer', 'Flowxtra']; }, tidy: async () => { order.push('tidy'); return { keys: 1, duplicates: 3 }; } };
  const r = await N.runNightWork(OWNER, { steps, now: () => at(1, 30), state: async () => ({ idleSeconds: idle, onPower: true }) });
  assert.deepEqual(order, ['read', 'summaries', 'tidy']);
  assert.equal(r.stopped, 'done'); assert.equal(r.files, 214); assert.equal(r.keys, 1);
  assert.equal((await N.nightReport(OWNER)).proposals, 9);
  assert.equal((await N.nightSettings(OWNER)).lastNight, '2026-11-12');
  await N.dismissNightReport(OWNER);
  assert.equal(await N.nightReport(OWNER), null);
  assert.equal((await N.lastNight(OWNER)).files, 214, 'Settings still shows last night');
  // Used after the first step: stops, and the night is not marked done (it continues next time).
  order.length = 0;
  const steps2 = { ...steps, readFiles: async () => { order.push('read'); idle = 10; return { files: 3, projects: 1, proposals: 0 }; } };
  const r2 = await N.runNightWork(OWNER, { steps: steps2, now: () => at(2, 0, 13), state: async () => ({ idleSeconds: idle, onPower: true }) });
  assert.equal(r2.stopped, 'used'); assert.deepEqual(order, ['read']);
  assert.equal((await N.nightSettings(OWNER)).lastNight, '2026-11-12');
  // A quiet night makes no report row.
  const quiet = { readFiles: async () => ({ files: 0, projects: 0, proposals: 0 }), summaries: async () => [], tidy: async () => ({ keys: 0, duplicates: 0 }) };
  await N.runNightWork(OWNER, { steps: quiet, now: () => at(1, 10, 14), state: async () => ({ idleSeconds: 900, onPower: true }) });
  assert.equal(await N.nightReport(OWNER), null);
});

test('the real steps run on an empty account without errors', async () => {
  const r = await N.runNightWork(OWNER, { force: true, now: () => at(1, 5, 15) });
  assert.equal(r.stopped, 'done');
});
