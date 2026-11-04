// STORE-MAP-01 P6 on PostgreSQL: migrations 172-174 and 177 (company facts switch, place settings, the agent on a session
// and a coding-app handoff, request ids) and the queries that use them: a session for an agent
// verifies with its agent, a request id is recorded once (ON CONFLICT DO NOTHING), the company
// facts switch reads back, and the debounced projection writes the brief from PostgreSQL.
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on 127.0.0.1 with the
// migrations-pg applied (scripts/pg/integration.sh). Rows are tagged and removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';

let m = {};
let dir;
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-store-p6-'));
  mkdirSync(join(dir, '.data'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.MEMORY_EMBEDDINGS = 'hash';
  process.env.MEMORY_GRAPH_MODEL = 'off';
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
  await getDatabase({ path: process.env.DATABASE_PATH }).initialize();
  console.log = quiet.log; console.warn = quiet.warn;
  m = {
    closeDatabase,
    pool: await import('../src/db/pg/pool.ts'),
    users: (await import('../src/repositories/pg/users-store.ts')).pgUsersStore,
    projects: await import('../src/repositories/chat-conversations.ts'),
    learning: await import('../src/memory/learning.ts'),
    events: await import('../src/memory/outbox/events.ts'),
    projection: await import('../src/memory/outbox/projection.ts'),
    cap: await import('../src/memory/bridge/capability.ts'),
    store: await import('../src/memory/bridge/store.ts'),
    places: await import('../src/memory/place-settings.ts'),
  };
}

const tag = randomBytes(4).toString('hex');
const S = {};

test.before(async () => {
  if (!URL_) return;
  process.env.GIRRU_STORE_P6 = '1';
  const owner = await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' });
  S.owner = owner.id;
  S.folder = join(dir, `alpha-${tag}`);
  mkdirSync(S.folder, { recursive: true });
  S.project = await m.projects.createProject(S.owner, { name: `Alpha ${tag}`, folder: S.folder });
  S.agent = `agent-${tag}`;
  await m.pool.pgRun("INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES (?, ?, 'ollama', 'qwen-test', 0)", S.agent, `Sara ${tag}`);
});

test.after(async () => {
  if (!URL_) return;
  process.env.GIRRU_STORE_P6 = '0';
  m.projection.setProjectionDebounce(false);
  for (const t of ['change_events', 'projection_state']) await m.pool.pgRun(`DELETE FROM ${t} WHERE scope LIKE ?`, `%${tag}%`).catch(() => {});
  for (const [t, c] of [['change_scopes', 'owner_id'], ['session_capabilities', 'owner_id'], ['write_requests', 'owner_id'], ['memory_place_settings', 'owner_id'], ['task_number_dismissals', 'owner_id'], ['memory_bridge_folders', 'owner_id'], ['memory_bridge_handoffs', 'owner_id'], ['memory_versions', 'user_id'], ['memories', 'user_id'], ['chat_projects', 'user_id']]) {
    await m.pool.pgRun(`DELETE FROM ${t} WHERE ${c} = ?`, S.owner).catch(() => {});
  }
  await m.pool.pgRun('DELETE FROM agents_config WHERE id = ?', S.agent).catch(() => {});
  await m.pool.pgRun('DELETE FROM users WHERE id = ?', S.owner).catch(() => {});
  await m.closeDatabase?.();
  rmSync(dir, { recursive: true, force: true });
});

test('a session for an agent verifies with its agent; the company facts switch reads back', { skip }, async () => {
  const { token, capability } = await m.cap.launchCapability(S.owner, S.project.id, 'codex', false, S.agent);
  const v = await m.cap.verifyCapability(token);
  assert.equal(v.agentId, S.agent);
  assert.equal(v.id, capability.id);
  assert.deepEqual([...v.scopes].sort(), ['brief:read', 'handoff:write', 'memory:propose', 'memory:read']);
  assert.equal((await m.store.setCompanyFacts(S.owner, S.project.id, true)).companyFacts, true);
  assert.equal((await m.store.folderSettings(S.owner, S.project.id)).companyFacts, true);
  const h = await m.store.saveBridgeHandoff(S.owner, S.project.id, 'codex', { done: ['x'], left: [], next: [], questions: [] }, S.agent);
  const row = await m.pool.pgOne('SELECT client, agent_id FROM memory_bridge_handoffs WHERE id = ?', h.id);
  assert.deepEqual({ ...row }, { client: 'codex', agent_id: S.agent });
});

test('a request id is recorded once', { skip }, async () => {
  const first = await m.pool.pgRun('INSERT INTO write_requests (owner_id, request_id, verb) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', S.owner, `req-${tag}-01`, 'propose');
  const again = await m.pool.pgRun('INSERT INTO write_requests (owner_id, request_id, verb) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', S.owner, `req-${tag}-01`, 'propose');
  assert.equal(first.changes, 1);
  assert.equal(again.changes, 0);
  const r = await m.pool.pgOne('SELECT status FROM write_requests WHERE owner_id = ? AND request_id = ?', S.owner, `req-${tag}-01`);
  assert.equal(r.status, 'pending');
});

test('the debounced projection writes the brief once from PostgreSQL', { skip }, async () => {
  const scope = await m.events.enableScope(S.owner, S.project);
  m.projection.setProjectionDebounce(true);
  const drawer = { kind: 'project', key: m.events.projectScope(S.project).slice('project:'.length) };
  for (const n of [1, 2, 3]) await m.learning.saveVersioned(m.learning.newMemory(S.owner, drawer, { type: 'fact', importance: 6, content: `PG burst fact ${n} ${tag}.` }, {}), 'test', 'test');
  const t0 = 5_000_000;
  await m.projection.projectionTick(t0);
  await m.projection.projectionTick(t0 + m.projection.DEBOUNCE_MS);
  const st = await m.projection.syncStatus(scope);
  assert.equal(st.status, 'up_to_date');
  assert.equal(st.projectionVersion, 1);
  assert.match(readFileSync(join(S.folder, '.girru', 'brief.md'), 'utf8'), new RegExp(`PG burst fact 3 ${tag}`));
});

test('place settings (177): People stays local by default; a change reads back; a left task problem is kept once', { skip }, async () => {
  const before = (await m.places.placeSettings(S.owner)).places;
  assert.equal(before.people.staysLocal, true);
  assert.equal(before.owner.staysLocal, false);
  assert.deepEqual(await m.places.setPlaceSetting(S.owner, 'owner', true), { place: 'owner', staysLocal: true });
  await m.places.setPlaceSetting(S.owner, 'owner', true);
  await m.places.setPlaceSetting(S.owner, 'people', false);
  assert.deepEqual([...await m.places.localOnlyPlaces(S.owner)], ['owner']);
  for (let i = 0; i < 2; i++) await m.pool.pgRun('INSERT INTO task_number_dismissals (owner_id, item_id, project_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', S.owner, `item-${tag}`, S.project.id);
  const n = await m.pool.pgOne('SELECT COUNT(*) AS n FROM task_number_dismissals WHERE owner_id = ?', S.owner);
  assert.equal(Number(n.n), 1);
});
