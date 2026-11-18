// STORE-MAP-01 P4 (D7): one handoff table.
//  - the rebuilt agent_handoffs keeps its rows, and its cache triggers still run;
//  - switch on: a coding-app note goes to both tables (same id) and is read from the one table;
//    older notes are copied once; the agents' handoff list never shows an app note twice;
//  - the brief's "latest handoff" still picks the newest of agent and app notes;
//  - switch off again: the old table still has every note.
// Run: node --import tsx --test test/store-p4-handoffs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-p4-handoffs-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.GIRRU_STORE_P4 = '0';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const O = 'ho-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(O, 'ho@example.test', O);
db.prepare(`INSERT INTO agents_config (id, name, provider, model) VALUES ('ho-agent', 'Rafid', 'ollama', 'm')`).run();
const { createProject } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
const bridge = await import(join(backendDir, 'src/memory/bridge/store.ts'));
const handoff = await import(join(backendDir, 'src/memory/handoff/store.ts'));
const { projectHandoff } = await import(join(backendDir, 'src/memory/bridge/brief.ts'));
const p = await createProject(O, { name: 'Alpha' });
const body = (t) => ({ done: [t], left: [], next: [], questions: [] });
const count = (s, ...a) => db.prepare(s).get(...a).n;

test('the rebuilt table allows app notes and keeps its triggers', () => {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_handoffs'").get().sql;
  assert.match(sql, /'project'/); assert.match(sql, /coding_app/); assert.match(sql, /client TEXT/);
  for (const t of ['trg_handoffs_cache_rev_insert', 'trg_handoffs_cache_rev_delete']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(t), t);
});

let older;
test('switch off: app notes only in the old table, as before', async () => {
  older = await bridge.saveBridgeHandoff(O, p.id, 'claude-code', body('older app note'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(count("SELECT COUNT(*) AS n FROM agent_handoffs WHERE scope_kind = 'project'"), 0);
});

test('switch on: older notes copied once, new ones written to both, read from one table', async () => {
  process.env.GIRRU_STORE_P4 = '1';
  assert.equal(await bridge.copyAppHandoffs(), 1);
  assert.equal(await bridge.copyAppHandoffs(), 0, 'once');
  const rev = count("SELECT COALESCE(MAX(revision), 0) AS n FROM memory_cache_revisions WHERE user_id = ? AND scope = 'handoff'", O);
  const fresh = await bridge.saveBridgeHandoff(O, p.id, 'codex', body('newer app note'));
  assert.ok(count("SELECT COALESCE(MAX(revision), 0) AS n FROM memory_cache_revisions WHERE user_id = ? AND scope = 'handoff'", O) > rev, 'the cache trigger runs');
  assert.equal(count('SELECT COUNT(*) AS n FROM agent_handoffs WHERE id = ?', fresh.id), 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM memory_bridge_handoffs WHERE id = ?', fresh.id), 1);
  assert.equal((await bridge.latestBridgeHandoff(O, p.id)).id, fresh.id);
  assert.deepEqual((await bridge.listBridgeHandoffs(O, { projectId: p.id })).map((h) => h.client).sort(), ['claude-code', 'codex']);
  assert.equal((await handoff.listHandoffs(O, { projectId: p.id })).length, 0, 'not shown again as an agent note');
});

test('the brief takes the newest note of agents and apps', async () => {
  const h = await projectHandoff(O, p.id);
  assert.match(h.from, /Codex/i);
  await new Promise((r) => setTimeout(r, 1100)); // agent notes keep whole seconds
  await handoff.saveHandoff({ ownerId: O, agentId: 'ho-agent', kind: 'conversation', scopeId: 'c-1', projectId: p.id }, body('agent note'), 'agent');
  assert.match((await projectHandoff(O, p.id)).from, /Rafid/);
});

test('switch off again: the old table still has every app note', async () => {
  process.env.GIRRU_STORE_P4 = '0';
  assert.equal((await bridge.listBridgeHandoffs(O, { projectId: p.id })).length, 2);
});
