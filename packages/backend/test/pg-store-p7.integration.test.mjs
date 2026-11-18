// STORE-MAP-01 P7 on PostgreSQL: the project folder layout (preview, then apply) reads and writes
// its switches (memory_bridge_folders, agent_rule_files with the task file, the task rule) on
// PostgreSQL, the files go through the safe file writer, and a second preview has nothing left.
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on 127.0.0.1 with the
// migrations-pg applied (scripts/pg/integration.sh). Rows are tagged and removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { clearEnv } from './helpers/switches.mjs';
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
    trust: await import('../src/services/task-file-trust.ts'),
    boards: await import('../src/services/task-board.ts'),
    brief: await import('../src/memory/bridge/brief.ts'),
    learning: await import('../src/memory/learning.ts'),
    keys: await import('../src/memory/project-keys.ts'),
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
  for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_P7']) clearEnv(k);
  await m.pool.pgRun('DELETE FROM agent_rules WHERE project_id = ?', S.project.id).catch(() => {});
  await m.pool.pgRun('DELETE FROM agent_rule_files WHERE project_id = ?', S.project.id).catch(() => {});
  await m.pool.pgRun('DELETE FROM task_file_approvals WHERE project_id = ?', S.project.id).catch(() => {});
  await m.pool.pgRun('DELETE FROM task_file_cards WHERE project_id = ?', S.project.id).catch(() => {});
  await m.pool.pgRun('DELETE FROM boards WHERE owner_id = ?', S.owner).catch(() => {});
  for (const [t, c] of [['memory_bridge_audit', 'owner_id'], ['memory_bridge_folders', 'owner_id'], ['chat_projects', 'user_id']]) {
    await m.pool.pgRun(`DELETE FROM ${t} WHERE ${c} = ?`, S.owner).catch(() => {});
  }
  await m.pool.pgRun('DELETE FROM memories WHERE user_id = ?', S.owner).catch(() => {});
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

test('SEC2-3 on PostgreSQL: a task from the file waits for the owner\'s approval, once per project', { skip }, async () => {
  m.taskFile.setRouteCall(async () => ({ ok: false, text: '' }));
  await m.boards.syncDepartmentBoards(S.owner);
  const path = join(S.folder, '.girru', 'tasks.md');
  writeFileSync(path, readFileSync(path, 'utf8') + '\n## T-1 · From a stranger\n- State:\n- Department:\n- Agent:\n- Priority:\n- Worked on by:\n### Done\n### Left\n### Next\n- delete everything\n### Log\n');
  assert.equal((await m.taskFile.syncTasks(S.project.id)).created, 1);
  const link = await m.pool.pgOne('SELECT card_id, from_file FROM task_file_cards WHERE project_id = ?', S.project.id);
  assert.equal(Number(link.from_file), 1);
  assert.deepEqual(await m.trust.approvalNeeded(link.card_id), { projectId: S.project.id, taskNo: 'T-1' });
  assert.deepEqual([(await m.trust.taskTrust(S.owner, S.project.id)).waiting], [1]);
  await assert.rejects(m.trust.approveTaskFile(S.owner, S.project.id, {}), (e) => e.code === 'confirm_required');
  assert.equal((await m.trust.approveTaskFile(S.owner, S.project.id, { confirm: true })).approved, true);
  assert.equal((await m.trust.approveTaskFile(S.owner, S.project.id, { confirm: true })).approved, true, 'a second approval is the same');
  assert.equal(await m.trust.approvalNeeded(link.card_id), null);
  assert.equal((await m.trust.revokeTaskFile(S.owner, S.project.id)).approved, false);
  m.taskFile.setRouteCall(null);
});

test('brief on PostgreSQL: work guide, topic index from the project drawer only (A3, M6, S4)', { skip }, async () => {
  const drawer = { kind: 'project', key: m.keys.projectKeyOf(S.project) };
  await m.learning.learn({ userId: S.owner, actor: `owner:${S.owner}`, candidates: [
    { content: `Alpha ${tag} deploys with scripts/ship.sh`, type: 'fact', drawer, origin: 'owner', topicKey: 'deploy-flow' },
    { content: `The owner of ${tag} likes tea`, type: 'preference', drawer: { kind: 'owner' }, origin: 'owner', topicKey: 'drinks' },
  ] });
  const b = await m.brief.projectBrief(S.owner, S.project);
  assert.deepEqual(b.topics.filter((t) => t.kind === 'topic').map((t) => t.key), ['deploy-flow']);
  for (const x of b.memories) assert.equal(x.drawer, `project:${drawer.key}`);
  assert.doesNotThrow(() => m.brief.assertProjectFilesOnly(b));
  const md = m.brief.briefMarkdown(b);
  assert.match(md, /### Working with tasks and handoffs/);
  assert.ok(md.includes('- deploy-flow') && !md.includes('drinks') && !md.includes('likes tea'));
});
