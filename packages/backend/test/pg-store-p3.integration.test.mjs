// STORE-MAP-01 P3 on PostgreSQL: the shared departments scenario (test/fixtures/store-p3-scenario.mjs)
// gives the same snapshots as on SQLite (test/store-p3-parity.test.mjs).
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on 127.0.0.1 with the
// migrations-pg applied (scripts/pg/integration.sh). Rows are tagged and removed afterwards.
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';
const tag = randomBytes(4).toString('hex');

let m = {};
let dir;
let owner;
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-store-p3-'));
  mkdirSync(join(dir, '.data'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;
  process.env.MEMORY_EMBEDDINGS = 'hash';
  process.env.MEMORY_GRAPH_MODEL = 'off';
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
  await getDatabase({ path: process.env.DATABASE_PATH }).initialize();
  console.log = quiet.log; console.warn = quiet.warn;
  m = {
    closeDatabase,
    pool: await import('../src/db/pg/pool.ts'),
    users: (await import('../src/repositories/pg/users-store.ts')).pgUsersStore,
    q: (await import('../src/repositories/sql-steps.ts')).q,
    deps: await import('../src/services/departments.ts'),
    store: await import('../src/memory/scopes/store.ts'),
    lifecycle: await import('../src/memory/scopes/lifecycle.ts'),
    scenario: await import('./fixtures/store-p3-scenario.mjs'),
    learning: await import('../src/memory/learning.ts'),
    storage: (await import('../src/memory/storage.ts')).getMemoryStorage(),
    validity: await import('../src/memory/validity.ts'),
    tree: await import('../src/memory/scopes/tree.ts'),
  };
}

test.after(async () => {
  if (!URL_) return;
  const run = (s, ...a) => m.pool.pgRun(s, ...a).catch(() => {});
  await run('DELETE FROM agent_rules WHERE id LIKE ?', `%-${tag}`);
  await run('DELETE FROM boards WHERE id LIKE ?', `%-${tag}`);
  await run('DELETE FROM agents_config WHERE id LIKE ?', `%-${tag}`);
  for (const t of ['departments', 'department_merges', 'department_questions', 'memory_departments', 'memory_project_scopes']) await run(`DELETE FROM ${t} WHERE owner_id = ?`, owner);
  await run('DELETE FROM memory_versions WHERE user_id = ?', owner);
  await run('DELETE FROM memories WHERE user_id = ?', owner);
  await run('DELETE FROM users WHERE id = ?', owner);
  await m.closeDatabase?.();
  await m.pool.closePgPool?.();
  rmSync(dir, { recursive: true, force: true });
});

test('departments scenario (PostgreSQL)', { skip }, async () => {
  owner = (await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' })).id;
  await m.scenario.runDepartmentScenario({ q: m.q, deps: m.deps, store: m.store, lifecycle: m.lifecycle, owner, tag });
});

test('a replaced fact, trust and the edit check (PostgreSQL)', { skip }, async () => {
  const assert = (await import('node:assert/strict')).default;
  process.env.GIRRU_STORE_P3 = '1';
  const drawer = { kind: 'owner', key: '' };
  const learnIt = (content) => m.learning.learn({ userId: owner, actor: 'agent:pg-agent', agentId: 'pg-agent', candidates: [{ content, type: 'fact', importance: 5, origin: 'agent', drawer, topicKey: `standup-${tag}` }] });
  const first = (await learnIt('Standup is at 9.')).saved[0];
  const second = (await learnIt('Standup is at 10.')).updated[0];
  assert.notEqual(second.id, first.id);
  const [old] = await m.q.all('SELECT status, superseded_by, valid_to, trust, source FROM memories WHERE id = ?', first.id);
  assert.equal(old.status, 'replaced');
  assert.equal(old.superseded_by, second.id);
  assert.ok(old.valid_to);
  assert.deepEqual([old.source, old.trust], ['agent', 'unchecked']);
  assert.equal((await m.storage.getByTopicKey(owner, drawer, `standup-${tag}`)).id, second.id);
  const hits = await m.storage.search({ userId: owner, query: 'standup', drawers: [drawer], limit: 10 });
  assert.ok(!hits.some((h) => h.memory.id === first.id));
  assert.ok(!(await m.tree.exploreScope(owner, { scope: 'company' })).items.some((i) => i.id === first.id));
  assert.ok((await m.tree.exploreScope(owner, { scope: 'company', replaced: 'show' })).items.some((i) => i.id === first.id));
  assert.equal(await m.validity.setChecked(owner, second.id, true), 'checked');
  const v = (await m.validity.validityOf(owner, second.id)).version;
  await m.learning.updateVersioned(owner, second.id, { content: 'Standup is at 11.' }, owner, 'test', v);
  await assert.rejects(m.learning.updateVersioned(owner, second.id, { content: 'stale' }, owner, 'test', v), (err) => err.status === 409 && err.current.version === v + 1);
  await m.q.run('UPDATE memories SET source = NULL WHERE user_id = ?', owner);
  assert.ok(await m.validity.backfillProvenance(1) >= 2);
  assert.equal(Number((await m.q.all('SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND source IS NULL', owner))[0].n), 0);
});

test('an older Girru never opens newer data (PostgreSQL)', { skip }, async () => {
  const assert = (await import('node:assert/strict')).default;
  const { initializeDatabase } = await import('../src/db/index.ts');
  process.env.GIRRU_STORE_P3 = '1';
  process.env.GIRRU_APP_VERSION = '1.6.0-pg';
  await initializeDatabase();
  const [row] = await m.q.all('SELECT written_by FROM schema_layout WHERE id = 1');
  assert.equal(row.written_by, '1.6.0-pg');
  const id = `9${tag.slice(0, 5)}`;
  await m.q.run('INSERT INTO migrations (id, name) VALUES (?, ?)', id, `${id}_from_the_future`);
  try {
    await assert.rejects(initializeDatabase(), (err) => err.kind === 'layout_newer' && err.details.unknown.includes(id));
  } finally {
    await m.q.run('DELETE FROM migrations WHERE id = ?', id);
  }
  await initializeDatabase();
});

test('project keys move to ids and back (PostgreSQL)', { skip }, async () => {
  const assert = (await import('node:assert/strict')).default;
  const projects = await import('../src/repositories/chat-conversations.ts');
  const keys = await import('../src/memory/project-keys.ts');
  delete process.env.GIRRU_STORE_P3;
  const p = await projects.createProject(owner, { name: `Gamma ${tag}` });
  const mem = await m.learning.saveVersioned(m.learning.newMemory(owner, { kind: 'project', key: p.slug }, { type: 'fact', importance: 5, content: 'Gamma ships monthly.' }, { source: 'owner' }), owner, 'test');
  await m.learning.saveVersioned(m.learning.newMemory(owner, { kind: 'project', key: `notes-${tag}` }, { type: 'fact', importance: 5, content: 'Loose notes.' }, { source: 'owner' }), owner, 'test');
  process.env.GIRRU_STORE_P3 = '1';
  const r = await keys.moveProjectKeys('id');
  assert.ok(r.some((x) => x.created >= 1));
  assert.equal((await m.q.all('SELECT drawer_key FROM memories WHERE id = ?', mem.id))[0].drawer_key, p.id);
  assert.equal((await m.q.all('SELECT drawer_key FROM memory_versions WHERE memory_id = ? LIMIT 1', mem.id))[0].drawer_key, p.id);
  assert.equal(await keys.currentProjectKey(owner, p.slug), p.id);
  delete process.env.GIRRU_STORE_P3;
  await keys.moveProjectKeys('slug');
  assert.equal((await m.q.all('SELECT drawer_key FROM memories WHERE id = ?', mem.id))[0].drawer_key, p.slug);
  await m.q.run('DELETE FROM memory_project_keys WHERE owner_id = ?', owner);
  await m.q.run('DELETE FROM memory_key_state WHERE owner_id = ?', owner);
  await m.q.run('DELETE FROM chat_projects WHERE user_id = ?', owner);
});
