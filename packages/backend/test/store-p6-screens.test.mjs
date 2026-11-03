// STORE-MAP-01 P6 screens (GIRRU_STORE_P6): the API behind P6a Project files, P6b Needs you and P6c switches.
//  - switch off: none of the new routes exist, /api/store-switches and the task page answer as before;
//  - project files: one state per file (up_to_date, waiting, changed_in_both, folder_not_found), needs-you first;
//    compare shows Girru's part beside the folder's; write again never replaces a file changed in the folder;
//  - "Use Girru's version" keeps the folder text as a proposal labelled repository-file (no brief.outside copy);
//    Undo puts the folder text back and withdraws the proposal, and expires once the file changed;
//  - the project's switches (write project files, company facts);
//  - task-number problems: a number used twice becomes a new task with a new number; an unknown hidden id is
//    added as a new task or left (hidden afterwards); nothing changes before the owner picks;
//  - the task page carries the task's number; place settings default to People staying on this computer.
// Run: node --import tsx --test test/store-p6-screens.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network, no local model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p6-screens-')));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
const SWITCHES = ['GIRRU_STORE_P2', 'GIRRU_STORE_P3', 'GIRRU_STORE_P4', 'GIRRU_STORE_P6', 'GIRRU_STORE_P7', 'GIRRU_STORE_PILOT'];
for (const k of [...SWITCHES, 'CODEX_HOME', 'DEFAULT_MODEL']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await load('src/credentials/storage.ts');
await getCredentialStorage().initialize();
const OWNER = 'p6s-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary, department, role) VALUES ('a-main', 'Main', 'ollama', 'qwen-test', 1, NULL, NULL)`).run();

const { createProject } = await load('src/repositories/chat-conversations.ts');
const { newMemory, saveVersioned } = await load('src/memory/learning.ts');
const { projectKeyOf } = await load('src/memory/project-keys.ts');
const { setBridgeEnv } = await load('src/memory/bridge/service.ts');
const { listPendingProposals, getProposal } = await load('src/memory/memory-files.ts');
const places = await load('src/memory/place-settings.ts');
const tf = await load('src/services/task-file.ts');
const { generateToken } = await load('src/auth/jwt.ts');
const { default: Fastify } = await import('fastify');
const { registerAuthGate } = await load('src/auth/auth-gate.ts');
const { memoryBridgeRoutes } = await load('src/api/routes/memory-bridge.ts');
const { taskBoardRoutes } = await load('src/api/routes/task-board.ts');
const { agentRulesRoutes } = await load('src/api/routes/agent-rules.ts');
const buildServer = async () => {
  const app = Fastify();
  registerAuthGate(app);
  for (const r of [memoryBridgeRoutes, taskBoardRoutes, agentRulesRoutes]) await app.register(r);
  return app;
};
setBridgeEnv({ home: dir, env: {} });
tf.setRouteCall(async () => ({ ok: false, text: '' }));

async function makeProject(name) {
  const folder = join(dir, name);
  mkdirSync(folder, { recursive: true });
  const project = await createProject(OWNER, { name, folder });
  await saveVersioned(newMemory(OWNER, { kind: 'project', key: projectKeyOf(project) }, { type: 'fact', importance: 7, content: `${name} deploys with scripts/release.sh.` }, {}), 'test', 'test');
  return { project, folder };
}
const alpha = await makeProject('Alpha');
const beta = await makeProject('Beta');
const gone = await makeProject('Gone');
const tasksP = await makeProject('Tasks');

// One server per switch state: the P6 routes are registered only when the switch is on at start.
const offApp = await buildServer();
await offApp.ready();
process.env.GIRRU_STORE_P6 = '1';
const onApp = await buildServer();
await onApp.ready();
delete process.env.GIRRU_STORE_P6;
const p6 = async (fn) => { process.env.GIRRU_STORE_P6 = '1'; try { return await fn(); } finally { delete process.env.GIRRU_STORE_P6; } };
const auth = { authorization: `Bearer ${generateToken(OWNER, 1)}` };
const call = (app, method, url, payload) => app.inject({ method, url, headers: auth, ...(payload !== undefined ? { payload } : {}) });
const on = (method, url, payload) => call(onApp, method, url, payload);
const listed = async () => (await on('GET', '/api/memory/project-files')).json().projects;
const proj = async (id) => (await listed()).find((p) => p.projectId === id);
const fileOf = (p, path) => p.files.find((f) => f.path === path);

test.after(async () => { await offApp.close(); await onApp.close(); rmSync(dir, { recursive: true, force: true }); });

test('P6 off: the new routes do not exist and the switches answer as before', async () => {
  for (const [m, u] of [['GET', '/api/memory/project-files'], ['GET', '/api/memory/project-files/needs-you'], ['GET', `/api/memory/project-files/${alpha.project.id}/compare?path=AGENTS.md`],
    ['POST', `/api/memory/project-files/${alpha.project.id}/rewrite`], ['PATCH', `/api/memory/project-files/${alpha.project.id}`], ['GET', '/api/memory/place-settings'], ['PUT', '/api/memory/place-settings/owner']]) {
    assert.equal((await call(offApp, m, u, m === 'GET' ? undefined : {})).statusCode, 404, `${m} ${u}`);
  }
  const s = await call(offApp, 'GET', '/api/store-switches');
  assert.equal(s.statusCode, 200);
  assert.deepEqual(Object.keys(s.json()), ['p2', 'p3', 'p4']);
  // A server started with P6 on still answers without p6 once the switch is off again.
  assert.deepEqual(Object.keys((await on('GET', '/api/store-switches')).json()), ['p2', 'p3', 'p4']);
});

test('switches: p6 is named while P6 is on; owner only', async () => {
  await p6(async () => {
    assert.equal((await on('GET', '/api/store-switches')).json().p6, true);
    assert.equal((await onApp.inject({ method: 'GET', url: '/api/memory/project-files' })).statusCode, 401);
  });
});

test('project files: write project files on, then every file is up to date', async () => {
  await p6(async () => {
    let a = await proj(alpha.project.id);
    assert.equal(a.writeFiles, false);
    assert.equal(a.companyFacts, false);
    assert.equal(fileOf(a, 'AGENTS.md').state, 'waiting');
    assert.equal(fileOf(a, 'AGENTS.md').what, "Girru's part only");
    assert.equal(fileOf(a, '.girru/brief.md'), undefined, 'no brief file before the brief sync is on');
    const r = await on('PATCH', `/api/memory/project-files/${alpha.project.id}`, { writeFiles: true });
    assert.equal(r.statusCode, 200, r.body);
    a = r.json().project;
    assert.equal(a.writeFiles, true);
    assert.ok(existsSync(join(alpha.folder, 'AGENTS.md')));
    assert.deepEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].map((x) => fileOf(a, x).state), ['up_to_date', 'up_to_date', 'up_to_date']);
    assert.equal(fileOf(a, '.girru/brief.md').state, 'waiting');
    const w = await on('POST', `/api/memory/project-files/${alpha.project.id}/rewrite`);
    assert.equal(w.statusCode, 200, w.body);
    a = w.json().project;
    assert.equal(fileOf(a, '.girru/brief.md').state, 'up_to_date');
    assert.equal(fileOf(a, '.girru/brief.md').version, 1);
    assert.equal(a.version, 1);
    assert.equal(a.state, 'up_to_date');
    assert.equal(a.needsYou, false);
    assert.ok(a.writtenAt);
    assert.deepEqual(a.files.map((f) => f.path), ['.girru/brief.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
  });
});

test('project files: a missing folder needs you and comes first', async () => {
  rmSync(gone.folder, { recursive: true, force: true });
  await p6(async () => {
    const list = await listed();
    assert.equal(list[0].projectId, gone.project.id);
    assert.equal(list[0].state, 'folder_not_found');
    assert.equal(list[0].needsYou, true);
    assert.ok(list[0].files.every((f) => f.state === 'folder_not_found'));
    const after = list.slice(1).map((p) => p.name);
    assert.deepEqual(after, [...after].sort((x, y) => x.localeCompare(y)), 'then by name');
    assert.equal((await on('POST', `/api/memory/project-files/${gone.project.id}/rewrite`)).json().code, 'folder_not_found');
  });
});

const MARK_END = '<!-- dpro-memory:end -->';
const editAgents = () => {
  const f = join(alpha.folder, 'AGENTS.md');
  writeFileSync(f, readFileSync(f, 'utf8').replace(MARK_END, `Edited in the folder: ship with make ship-it.\n${MARK_END}`));
};

test('changed in both: compare, write again leaves it, Use Girru keeps the folder text as a proposal, Undo puts it back', async () => {
  await p6(async () => {
    editAgents();
    let a = await proj(alpha.project.id);
    assert.equal(fileOf(a, 'AGENTS.md').state, 'changed_in_both');
    assert.equal(a.state, 'changed_in_both');
    assert.equal(a.needsYou, true);
    assert.equal((await listed()).findIndex((p) => p.projectId === alpha.project.id) < (await listed()).findIndex((p) => p.projectId === beta.project.id), true);

    const c = await on('GET', `/api/memory/project-files/${alpha.project.id}/compare?path=AGENTS.md`);
    assert.equal(c.statusCode, 200, c.body);
    assert.equal(c.json().path, 'AGENTS.md');
    assert.match(c.json().folderText, /make ship-it/);
    assert.doesNotMatch(c.json().girruText, /make ship-it/);
    assert.doesNotMatch(c.json().folderText, /dpro-memory:start/, "Girru's part only");

    // ⌘R never writes over a file changed in both.
    assert.equal((await on('POST', `/api/memory/project-files/${alpha.project.id}/rewrite`)).statusCode, 200);
    assert.match(readFileSync(join(alpha.folder, 'AGENTS.md'), 'utf8'), /make ship-it/);

    const u = await on('POST', `/api/memory/project-files/${alpha.project.id}/use-girru`, { path: 'AGENTS.md' });
    assert.equal(u.statusCode, 200, u.body);
    assert.equal(fileOf(u.json().project, 'AGENTS.md').state, 'up_to_date');
    assert.match(u.json().undo, /^pfu_[0-9a-f]{48}$/);
    assert.doesNotMatch(readFileSync(join(alpha.folder, 'AGENTS.md'), 'utf8'), /make ship-it/);
    const kept = (await listPendingProposals(OWNER)).find((p) => JSON.stringify(p.changes).includes('make ship-it'));
    assert.ok(kept, 'the folder text is a proposal');
    assert.ok(kept.reasons.includes('repository-file'));

    const undo = await on('POST', `/api/memory/project-files/${alpha.project.id}/undo`, { undo: u.json().undo });
    assert.equal(undo.statusCode, 200, undo.body);
    assert.match(readFileSync(join(alpha.folder, 'AGENTS.md'), 'utf8'), /make ship-it/);
    assert.equal(fileOf(undo.json().project, 'AGENTS.md').state, 'changed_in_both');
    assert.equal((await getProposal(OWNER, kept.id)).status, 'rejected', 'the proposal is withdrawn');
    const again = await on('POST', `/api/memory/project-files/${alpha.project.id}/undo`, { undo: u.json().undo });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().code, 'undo_expired');

    // Undo expires once the file changed after Girru wrote it.
    const u2 = (await on('POST', `/api/memory/project-files/${alpha.project.id}/use-girru`, { path: 'AGENTS.md' })).json();
    writeFileSync(join(alpha.folder, 'AGENTS.md'), `${readFileSync(join(alpha.folder, 'AGENTS.md'), 'utf8')}\nOwner note.\n`);
    const late = await on('POST', `/api/memory/project-files/${alpha.project.id}/undo`, { undo: u2.undo });
    assert.equal(late.statusCode, 409);
    assert.equal(late.json().code, 'undo_expired');
  });
});

test('with the one Girru section (P2) and the safe file writer (P7): the same flow', async () => {
  const gamma = await makeProject('Gamma');
  for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_P7']) process.env[k] = '1';
  try {
    await p6(async () => {
      assert.equal((await on('PATCH', `/api/memory/project-files/${gamma.project.id}`, { writeFiles: true })).json().project.writeFiles, true);
      const f = join(gamma.folder, 'AGENTS.md');
      assert.match(readFileSync(f, 'utf8'), /<!-- girru:start/);
      writeFileSync(f, readFileSync(f, 'utf8').replace('<!-- girru:end -->', 'Gamma note from the folder.\n<!-- girru:end -->'));
      assert.equal(fileOf(await proj(gamma.project.id), 'AGENTS.md').state, 'changed_in_both');
      const u = (await on('POST', `/api/memory/project-files/${gamma.project.id}/use-girru`, { path: 'AGENTS.md' })).json();
      assert.doesNotMatch(readFileSync(f, 'utf8'), /Gamma note/);
      assert.equal((await on('POST', `/api/memory/project-files/${gamma.project.id}/undo`, { undo: u.undo })).statusCode, 200);
      assert.match(readFileSync(f, 'utf8'), /Gamma note/);
    });
  } finally { for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_P7']) delete process.env[k]; }
});

test('the brief file: changed in the folder, Use Girru keeps the text as a proposal and no outside copy', async () => {
  await p6(async () => {
    const f = join(alpha.folder, '.girru', 'brief.md');
    writeFileSync(f, `${readFileSync(f, 'utf8')}\nAlpha's staging server is staging-7.\n`);
    assert.equal(fileOf(await proj(alpha.project.id), '.girru/brief.md').state, 'changed_in_both');
    const c = (await on('GET', `/api/memory/project-files/${alpha.project.id}/compare?path=.girru/brief.md`)).json();
    assert.match(c.folderText, /staging-7/);
    assert.equal(c.version, 1);
    const u = await on('POST', `/api/memory/project-files/${alpha.project.id}/use-girru`, { path: '.girru/brief.md' });
    assert.equal(u.statusCode, 200, u.body);
    const brief = fileOf(u.json().project, '.girru/brief.md');
    assert.equal(brief.state, 'up_to_date');
    assert.equal(brief.version, 2);
    assert.doesNotMatch(readFileSync(f, 'utf8'), /staging-7/);
    assert.deepEqual(readdirSync(join(alpha.folder, '.girru')).filter((n) => n.startsWith('brief.outside')), []);
    const kept = (await listPendingProposals(OWNER)).find((p) => JSON.stringify(p.changes).includes('staging-7'));
    assert.ok(kept?.reasons.includes('repository-file'));
  });
});

test('project files: errors say what is wrong', async () => {
  await p6(async () => {
    const bad = await on('GET', `/api/memory/project-files/${alpha.project.id}/compare?path=../etc/passwd`);
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().code, 'bad_path');
    assert.equal((await on('POST', `/api/memory/project-files/${alpha.project.id}/use-girru`, { path: 'README.md' })).json().code, 'bad_path');
    const missing = await on('GET', '/api/memory/project-files/nope/compare?path=AGENTS.md');
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().code, 'not_found');
    assert.equal((await on('POST', `/api/memory/project-files/${alpha.project.id}/undo`, { undo: 'pfu_nothing' })).json().code, 'undo_expired');
    assert.equal((await on('PATCH', `/api/memory/project-files/${alpha.project.id}`, { companyFacts: 'yes' })).statusCode, 400);
  });
});

test('project switches: company facts and write project files', async () => {
  await p6(async () => {
    let r = await on('PATCH', `/api/memory/project-files/${beta.project.id}`, { companyFacts: true });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().project.companyFacts, true);
    r = await on('PATCH', `/api/memory/project-files/${beta.project.id}`, { writeFiles: true });
    assert.equal(r.json().project.writeFiles, true);
    r = await on('PATCH', `/api/memory/project-files/${beta.project.id}`, { writeFiles: false, companyFacts: false });
    assert.deepEqual([r.json().project.writeFiles, r.json().project.companyFacts], [false, false]);
  });
});

// --- P6b: task-number problems ---------------------------------------------------------------

const block = (no, title, id) => `## ${no} · ${title}\n${id ? `<!-- girru:id=${id} v=1 -->\n` : ''}- State: To do\n- Department:\n- Agent:\n- Priority:\n- Worked on by:\n### Done\n### Left\n### Next\n### Log\n`;
const tasksFile = () => readFileSync(join(tasksP.folder, '.girru', 'tasks.md'), 'utf8');
const items = async () => (await on('GET', '/api/memory/project-files/needs-you')).json().items;

test('task numbers: problems are listed with their kind; nothing changes before the owner picks', async () => {
  assert.equal((await call(offApp, 'POST', '/api/boards/sync-departments', {})).statusCode, 200);
  assert.equal((await call(offApp, 'POST', `/api/agent-rules/files/${tasksP.project.id}`, { mode: 'private' })).statusCode, 200);
  const text = `# Tasks\n\n${block('T-1', 'One')}\n${block('T-1', 'Copy of one')}\n${block('T-5', 'From another repo', 'card_zzz')}`;
  writeFileSync(join(tasksP.folder, '.girru', 'tasks.md'), text);
  await p6(async () => {
    const list = await items();
    assert.deepEqual(list.map((x) => [x.kind, x.number, x.titles, x.file, x.projectName]).sort(), [
      ['duplicate_number', 'T-1', ['One', 'Copy of one'], '.girru/tasks.md', 'Tasks'],
      ['unknown_number', 'T-5', ['From another repo'], '.girru/tasks.md', 'Tasks'],
    ]);
    assert.equal(list.find((x) => x.kind === 'duplicate_number').line, 14);
    assert.ok(list.every((x) => /^[0-9a-f]{24}$/.test(x.id) && x.projectId === tasksP.project.id));
    assert.equal(tasksFile(), text, 'reading the problems changes nothing');
  });
});

test('task numbers: a duplicate becomes a new task with a new number', async () => {
  await p6(async () => {
    const dup = (await items()).find((x) => x.kind === 'duplicate_number');
    const wrong = await on('POST', `/api/memory/project-files/needs-you/${dup.id}`, { action: 'leave' });
    assert.equal(wrong.statusCode, 400);
    const r = await on('POST', `/api/memory/project-files/needs-you/${dup.id}`, { action: 'new_task' });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json(), { ok: true });
    assert.match(tasksFile(), /## T-1 · One\n/);
    assert.match(tasksFile(), /## T-6 · Copy of one\n/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_file_cards WHERE project_id = ? AND task_no = 'T-6'").get(tasksP.project.id).n, 1);
    assert.equal((await items()).some((x) => x.kind === 'duplicate_number'), false);
  });
});

test('task numbers: an unknown id is left (hidden) or added as a new task', async () => {
  await p6(async () => {
    const unknown = (await items()).find((x) => x.kind === 'unknown_number');
    assert.equal((await on('POST', `/api/memory/project-files/needs-you/${unknown.id}`, { action: 'new_task' })).statusCode, 400);
    assert.equal((await on('POST', `/api/memory/project-files/needs-you/${unknown.id}`, { action: 'leave' })).statusCode, 200);
    assert.equal((await items()).length, 0, 'left items are not shown again');
    assert.match(tasksFile(), /girru:id=card_zzz/, 'leave changes nothing in the file');

    writeFileSync(join(tasksP.folder, '.girru', 'tasks.md'), `${tasksFile()}\n${block('T-7', 'Copied from elsewhere', 'card_yyy')}`);
    const next = (await items()).find((x) => x.number === 'T-7');
    assert.equal(next.kind, 'unknown_number');
    assert.equal((await on('POST', `/api/memory/project-files/needs-you/${next.id}`, { action: 'add_task' })).statusCode, 200);
    assert.doesNotMatch(tasksFile(), /card_yyy/);
    assert.match(tasksFile(), /## T-7 · Copied from elsewhere\n<!-- girru:id=/, 'kept its free number and got its own id');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_file_cards WHERE project_id = ? AND task_no = 'T-7'").get(tasksP.project.id).n, 1);
    assert.equal((await on('POST', '/api/memory/project-files/needs-you/000000000000000000000000', { action: 'leave' })).statusCode, 404);
  });
});

test('task page: the number comes with P6 only', async () => {
  const row = db.prepare("SELECT l.card_id, c.board_id FROM task_file_cards l JOIN board_cards c ON c.id = l.card_id WHERE l.project_id = ? AND l.task_no = 'T-1'").get(tasksP.project.id);
  const url = `/api/boards/${row.board_id}/cards/${row.card_id}/task`;
  const offTask = (await call(offApp, 'GET', url)).json().task;
  assert.equal('number' in offTask, false);
  assert.equal(offTask.no, 'T-1');
  await p6(async () => { assert.equal((await on('GET', url)).json().task.number, 'T-1'); });
});

// --- P6c: place settings (PRIV2) ----------------------------------------------------------------

test('place settings: People stays on this computer by default; the owner changes any place', async () => {
  await p6(async () => {
    const g = (await on('GET', '/api/memory/place-settings')).json().places;
    assert.equal(g.people.staysLocal, true);
    for (const k of ['owner', 'experience', 'tasks', 'company']) assert.equal(g[k].staysLocal, false, k);
    assert.equal(g[`project:${projectKeyOf(alpha.project)}`].staysLocal, false);
    const put = await on('PUT', '/api/memory/place-settings/owner', { staysLocal: true });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual(put.json(), { place: 'owner', staysLocal: true });
    assert.deepEqual((await on('PUT', '/api/memory/place-settings/people', { staysLocal: false })).json(), { place: 'people', staysLocal: false });
    const after = (await on('GET', '/api/memory/place-settings')).json().places;
    assert.deepEqual([after.owner.staysLocal, after.people.staysLocal], [true, false]);
    assert.deepEqual([...await places.localOnlyPlaces(OWNER)], ['owner']);
    assert.equal((await on('PUT', '/api/memory/place-settings/garage', { staysLocal: true })).json().code, 'bad_place');
    assert.equal((await on('PUT', '/api/memory/place-settings/company', { staysLocal: 'yes' })).statusCode, 400);
  });
  assert.equal(places.placeOfDrawer({ kind: 'task', key: 'run-1' }), 'tasks');
  assert.equal(places.placeOfDrawer({ kind: 'project', key: 'alpha' }), 'project:alpha');
  assert.equal(places.placeOfDrawer({ kind: 'people', key: 'p1' }), 'people');
});
