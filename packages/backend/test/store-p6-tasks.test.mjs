// STORE-MAP-01 P6 (GIRRU_STORE_P6): hidden ids and version stamps in .girru/tasks.md (T5, S2, SEC2-5).
//  - every linked task gets Girru's hidden line `<!-- girru:id=<card> v=<version> -->` under its heading;
//  - a task renumbered or renamed in the file keeps its card (by id), never makes a second one;
//  - a duplicate, unknown or foreign id is a review item (a visible problem) and nothing is written;
//  - switch off: no hidden lines are written; a file that has them still reads.
// Run: node --import tsx --test test/store-p6-tasks.test.mjs
// Throwaway DB + project folder, random test-only secrets, no network, no local model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-p6-tasks-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
delete process.env.GIRRU_STORE_P6;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.info = quiet; console.warn = quiet;

const fmt = await import(join(backendDir, 'src/services/task-file-format.ts'));

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
for (const [id, role] of [['t-owner', 'owner'], ['t-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary, department, role) VALUES
  ('a-main', 'Main', 'ollama', 'qwen-test', 1, NULL, NULL), ('a-dev', 'Dev', 'ollama', 'qwen-test', 0, 'development', 'specialist'),
  ('a-lead', 'Dev Lead', 'ollama', 'qwen-test', 0, 'development', 'manager'), ('a-res', 'Researcher', 'ollama', 'qwen-test', 0, 'research', 'specialist')`).run();
const folder = mkdtempSync(join(dir, 'proj-'));
db.prepare(`INSERT INTO chat_projects (id, user_id, name, slug, folder) VALUES ('p-tf', 't-owner', 'Dpro', 'dpro', ?)`).run(folder);
db.prepare(`INSERT INTO chat_sessions (id, user_id, title, model, project_id) VALUES ('s-tf', 't-owner', 'In Dpro', 'qwen-test', 'p-tf')`).run();

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const tf = await import(join(backendDir, 'src/services/task-file.ts'));
const { boardTaskUpdateTool, boardMoveTool } = await import(join(backendDir, 'src/tools/board/board-tools.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const call = (user, method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(user, 1)}` }, ...(payload ? { payload } : {}) });
const tasks = () => readFileSync(join(folder, '.girru/tasks.md'), 'utf8');
const done = () => (existsSync(join(folder, '.girru/tasks-done.md')) ? readFileSync(join(folder, '.girru/tasks-done.md'), 'utf8') : '');
const block = (no, text = tasks()) => fmt.readTasks(text).tasks.find((t) => t.task.no === no)?.task;
const boards = async () => (await call('t-owner', 'GET', '/api/boards')).json().boards;
const board = async (id) => (await call('t-owner', 'GET', `/api/boards/${id}`)).json();
const cardOf = async (no) => {
  for (const b of await boards()) { const c = (await board(b.id)).cards.find((x) => x.taskFile?.no === no); if (c) return { board: await board(b.id), card: c }; }
  return null;
};

const on = () => { process.env.GIRRU_STORE_P6 = '1'; };
const off = () => { delete process.env.GIRRU_STORE_P6; };
const HID = /<!-- girru:id=([A-Za-z0-9_-]+) v=(\d+) -->/g;
const ids = (text = tasks()) => [...text.matchAll(HID)].map((m) => m[1]);
const block1 = (no, title, dept = 'Development') => `## ${no} · ${title}\n- State: To do\n- Department: ${dept}\n- Agent:\n- Priority:\n- Worked on by:\n### Done\n### Left\n### Next\n### Log\n`;
const cardCount = () => db.prepare('SELECT COUNT(*) AS n FROM task_file_cards WHERE project_id = ?').get('p-tf').n;
const problemsOf = () => JSON.parse(db.prepare('SELECT task_problems FROM agent_rule_files WHERE project_id = ?').get('p-tf').task_problems);

test('setup: files on for the project', async () => {
  tf.setRouteCall(async () => ({ ok: false, text: '' }));
  assert.equal((await call('t-owner', 'POST', '/api/boards/sync-departments', {})).statusCode, 200);
  assert.equal((await call('t-owner', 'POST', '/api/agent-rules/files/p-tf', { mode: 'private' })).statusCode, 200);
});

test('format: the hidden line is read apart from the task and stamped in place, byte for byte otherwise', () => {
  const text = `# Tasks\n\nmine\n\n${block1('T-1', 'One')}\n${block1('T-2', 'Two')}`;
  const stamped = fmt.stampTasks(text, new Map([['T-2', { id: 'card_b', v: 3 }]]));
  assert.equal(stamped, text.replace('## T-2 · Two\n', '## T-2 · Two\n<!-- girru:id=card_b v=3 -->\n'));
  const r = fmt.readTasks(stamped);
  assert.deepEqual(r.tasks.map((t) => [t.task.no, t.id ?? null, t.v ?? null, t.problem]), [['T-1', null, null, null], ['T-2', 'card_b', 3, null]]);
  assert.equal(JSON.stringify(r.tasks[1].task), JSON.stringify(fmt.readTasks(text).tasks[1].task), 'the stored copy of a task is the same with or without the id');
  assert.equal(fmt.stampTasks(stamped, new Map([['T-2', { id: 'card_b', v: 4 }]])), stamped.replace('v=3', 'v=4'));
  assert.match(fmt.readTasks(stamped.replace('v=3 -->\n', 'v=3 -->\n<!-- girru:id=card_c v=1 -->\n')).tasks[1].problem, /one hidden Girru id line/);
});

test('P6 off: no hidden lines are written', async () => {
  off();
  writeFileSync(join(folder, '.girru/tasks.md'), `# Tasks\n\n${block1('T-1', 'Fix login')}`);
  await tf.syncTasks('p-tf');
  assert.equal(cardCount(), 1);
  assert.deepEqual(ids(), []);
});

let cardId;
test('P6 on: every linked task gets its hidden id and version stamp', async () => {
  on();
  await tf.syncTasks('p-tf');
  cardId = db.prepare("SELECT card_id FROM task_file_cards WHERE project_id = 'p-tf' AND task_no = 'T-1'").get().card_id;
  assert.deepEqual(ids(), [cardId]);
  const v = db.prepare('SELECT version FROM board_cards WHERE id = ?').get(cardId).version;
  assert.match(tasks(), new RegExp(`## T-1 · Fix login\n<!-- girru:id=${cardId} v=${v} -->\n`));
  assert.equal((await tf.syncTasks('p-tf')).created, 0, 'a second read changes nothing');
  off();
});

test('P6 on: a task renumbered and renamed in the file keeps its card', async () => {
  on();
  writeFileSync(join(folder, '.girru/tasks.md'), tasks().replace('## T-1 · Fix login', '## T-5 · Fix the login timeout'));
  const r = await tf.syncTasks('p-tf');
  assert.equal(r.created, 0);
  assert.equal(cardCount(), 1);
  const link = db.prepare('SELECT task_no FROM task_file_cards WHERE card_id = ?').get(cardId);
  assert.equal(link.task_no, 'T-5');
  assert.equal(db.prepare('SELECT title FROM board_cards WHERE id = ?').get(cardId).title, 'Fix the login timeout');
  off();
});

test('P6 on: a copied block with the same id is a review item; nothing is written', async () => {
  on();
  const before = tasks();
  const copy = fmt.readTasks(before).tasks[0];
  const copied = `${before}\n${before.slice(copy.start, copy.end).replace('## T-5 · Fix the login timeout', '## T-6 · Fix the login timeout again')}`;
  writeFileSync(join(folder, '.girru/tasks.md'), copied);
  const r = await tf.syncTasks('p-tf');
  assert.equal(r.created, 0);
  assert.equal(cardCount(), 1);
  assert.match(db.prepare('SELECT problem FROM task_file_cards WHERE card_id = ?').get(cardId).problem, /same hidden Girru id/);
  assert.equal(db.prepare('SELECT title FROM board_cards WHERE id = ?').get(cardId).title, 'Fix the login timeout');
  writeFileSync(join(folder, '.girru/tasks.md'), before);
  await tf.syncTasks('p-tf');
  assert.equal(db.prepare('SELECT problem FROM task_file_cards WHERE card_id = ?').get(cardId).problem, null, 'fixed in the file: the review item goes away');
  off();
});

test('P6 on: an unknown or foreign id is refused as a review item; no card is made', async () => {
  on();
  const other = mkdtempSync(join(dir, 'proj2-'));
  db.prepare(`INSERT INTO chat_projects (id, user_id, name, slug, folder) VALUES ('p-two', 't-owner', 'Other', 'other', ?)`).run(other);
  assert.equal((await call('t-owner', 'POST', '/api/agent-rules/files/p-two', { mode: 'private' })).statusCode, 200);
  writeFileSync(join(other, '.girru/tasks.md'), `# Tasks\n\n${block1('T-1', 'Their task')}`);
  await tf.syncTasks('p-two');
  const foreign = db.prepare("SELECT card_id FROM task_file_cards WHERE project_id = 'p-two'").get().card_id;
  const base = tasks();
  writeFileSync(join(folder, '.girru/tasks.md'), `${base}\n${block1('T-8', 'Copied from elsewhere').replace('\n', `\n<!-- girru:id=${foreign} v=1 -->\n`)}\n${block1('T-9', 'Made up').replace('\n', '\n<!-- girru:id=nosuchcard v=1 -->\n')}`);
  const r = await tf.syncTasks('p-tf');
  assert.equal(r.created, 0);
  assert.equal(cardCount(), 1);
  const msgs = problemsOf().map((p) => p.message).join('\n');
  assert.match(msgs, /not in this project/);
  assert.match(msgs, /does not know/);
  assert.doesNotMatch(msgs, /Other|p-two/, 'never says which project it came from');
  assert.equal(db.prepare("SELECT title FROM board_cards WHERE id = ?").get(foreign).title, 'Their task', 'the other project is untouched');
  off();
});

test('AG5: "Worked on by" names the app and the agent; a Girru agent update records both', async () => {
  on();
  assert.deepEqual(fmt.readWorkedOn('Codex (Sara) 2026-11-03, Claude Code 2026-11-02'), [{ app: 'Codex', date: '2026-11-03', agent: 'Sara' }, { app: 'Claude Code', date: '2026-11-02' }]);
  assert.deepEqual(fmt.readWorkedOn('Codex (Sara) 2026-11-03', false), [{ app: 'Codex (Sara)', date: '2026-11-03' }], 'switch off: read as before');
  db.prepare("INSERT OR IGNORE INTO board_card_agents (card_id, agent_id) VALUES (?, 'a-dev')").run(cardId);
  const t = await tf.agentTaskUpdate('t-owner', 'a-dev', cardId, { log: 'checked the timeout' });
  assert.deepEqual(t.workedOn.find((w) => w.app === 'Girru'), { app: 'Girru', date: new Date().toISOString().slice(0, 10), agent: 'Dev' });
  assert.match(tasks(), /- Worked on by: .*Girru \(Dev\) \d{4}-\d{2}-\d{2}/);
  const board = db.prepare('SELECT board_id FROM board_cards WHERE id = ?').get(cardId).board_id;
  const d = await tf.taskDetail('t-owner', board, cardId);
  assert.equal(d.workedOn.find((w) => w.app === 'Girru').agent, 'Dev');
  off();
});
