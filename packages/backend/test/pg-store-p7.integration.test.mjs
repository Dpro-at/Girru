// STORE-MAP-01 P7 on PostgreSQL: the project folder layout (preview, then apply) reads and writes
// its switches (memory_bridge_folders, agent_rule_files with the task file, the task rule) on
// PostgreSQL, the files go through the safe file writer, and a second preview has nothing left.
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
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-store-p7-'));
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
    rules: await import('../src/services/agent-rules.ts'),
    layout: await import('../src/memory/bridge/layout.ts'),
    store: await import('../src/memory/bridge/store.ts'),
    taskFile: await import('../src/services/task-file.ts'),
  };
}

const tag = randomBytes(4).toString('hex');
const S = {};

test.before(async () => {
  if (!URL_) return;
  process.env.GIRRU_STORE_P2 = '1';
  process.env.GIRRU_STORE_P7 = '1';
  const owner = await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' });
  S.owner = owner.id;
  S.folder = join(dir, `alpha-${tag}`);
  mkdirSync(S.folder, { recursive: true });
  S.project = await m.projects.createProject(S.owner, { name: `Alpha ${tag}`, folder: S.folder });
  S.rule = await m.rules.createRule({ text: `In Alpha ${tag}, release only on Tuesdays.`, when: null, projectId: S.project.id, who: 'all', targets: [], paused: false }, S.owner);
});

test.after(async () => {
  if (!URL_) return;
  for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_P7']) delete process.env[k];
  await m.pool.pgRun('DELETE FROM agent_rules WHERE project_id = ?', S.project.id).catch(() => {});
  await m.pool.pgRun('DELETE FROM agent_rule_files WHERE project_id = ?', S.project.id).catch(() => {});
  for (const [t, c] of [['memory_bridge_audit', 'owner_id'], ['memory_bridge_folders', 'owner_id'], ['chat_projects', 'user_id']]) {
    await m.pool.pgRun(`DELETE FROM ${t} WHERE ${c} = ?`, S.owner).catch(() => {});
  }
  await m.pool.pgRun('DELETE FROM users WHERE id = ?', S.owner).catch(() => {});
  await m.closeDatabase?.();
  rmSync(dir, { recursive: true, force: true });
});

test('layout on PostgreSQL: preview, apply, switches on, nothing left to change', { skip }, async () => {
  const p = await m.layout.layoutPreview(S.owner, S.project.id);
  assert.equal(p.conflicts, 0);
  assert.ok(p.files.some((f) => f.relative === '.girru/tasks.md' && f.action === 'create'));
  const r = await m.layout.layoutApply(S.owner, S.project.id, { previewHash: p.previewHash, confirm: true });
  assert.equal(r.changes, 0, JSON.stringify(r.files.filter((f) => f.action !== 'unchanged')));
  assert.match(readFileSync(join(S.folder, 'AGENTS.md'), 'utf8'), new RegExp(`In Alpha ${tag}, release only on Tuesdays`));
  assert.match(readFileSync(join(S.folder, '.girru', 'tasks.md'), 'utf8'), /^# /);
  assert.equal((await m.store.folderSettings(S.owner, S.project.id)).filesEnabled, true);
  assert.equal(await m.taskFile.taskFileOn(S.project.id), true);
  const row = await m.pool.pgOne('SELECT tasks, written_at FROM agent_rule_files WHERE project_id = ?', S.project.id);
  assert.equal(Number(row.tasks), 1);
  assert.ok(row.written_at);
});
