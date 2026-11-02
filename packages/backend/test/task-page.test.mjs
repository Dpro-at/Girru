// TASKPAGE-02: the full task page — people and agents with roles, checklist owners and dates,
// sub-tasks, "waits for" (never a circle), release, follow, every chat's replies and file
// changes (with the diff) in one activity line, what the chats spent. Owner only.
// Throwaway DB/keys/folders; no network.
// Run: node --import tsx --test test/task-page.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-task-page-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
for (const [id, role, name] of [['p-owner', 'owner', 'Mohamed'], ['p-sara', 'user', 'Sara']]) {
  db.prepare(`INSERT INTO users (id, email, username, full_name, password_hash, role, status, email_verified) VALUES (?, ?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, name, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('g-lead', 'Backend Lead', 'ollama', 'qwen-test', 1), ('g-qa', 'QA Tester', 'ollama', 'qwen-test', 0)`).run();

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { snapshot } = await import(join(backendDir, 'src/services/chat-checkpoints.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const call = (user, method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(user, 1)}` }, ...(payload ? { payload } : {}) });
const ok = async (r, code = 200) => { const x = await r; assert.equal(x.statusCode, code, x.body); return x.json(); };

const boardId = (await ok(call('p-owner', 'GET', '/api/boards'))).boards[0].id;
const board = await ok(call('p-owner', 'GET', `/api/boards/${boardId}`));
const col = (name) => board.columns.find((c) => c.name.toLowerCase() === name).id;
const newCard = async (title) => ok(call('p-owner', 'POST', `/api/boards/${boardId}/cards`, { columnId: col('to do'), title, agents: ['g-lead'] }), 201);
const main = await newCard('Fix the sign-in timeout');
const base = `/api/boards/${boardId}/cards/${main.id}`;
const page = async () => (await ok(call('p-owner', 'GET', `${base}/page`))).page;

test('people and agents with what they do; a card edit keeps the roles; owner only', async () => {
  await ok(call('p-owner', 'PUT', `${base}/people`, { kind: 'user', id: 'p-sara', role: 'checks' }));
  await ok(call('p-owner', 'PUT', `${base}/people`, { kind: 'agent', id: 'g-qa', role: 'tests' }));
  await ok(call('p-owner', 'PUT', `${base}/people`, { kind: 'agent', id: 'g-lead', role: 'does' }));
  let p = await page();
  assert.deepEqual(p.people.map((x) => [x.kind, x.name, x.role]), [['user', 'Sara', 'checks'], ['agent', 'Backend Lead', 'does'], ['agent', 'QA Tester', 'tests']]);
  assert.equal(p.openedBy.name, 'Mohamed');
  assert.ok(p.team.some((u) => u.name === 'Sara'));
  const card = (await ok(call('p-owner', 'GET', `/api/boards/${boardId}`))).cards.find((c) => c.id === main.id);
  await ok(call('p-owner', 'PUT', base, { expectedVersion: card.version, agents: ['g-lead', 'g-qa'], title: 'Fix the sign-in timeout on desktop' }));
  p = await page();
  assert.equal(p.people.find((x) => x.id === 'g-qa').role, 'tests', 'an agent that stays keeps its role');
  await ok(call('p-owner', 'PUT', `${base}/people`, { kind: 'user', id: 'p-sara', role: null }));
  assert.equal((await page()).people.some((x) => x.id === 'p-sara'), false);
  for (const b of [{ kind: 'user', id: 'nobody', role: 'does' }, { kind: 'agent', id: 'g-qa', role: 'boss' }, { kind: 'team', id: 'x', role: 'does' }])
    assert.equal((await call('p-owner', 'PUT', `${base}/people`, b)).statusCode, 400, JSON.stringify(b));
  assert.equal((await call('p-sara', 'GET', `${base}/page`)).statusCode, 403);
  assert.equal((await call('p-sara', 'PUT', `${base}/people`, { kind: 'user', id: 'p-sara', role: 'does' })).statusCode, 403);
});

test('checklist items: an owner (person or agent), a due date, a new place', async () => {
  for (const t of ['Find why', 'Refresh early', 'Test on Windows']) await ok(call('p-owner', 'POST', `${base}/checklist`, { text: t }), 201);
  const items = (await ok(call('p-owner', 'GET', `${base}/checklist`))).items;
  let r = await ok(call('p-owner', 'PUT', `${base}/checklist/${items[2].id}`, { owner: { kind: 'agent', id: 'g-qa' }, dueDate: '2026-10-31' }));
  assert.deepEqual([r.items[2].owner, r.items[2].dueDate], [{ kind: 'agent', id: 'g-qa' }, '2026-10-31']);
  r = await ok(call('p-owner', 'PUT', `${base}/checklist/${items[2].id}`, { beforeItemId: items[0].id }));
  assert.deepEqual(r.items.map((i) => i.text), ['Test on Windows', 'Find why', 'Refresh early']);
  r = await ok(call('p-owner', 'PUT', `${base}/checklist/${items[2].id}`, { owner: null, dueDate: null }));
  assert.equal(r.items[0].owner, null);
  assert.equal((await call('p-owner', 'PUT', `${base}/checklist/${items[0].id}`, { owner: { kind: 'agent', id: 'ghost' } })).statusCode, 400);
});

test('sub-tasks, waits for (never a circle), release and follow', async () => {
  const sub = await ok(call('p-owner', 'POST', `${base}/subtasks`, { title: 'Write the release note' }), 201);
  const other = await newCard('Windows test machine');
  await ok(call('p-owner', 'PUT', `${base}/links`, { waitsFor: other.id, on: true }));
  assert.equal((await call('p-owner', 'PUT', `/api/boards/${boardId}/cards/${other.id}/links`, { waitsFor: main.id, on: true })).statusCode, 400, 'no circle');
  assert.equal((await call('p-owner', 'PUT', `${base}/links`, { waitsFor: main.id, on: true })).statusCode, 400, 'not itself');
  await ok(call('p-owner', 'PUT', `${base}/release`, { name: '  Nabu  ' }));
  await ok(call('p-owner', 'PUT', `${base}/follow`, { on: true }));
  const p = await page();
  assert.deepEqual(p.subtasks.map((s) => [s.title, s.done]), [['Write the release note', false]]);
  assert.deepEqual(p.waitsFor.map((s) => s.title), ['Windows test machine']);
  assert.equal(p.release, 'Nabu');
  assert.deepEqual([p.following, p.followers], [true, 1]);
  const subPage = (await ok(call('p-owner', 'GET', `/api/boards/${boardId}/cards/${sub.id}/page`))).page;
  assert.equal(subPage.parent.title, 'Fix the sign-in timeout on desktop');
  const otherPage = (await ok(call('p-owner', 'GET', `/api/boards/${boardId}/cards/${other.id}/page`))).page;
  assert.deepEqual(otherPage.blocks.map((s) => s.title), ['Fix the sign-in timeout on desktop']);
});

test('activity: moves, people, comments, every reply of its chats with the files it changed, the diff; spent by app', async () => {
  // A project folder in git, and a reply that changed one file (before/after snapshots).
  const folder = mkdtempSync(join(dir, 'proj-'));
  execFileSync('git', ['init', '-q', folder]);
  writeFileSync(join(folder, 'token.ts'), 'const a = 1;\nif (expired) refresh();\n');
  execFileSync('git', ['-C', folder, 'add', '-A']);
  execFileSync('git', ['-C', folder, '-c', 'user.email=t@example.test', '-c', 'user.name=t', 'commit', '-qm', 'x']);
  const before = await snapshot(folder);
  writeFileSync(join(folder, 'token.ts'), 'const a = 1;\n// refresh a minute early\nif (expiresSoon) refresh();\n');
  const after = await snapshot(folder);
  assert.ok(before && after && before !== after);
  db.prepare(`INSERT INTO chat_projects (id, user_id, name, slug, folder) VALUES ('pr1', 'p-owner', 'Dpro', 'dpro', ?)`).run(folder);
  db.prepare(`INSERT INTO chat_sessions (id, user_id, title, model, project_id, agent_id) VALUES ('chat-one', 'p-owner', 'Sign-in bug', 'subscription:claude', 'pr1', 'g-lead'), ('chat-two', 'p-owner', 'T-7 continue', 'subscription:codex', 'pr1', 'g-qa')`).run();
  db.prepare(`INSERT INTO chat_messages (id, session_id, role, content, created_at, model, tokens_in, tokens_out, agent_id, checkpoint_folder, checkpoint_before, checkpoint_after, checkpoint_files, checkpoint_added, checkpoint_removed, checkpoint_undone)
    VALUES ('m-1', 'chat-one', 'assistant', 'I found it: refresh a minute early.', '2099-01-01 10:00:00', 'subscription:claude', 1500, 600, 'g-lead', ?, ?, ?, 1, 2, 1, 0),
           ('m-2', 'chat-two', 'assistant', 'Added the test.', '2099-01-01 11:00:00', 'subscription:codex', 900, 100, 'g-qa', NULL, NULL, NULL, NULL, NULL, NULL, NULL)`).run(folder, before, after);
  db.prepare(`UPDATE board_cards SET conversation_id = 'chat-one' WHERE id = ?`).run(main.id);
  db.prepare(`INSERT INTO board_card_chats (card_id, conversation_id) VALUES (?, 'chat-two')`).run(main.id);
  await ok(call('p-owner', 'POST', `${base}/comments`, { body: 'Can someone lend a Windows machine?' }), 201);
  const a = await ok(call('p-owner', 'GET', `${base}/activity`));
  const kinds = a.items.map((x) => x.kind);
  assert.ok(kinds.includes('event') && kinds.includes('comment'));
  const replies = a.items.filter((x) => x.kind === 'reply');
  assert.deepEqual(replies.map((r) => [r.actor.name, r.app, r.chat.title, r.tokens]), [['Backend Lead', 'Claude Code', 'Sign-in bug', 2100], ['QA Tester', 'Codex', 'T-7 continue', 1000]]);
  assert.deepEqual(replies[0].change, { messageId: 'm-1', files: 1, added: 2, removed: 1, undone: false });
  assert.ok(a.items.some((x) => x.kind === 'event' && x.event === 'added' && x.detail.startsWith('agent:g-qa')), 'people changes are in the line');
  for (let i = 1; i < a.items.length; i++) assert.ok(a.items[i - 1].at <= a.items[i].at, 'oldest first');
  const d = await ok(call('p-owner', 'GET', `${base}/activity/m-1/diff`));
  assert.equal(d.files[0].path, 'token.ts');
  assert.deepEqual([d.files[0].added, d.files[0].removed], [2, 1]);
  assert.ok(d.files[0].lines.includes('+// refresh a minute early'), JSON.stringify(d.files[0].lines));
  assert.equal((await call('p-owner', 'GET', `${base}/activity/m-2/diff`)).statusCode, 404, 'a reply without changes has no diff');
  const p = await page();
  assert.deepEqual(p.chats.map((c) => c.title), ['Sign-in bug', 'T-7 continue']);
  assert.deepEqual(p.spent.map((s) => [s.app, s.tokens, s.paid]), [['Claude Code', 2100, false], ['Codex', 1000, false]]);
  assert.deepEqual([p.files.count, p.files.added, p.files.removed, p.files.paths], [1, 2, 1, ['token.ts']]);
  assert.equal(p.development.branch !== null, true);
  // A chat of another owner never shows.
  db.prepare(`INSERT INTO chat_sessions (id, user_id, title, model) VALUES ('chat-sara', 'p-sara', 'Hers', 'x')`).run();
  db.prepare(`INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES ('m-3', 'chat-sara', 'assistant', 'secret', '2099-01-02 10:00:00')`).run();
  db.prepare(`INSERT INTO board_card_chats (card_id, conversation_id) VALUES (?, 'chat-sara')`).run(main.id);
  assert.equal((await ok(call('p-owner', 'GET', `${base}/activity`))).items.some((x) => x.kind === 'reply' && x.text === 'secret'), false);
  assert.equal((await call('p-owner', 'GET', `${base}/activity?before=yesterday`)).statusCode, 400);
});

test('TASKPAGE-03: a task repeats every hour / day / week; a due run starts a Continue once; paused and archived wait', async () => {
  const sch = await import(join(backendDir, 'src/services/card-schedules.ts'));
  const { cardContinueMessage } = await import(join(backendDir, 'src/services/task-page.ts'));
  const rep = await newCard('Check the night build');
  const url = `/api/boards/${boardId}/cards/${rep.id}/schedule`;
  assert.deepEqual(await ok(call('p-owner', 'GET', url)), { schedule: null });
  assert.equal((await call('p-owner', 'PUT', url, { every: 'weekly', at: '08:00' })).statusCode, 400, 'weekly needs a weekday');
  assert.equal((await call('p-owner', 'PUT', url, { every: 'daily', at: '25:00' })).statusCode, 400);
  assert.equal((await call('p-owner', 'PUT', url, { every: 'daily', at: '07:00', agentId: 'ghost' })).statusCode, 400);
  const s = (await ok(call('p-owner', 'PUT', url, { every: 'daily', at: '07:00', agentId: 'g-qa', model: 'subscription:codex' }))).schedule;
  assert.deepEqual([s.every, s.at, s.agentId, s.model, s.paused], ['daily', '07:00', 'g-qa', 'subscription:codex', false]);
  assert.ok(new Date(s.nextRun) > new Date());
  const b = await ok(call('p-owner', 'GET', `/api/boards/${boardId}`));
  assert.equal(b.cards.find((c) => c.id === rep.id).repeat.every, 'daily');
  assert.equal(b.cards.find((c) => c.id === main.id).repeat, null);
  assert.equal((await call('p-sara', 'PUT', url, { every: 'hourly', at: '00:15' })).statusCode, 403);
  // A due run: claimed once (the next run moves on before it starts), logged, result kept.
  db.prepare(`UPDATE card_schedules SET next_run = '2000-01-01T00:00:00.000Z' WHERE card_id = ?`).run(rep.id);
  const runs = [];
  const start = async (...a) => { runs.push(a); return 'started'; };
  assert.equal(await sch.runDueCardSchedules(start), 1);
  assert.equal(await sch.runDueCardSchedules(start), 0, 'not twice');
  assert.deepEqual(runs[0].slice(0, 5), ['p-owner', boardId, rep.id, 'g-qa', 'subscription:codex']);
  assert.match(runs[0][5], /^cardsch-[0-9a-f-]{36}$/, 'RUNS-01: a scheduled card run has its own run id');
  const after = (await ok(call('p-owner', 'GET', url))).schedule;
  assert.equal(after.lastResult, 'started');
  assert.ok(after.lastRun && new Date(after.nextRun) > new Date());
  const a = await ok(call('p-owner', 'GET', `/api/boards/${boardId}/cards/${rep.id}/activity`));
  assert.ok(a.items.some((x) => x.kind === 'event' && x.event === 'ran' && x.detail === 'started'));
  assert.ok(a.items.some((x) => x.kind === 'event' && x.event === 'repeats'));
  // Paused: nothing runs. A busy run says so.
  await ok(call('p-owner', 'PUT', url, { every: 'hourly', at: '00:15', paused: true }));
  db.prepare(`UPDATE card_schedules SET next_run = '2000-01-01T00:00:00.000Z' WHERE card_id = ?`).run(rep.id);
  assert.equal(await sch.runDueCardSchedules(start), 0);
  await ok(call('p-owner', 'PUT', url, { every: 'hourly', at: '00:15' }));
  db.prepare(`UPDATE card_schedules SET next_run = '2000-01-01T00:00:00.000Z' WHERE card_id = ?`).run(rep.id);
  await sch.runDueCardSchedules(async () => 'busy');
  assert.equal((await ok(call('p-owner', 'GET', url))).schedule.lastResult, 'busy');
  // Never: the schedule goes, the task stays (PUT { every: 'never' } or DELETE).
  assert.deepEqual(await ok(call('p-owner', 'PUT', url, { every: 'never' })), { schedule: null });
  await ok(call('p-owner', 'PUT', url, { every: 'hourly', at: '00:15' }));
  assert.deepEqual(await ok(call('p-owner', 'DELETE', url)), { schedule: null });
  assert.deepEqual(await ok(call('p-owner', 'GET', url)), { schedule: null });
  // A task with no task file continues from the card itself.
  await ok(call('p-owner', 'POST', `/api/boards/${boardId}/cards/${rep.id}/checklist`, { text: 'Read the build log' }), 201);
  const m = await cardContinueMessage('p-owner', boardId, rep.id);
  assert.match(m.message, /^Continue the board task "Check the night build"/);
  assert.match(m.message, /Open checklist items:\n- Read the build log/);
  assert.match(m.message, /board_check/);
});
