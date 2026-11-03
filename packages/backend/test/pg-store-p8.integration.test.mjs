// STORE-MAP-01 P8 on PostgreSQL: migration 178 (handoff blockers, files touched, card, task number,
// chat and the lead of a mid-task handoff; run_notes) and the queries that use it: a handoff saved with
// P8 on finds its card and task number, the board badges count it, the owner edits its blockers, a
// run's notes are numbered, listed, distilled without a model and cleared after 14 days (the row-value
// DELETE ... IN). Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on 127.0.0.1 with
// the migrations-pg applied (scripts/pg/integration.sh). Rows are tagged and removed afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';

let m = {};
let dir;
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-store-p8-'));
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
    boards: await import('../src/services/task-board.ts'),
    handoffs: await import('../src/memory/handoff/store.ts'),
    links: await import('../src/memory/handoff/links.ts'),
    notes: await import('../src/memory/handoff/run-notes.ts'),
  };
}

const tag = randomBytes(4).toString('hex');
const S = {};

test.before(async () => {
  if (!URL_) return;
  process.env.GIRRU_STORE_P8 = '1';
  const owner = await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' });
  S.owner = owner.id;
  S.folder = join(dir, `shop-${tag}`);
  mkdirSync(S.folder, { recursive: true });
  S.project = await m.projects.createProject(S.owner, { name: `Shop ${tag}`, folder: S.folder });
  S.chat = await m.projects.createConversation(S.owner, { title: `Login ${tag}`, projectId: S.project.id });
  S.agent = `agent-${tag}`;
  S.lead = `lead-${tag}`;
  for (const [id, name] of [[S.agent, `Omar ${tag}`], [S.lead, `Sara ${tag}`]]) await m.pool.pgRun("INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES (?, ?, 'ollama', 'qwen-test', 0)", id, name);
  S.board = await m.boards.createBoard(S.owner, { name: `Dev ${tag}` });
  S.card = await m.boards.createCard(S.owner, S.board.id, { columnId: S.board.columns[0].id, title: 'Fix login' }, { conversationId: S.chat.id });
  await m.pool.pgRun('INSERT INTO task_file_cards (card_id, project_id, task_no) VALUES (?, ?, ?)', S.card.id, S.project.id, 'T-12');
});

test.after(async () => {
  if (!URL_) return;
  delete process.env.GIRRU_STORE_P8;
  for (const [t, c] of [['run_notes', 'owner_id'], ['agent_handoffs', 'owner_id'], ['memory_file_proposals', 'user_id'], ['boards', 'owner_id'], ['chat_sessions', 'user_id'], ['chat_projects', 'user_id']]) {
    await m.pool.pgRun(`DELETE FROM ${t} WHERE ${c} = ?`, S.owner).catch(() => {});
  }
  for (const id of [S.agent, S.lead]) await m.pool.pgRun('DELETE FROM agents_config WHERE id = ?', id).catch(() => {});
  await m.pool.pgRun('DELETE FROM users WHERE id = ?', S.owner).catch(() => {});
  await m.closeDatabase?.();
  rmSync(dir, { recursive: true, force: true });
});

test('178: a handoff keeps blockers, files, its card, task number, chat and lead; badges and blockers read back', { skip }, async () => {
  const scope = { ownerId: S.owner, agentId: S.agent, kind: 'conversation', scopeId: S.chat.id, projectId: S.project.id };
  const h = await m.handoffs.saveHandoff(scope, m.handoffs.cleanHandoff({ done: ['Found it'], blockers: ['No key'], files: ['src/a.ts'] }, true), 'agent', null, { fromAgentId: S.lead });
  assert.deepEqual([h.blockers, h.files, h.cardId, h.taskNo, h.conversationId, h.fromAgentId], [['No key'], ['src/a.ts'], S.card.id, 'T-12', S.chat.id, S.lead]);
  const badges = await m.links.cardBadges(S.owner, S.board.id);
  assert.deepEqual(badges.get(S.card.id), { handoffCount: 1, blocked: true });
  const links = await m.links.cardLinks(S.owner, S.board.id, S.card.id);
  assert.deepEqual([links.taskNo, links.handoffs[0].fromAgentName, links.chats.length], ['T-12', `Sara ${tag}`, 1]);
  const edited = await m.links.setBlockers(S.owner, h.id, []);
  assert.deepEqual(edited.blockers, []);
  assert.equal((await m.links.cardBadges(S.owner, S.board.id)).get(S.card.id).blocked, false);
});

test('178: run notes are numbered, listed, distilled without a model and cleared 14 days after the last one', { skip }, async () => {
  const ref = { ownerId: S.owner, runKind: 'task', runId: `run-${tag}` };
  for (const t of ['Done: Fixed the cookie', 'Blocked: CI is down', 'just a note']) await m.notes.appendRunNote({ ...ref, agentId: S.agent, cardId: S.card.id }, t);
  const listed = await m.notes.listRunNotes(ref);
  assert.deepEqual(listed.notes.map((n) => n.seq), [1, 2, 3]);
  const scope = { ownerId: S.owner, agentId: S.agent, kind: 'conversation', scopeId: S.chat.id, projectId: S.project.id };
  const out = await m.notes.distillRun(ref, { scope, agentId: S.agent });
  const h = await m.handoffs.getHandoff(S.owner, out.handoffId);
  assert.deepEqual([h.done, h.blockers, h.runId], [['Fixed the cookie'], ['CI is down'], ref.runId]);
  await m.pool.pgRun("UPDATE run_notes SET created_at = '2000-01-01 00:00:00' WHERE run_id = ?", ref.runId);
  assert.ok(await m.notes.clearOldRunNotes() >= 3);
  assert.equal((await m.notes.listRunNotes(ref)).notes.length, 0);
});
