// STORE-MAP-01 pilot on PostgreSQL: the migration-163 triggers write change events in the same
// transaction as the memory write (none after a rollback, none for drawers that are not opted in),
// the brief projection renders from PostgreSQL, and session capabilities verify there too.
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
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-store-pilot-'));
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
    storage: (await import('../src/memory/storage.ts')).getMemoryStorage(),
    steps: await import('../src/repositories/sql-steps.ts'),
    events: await import('../src/memory/outbox/events.ts'),
    projection: await import('../src/memory/outbox/projection.ts'),
    cap: await import('../src/memory/bridge/capability.ts'),
  };
}

const tag = randomBytes(4).toString('hex');
const all = (sql, ...p) => m.pool.pgAll(sql, ...p);
const S = {};

test.before(async () => {
  if (!URL_) return;
  const owner = await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' });
  S.owner = owner.id;
  S.folder = join(dir, 'alpha');
  mkdirSync(S.folder, { recursive: true });
  S.project = await m.projects.createProject(S.owner, { name: `Alpha ${tag}`, folder: S.folder });
  S.other = await m.projects.createProject(S.owner, { name: `Beta ${tag}`, folder: null });
});

test.after(async () => {
  if (!URL_) return;
  for (const t of ['change_events', 'projection_state']) await m.pool.pgRun(`DELETE FROM ${t} WHERE scope LIKE ?`, `%${tag}%`).catch(() => {});
  await m.pool.pgRun('DELETE FROM change_scopes WHERE owner_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM session_capabilities WHERE owner_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM memory_versions WHERE user_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM memories WHERE user_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM chat_projects WHERE user_id = ?', S.owner).catch(() => {});
  await m.pool.pgRun('DELETE FROM users WHERE id = ?', S.owner).catch(() => {});
  await m.closeDatabase?.();
  await m.pool.closePgPool?.();
  rmSync(dir, { recursive: true, force: true });
});

const save = (content, drawer) => m.learning.saveVersioned(m.learning.newMemory(S.owner, drawer, { type: 'fact', importance: 6, content }, {}), 'test', 'test');

test('triggers: events in the same transaction, none before opt-in, none after a rollback', { skip }, async () => {
  const drawer = { kind: 'project', key: S.project.slug };
  await save('before opt-in', drawer);
  const scope = await m.events.enableScope(S.owner, S.project);
  S.scope = scope;
  assert.equal((await all('SELECT seq FROM change_events WHERE scope = ?', scope)).length, 0);
  const mem = await save('Alpha ships on Tuesdays.', drawer);
  const ev = await all('SELECT op, entity_id, record_version FROM change_events WHERE scope = ? ORDER BY seq', scope);
  assert.deepEqual(ev.map((e) => e.op), ['insert', 'version']);
  assert.equal(Number(ev[1].record_version), 1);
  assert.equal(ev[1].entity_id, mem.id);
  const doomed = m.learning.newMemory(S.owner, drawer, { type: 'fact', importance: 5, content: 'never saved' }, {});
  await m.storage.ensureEmbedding(doomed);
  const storage = m.storage;
  await assert.rejects(m.steps.sql().tx(function* () { yield* storage.writeRowStep(doomed); throw new Error('boom'); }), /boom/);
  assert.equal((await all('SELECT seq FROM change_events WHERE scope = ?', scope)).length, 2);
  await save('Beta fact', { kind: 'project', key: S.other.slug });
  assert.equal((await all('SELECT seq FROM change_events WHERE scope = ?', scope)).length, 2);
});

test('projection and capability work on PostgreSQL', { skip }, async () => {
  const r = await m.projection.runBriefProjection(S.scope);
  assert.equal(r.status, 'up_to_date');
  assert.match(readFileSync(join(S.folder, '.girru', 'brief.md'), 'utf8'), /Alpha ships on Tuesdays/);
  const { token } = await m.cap.issueCapability({ ownerId: S.owner, actorId: S.owner, actorRole: 'owner', projectId: S.project.id, scopes: ['brief:read'] });
  const c = await m.cap.verifyCapability(token);
  assert.equal(c.projectId, S.project.id);
  assert.deepEqual(c.scopes, ['brief:read']);
});
