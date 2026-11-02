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
  };
}

test.after(async () => {
  if (!URL_) return;
  const run = (s, ...a) => m.pool.pgRun(s, ...a).catch(() => {});
  await run('DELETE FROM agent_rules WHERE id LIKE ?', `%-${tag}`);
  await run('DELETE FROM boards WHERE id LIKE ?', `%-${tag}`);
  await run('DELETE FROM agents_config WHERE id LIKE ?', `%-${tag}`);
  for (const t of ['departments', 'department_merges', 'department_questions', 'memory_departments', 'memory_project_scopes']) await run(`DELETE FROM ${t} WHERE owner_id = ?`, owner);
  await run('DELETE FROM users WHERE id = ?', owner);
  await m.closeDatabase?.();
  await m.pool.closePgPool?.();
  rmSync(dir, { recursive: true, force: true });
});

test('departments scenario (PostgreSQL)', { skip }, async () => {
  owner = (await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' })).id;
  await m.scenario.runDepartmentScenario({ q: m.q, deps: m.deps, store: m.store, lifecycle: m.lifecycle, owner, tag });
});
