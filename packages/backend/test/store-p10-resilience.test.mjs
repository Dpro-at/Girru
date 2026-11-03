// STORE-MAP-01 P10: crash, concurrency and rename, with EVERY memory switch on together
// (PILOT, P2–P9, P9B):
//  - a crash in the middle of a sync: a real Girru process is killed while it writes the project's
//    brief (before the rename, and after the rename but before Girru recorded it); the next process
//    catches up from the change log with no false "changed outside Girru" conflict, no lost fact and
//    no staged file left as the brief;
//  - two tools write at once: two edits of one memory on the same version give one write and one
//    refusal with the current text; the refused one retries on the new version and both are in the
//    history in order. The same request id sent by two calls at once writes once;
//  - a rename reaches every file: a project renamed, a task renamed and an agent renamed show the new
//    name in every Girru file of the project (AGENTS.md section, brief, tasks) and the old one nowhere.
// Run: node --import tsx --test test/store-p10-resilience.test.mjs
// Throwaway HOME, DB, keys and folders; no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p10-res-')));
const home = join(dir, 'home');
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
mkdirSync(home, { recursive: true });
process.chdir(dir);
process.env.HOME = home;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['CODEX_HOME', 'AGENT_EXEC_TOOLS', 'DEFAULT_MODEL', 'GIRRU_STORE_PILOT_AGENT']) delete process.env[k];
const SWITCHES = ['GIRRU_STORE_PILOT', 'GIRRU_STORE_P2', 'GIRRU_STORE_P3', 'GIRRU_STORE_P4', 'GIRRU_STORE_P5', 'GIRRU_STORE_P6', 'GIRRU_STORE_P7', 'GIRRU_STORE_P8', 'GIRRU_STORE_P9', 'GIRRU_STORE_P9B'];
for (const k of SWITCHES) process.env[k] = '1';

globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet; console.error = quiet;

const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await load('src/credentials/storage.ts');
await getCredentialStorage().initialize();
const { getOrchestrator } = await load('src/multi-agent/index.ts');
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
const OWNER = 'res-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, 'res@example.test', 'res', 'x', 'owner', 'active', 1)`).run(OWNER);
db.prepare(`INSERT INTO agents_config (id, name, description, provider, model, is_primary, department, role) VALUES
  ('res-main', 'Main', 'Main agent', 'ollama', 'qwen-test', 1, NULL, NULL),
  ('res-sara', 'Sara Builder', 'Builds the backend', 'ollama', 'qwen-test', 0, 'development', 'specialist')`).run();

const { generateToken } = await load('src/auth/jwt.ts');
const { buildServer } = await load('src/api/app.ts');
const { createProject } = await load('src/repositories/chat-conversations.ts');
const { newMemory, saveVersioned } = await load('src/memory/learning.ts');
const { projectKeyOf } = await load('src/memory/project-keys.ts');
const { patchFolder } = await load('src/memory/bridge/store.ts');
const B = await load('src/memory/bridge/service.ts');
const P = await load('src/memory/outbox/projection.ts');
const E = await load('src/memory/outbox/events.ts');
const P6 = await load('src/memory/outbox/p6.ts');
B.setBridgeEnv({ home, env: {} });
const app = await buildServer({ logger: false });
await app.ready();
test.after(async () => { await app.close(); });
const call = (method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(OWNER, 1)}` }, ...(payload ? { payload } : {}) });

const projectAt = async (name) => {
  const folder = join(dir, 'Projects', name.toLowerCase().replace(/\W+/g, '-'));
  mkdirSync(folder, { recursive: true });
  return createProject(OWNER, { name, folder });
};
const save = (p, content) => saveVersioned(newMemory(OWNER, { kind: 'project', key: projectKeyOf(p) }, { type: 'fact', importance: 6, content }, {}), 'test', 'test');

test('switches: every memory switch is on for this file', () => {
  for (const k of SWITCHES) assert.equal(process.env[k], '1', k);
});

// --- A crash in the middle of a sync, then recovery --------------------------------------------

/**
 * Run one brief projection of `scope` in a separate Girru process that is killed (SIGKILL, no clean-up)
 * at `when`: 'before-rename' (the new file is staged) or 'after-rename' (the file is in place, Girru has
 * not recorded it yet). Returns the child's exit signal.
 */
function crashingSync(scope, when) {
  const script = join(dir, `crash-${when}.mjs`);
  writeFileSync(script, `
const load = (rel) => import(${JSON.stringify(pathToFileURL(backendDir).href)} + '/' + rel);
console.log = console.info = console.warn = () => {};
globalThis.fetch = async (u) => { throw new Error('no network: ' + u); };
const { getDatabase } = await load('src/db/database.ts');
await getDatabase().initialize();
const S = await load('src/services/safe-file.ts');
const fs = await import('node:fs');
const die = () => process.kill(process.pid, 'SIGKILL');
S.setSafeFileHooksForTests(${JSON.stringify(when)} === 'before-rename'
  ? { beforeRename: () => die() }
  : { rename: (a, b) => { fs.renameSync(a, b); die(); } });
const P = await load('src/memory/outbox/projection.ts');
await P.runBriefProjection(${JSON.stringify(scope)});
process.exit(3); // not reached: the process is killed inside the write
`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: backendDir, env: process.env, encoding: 'utf8', timeout: 60_000 });
  return { signal: r.signal, status: r.status, stderr: r.stderr };
}

test('crash before the rename: the old brief stays whole; the next process writes the new one', async () => {
  const p = await projectAt('Crash One');
  await patchFolder(OWNER, p.id, { filesEnabled: true });
  await P6.syncP6Scopes();
  const scope = E.projectScope(p);
  await save(p, 'Crash One ships on Mondays.');
  assert.equal((await P.runBriefProjection(scope)).status, 'up_to_date');
  const brief = join(p.folder, '.girru', 'brief.md');
  const before = readFileSync(brief, 'utf8');
  await save(p, 'Crash One moved to the new office.');
  const r = crashingSync(scope, 'before-rename');
  assert.equal(r.signal, 'SIGKILL', r.stderr);
  assert.equal(readFileSync(brief, 'utf8'), before, 'a crash before the rename leaves the old file whole');
  // The next Girru process (this one) catches up from the change log.
  const after = await P.runBriefProjection(scope);
  assert.deepEqual([after.status, after.wrote], ['up_to_date', true]);
  assert.equal(after.watermark, await E.latestSeq(scope));
  const text = readFileSync(brief, 'utf8');
  assert.match(text, /new office/);
  assert.match(text, /Mondays/);
  // A second run has nothing to do (the replay is idempotent).
  assert.equal((await P.runBriefProjection(scope)).wrote, false);
  // Whatever the killed process staged is never taken for the brief.
  const left = readdirSync(join(p.folder, '.girru')).filter((f) => f !== 'brief.md' && f.includes('brief'));
  assert.ok(left.length <= 1, `at most the one staged file of the killed process is left: ${left.join(', ')}`);
  assert.match(readFileSync(brief, 'utf8'), /^<!-- girru:brief /);
});

test('crash after the rename, before Girru recorded it: no false conflict; the next process adopts its own write', async () => {
  const p = await projectAt('Crash Two');
  await patchFolder(OWNER, p.id, { filesEnabled: true });
  await P6.syncP6Scopes();
  const scope = E.projectScope(p);
  await save(p, 'Crash Two uses Postgres.');
  assert.equal((await P.runBriefProjection(scope)).status, 'up_to_date');
  await save(p, 'Crash Two adds a staging server.');
  const r = crashingSync(scope, 'after-rename');
  assert.equal(r.signal, 'SIGKILL', r.stderr);
  const brief = join(p.folder, '.girru', 'brief.md');
  assert.match(readFileSync(brief, 'utf8'), /staging server/, 'the file was written before the crash');
  const after = await P.runBriefProjection(scope);
  assert.equal(after.status, 'up_to_date', `no false conflict: ${after.reason ?? ''}`);
  assert.equal(after.watermark, await E.latestSeq(scope));
  // Owner edits after that are still caught as outside changes.
  writeFileSync(brief, readFileSync(brief, 'utf8') + '\nMy own line.\n');
  await save(p, 'Crash Two renames the repo.');
  assert.equal((await P.runBriefProjection(scope)).status, 'conflict');
  assert.match(readFileSync(brief, 'utf8'), /My own line/, 'the owner\'s edit is kept');
});

// --- Two tools write at once ---------------------------------------------------------------------

test('two edits of one memory on the same version: one is written, the other is refused with the current text and retries', async () => {
  const p = await projectAt('Race');
  const m = await save(p, 'Race release is in May.');
  const v = db.prepare('SELECT MAX(version) AS v FROM memory_versions WHERE memory_id = ?').get(m.id).v ?? 0;
  const edit = (content, expectedVersion) => call('PUT', `/api/memory/${m.id}`, { content, expectedVersion });
  const [a, b] = await Promise.all([edit('Race release is in June.', v), edit('Race release is in July.', v)]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 409], `one write, one refusal: ${a.body} | ${b.body}`);
  const loser = a.statusCode === 409 ? a : b;
  const winnerText = a.statusCode === 200 ? 'June' : 'July';
  assert.equal(loser.json().code, 'version_conflict');
  assert.match(loser.json().current.content, new RegExp(winnerText), 'the refusal carries the text that won');
  // The refused tool retries on the version it was given.
  const retry = await edit('Race release is in August.', loser.json().current.version);
  assert.equal(retry.statusCode, 200, retry.body);
  const history = db.prepare(`SELECT content FROM memory_versions WHERE memory_id = ? ORDER BY version`).all(m.id).map((r) => r.content);
  assert.equal(history.at(-1), 'Race release is in August.');
  assert.ok(history.some((c) => c.includes(winnerText)), 'the first write is in the history');
  assert.equal(history.filter((c) => /June|July/.test(c)).length, 1, 'the refused text was never written');
});

test('the same request id sent by two calls at once writes once; the other gets the first answer', async () => {
  const p = await projectAt('Same Request');
  await B.setClient(OWNER, 'claude-code', true);
  const { ensureToken } = await load('src/memory/bridge/auth.ts');
  const tok = await ensureToken(OWNER, 'claude-code');
  B.resetReadVolume();
  const s = await B.launchSession(p.folder, 'claude');
  const send = () => B.mcpCall('claude-code', tok, p.folder, 'memory_handoff', { done: ['wrote the tests'], request_id: 'req-same-00001' }, s.env.GIRRU_SESSION_CAPABILITY)
    .then((r) => ({ ok: r }), (e) => ({ err: e }));
  const [x, y] = await Promise.all([send(), send()]);
  const rows = db.prepare(`SELECT COUNT(*) AS n FROM memory_bridge_handoffs WHERE project_id = ?`).get(p.id).n;
  assert.equal(rows, 1, 'one handoff for one request id');
  for (const r of [x, y]) if (r.err) assert.equal(r.err.code, 'in_progress');
  // A retry after "in progress" gets the first answer, marked repeated.
  const again = await B.mcpCall('claude-code', tok, p.folder, 'memory_handoff', { done: ['wrote the tests'], request_id: 'req-same-00001' }, s.env.GIRRU_SESSION_CAPABILITY);
  assert.equal(again.data.repeated, true);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memory_bridge_handoffs WHERE project_id = ?`).get(p.id).n, 1);
  await s.end();
});

// --- A rename reaches every file ---------------------------------------------------------------------

test('a rename reaches every file: project, task and agent names', async () => {
  const p = await projectAt('Orchard');
  await save(p, 'The docs live in the docs folder.');
  assert.equal((await call('POST', '/api/boards/sync-departments', {})).statusCode, 200);
  const lp = (await call('GET', `/api/memory-bridge/projects/${p.id}/layout`)).json().preview;
  assert.equal((await call('POST', `/api/memory-bridge/projects/${p.id}/layout`, { previewHash: lp.previewHash, confirm: true })).statusCode, 200);
  const tf = await load('src/services/task-file.ts');
  const tasksPath = join(p.folder, '.girru', 'tasks.md');
  writeFileSync(tasksPath, readFileSync(tasksPath, 'utf8') + '\n## T-1 · Draft the onboarding guide\n- State: To do\n- Department: Development\n- Agent: Sara Builder\n- Priority:\n- Worked on by:\n### Done\n### Left\n### Next\n### Log\n');
  assert.equal((await tf.syncTasks(p.id)).created, 1);
  const cardId = db.prepare('SELECT card_id FROM task_file_cards WHERE project_id = ? AND task_no = ?').get(p.id, 'T-1').card_id;
  const scope = E.projectScope(p);
  await P6.syncP6Scopes();
  await P.runBriefProjection(scope);
  const girruFiles = () => ['AGENTS.md', '.girru/brief.md', '.girru/tasks.md'].filter((f) => existsSync(join(p.folder, f)));
  const all = () => girruFiles().map((f) => [f, readFileSync(join(p.folder, f), 'utf8')]);
  assert.ok(all().some(([, t]) => /Orchard/.test(t)));

  // Rename the project, the task and the agent the way the owner does it in Girru.
  assert.equal((await call('PUT', `/api/chat/projects/${p.id}`, { name: 'Orchard Two' })).statusCode, 200);
  const boardId = db.prepare('SELECT board_id FROM board_cards WHERE id = ?').get(cardId).board_id;
  const cardVersion = db.prepare('SELECT version FROM board_cards WHERE id = ?').get(cardId).version;
  const ren = await call('PUT', `/api/boards/${boardId}/cards/${cardId}`, { title: 'Write the onboarding guide', expectedVersion: cardVersion });
  assert.ok([200, 204].includes(ren.statusCode), ren.body);
  const got = await call('GET', '/api/agents/res-sara');
  const put = await app.inject({ method: 'PUT', url: '/api/agents/res-sara', payload: { name: 'Sara Lead' },
    headers: { authorization: `Bearer ${generateToken(OWNER, 1)}`, 'if-match': got.headers.etag } });
  assert.equal(put.statusCode, 200, put.body);

  // Girru's background syncs run (the same calls the workers make).
  await B.syncOwner(OWNER);
  await P.projectionTick(Date.now() + 60_000);
  await tf.syncTasks(p.id);
  const files = all();
  const where = (re) => files.filter(([, t]) => re.test(t)).map(([f]) => f);
  assert.deepEqual(where(/\bOrchard\b(?! Two)/), [], 'the old project name is in no file');
  assert.ok(where(/Orchard Two/).includes('AGENTS.md'), 'AGENTS.md has the new project name');
  assert.ok(where(/Orchard Two/).includes('.girru/brief.md'), 'the brief has the new project name');
  assert.deepEqual(where(/Draft the onboarding guide/), [], 'the old task title is in no file');
  assert.deepEqual(where(/Write the onboarding guide/), ['.girru/tasks.md']);
  assert.deepEqual(where(/Sara Builder/), [], 'the old agent name is in no file');
  assert.match(readFileSync(tasksPath, 'utf8'), /- Agent: Sara Lead/);
});
