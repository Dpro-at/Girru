// STORE-MAP-01 P3 step 1: one list of departments (FD2, D8, D9).
//  - switch off: memory keeps its own list, the new table stays empty;
//  - backfill: memory's departments keep their id, every name in use becomes one department,
//    case duplicates are one (D9), known keys get their first-run label, ids are filled, a rule
//    naming a department nobody uses is asked about once; a second run changes nothing;
//  - rename: agents, specialty templates, boards, cards, hire items and rule targets follow, and the
//    rule still applies to the agent; memory projects keep the same department id;
//  - merge moves everything and can be undone exactly; delete lets agents go and pauses a rule
//    left without a department.
// Run: node --import tsx --test test/store-p3-departments.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p3-dep-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
for (const k of ['GIRRU_STORE_P3', 'AGENT_PLAYER_DATA_DIR']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const OWNER = 'p3-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, 'p3@example.test', OWNER);

const store = await import(join(backendDir, 'src/memory/scopes/store.ts'));
const lifecycle = await import(join(backendDir, 'src/memory/scopes/lifecycle.ts'));
const deps = await import(join(backendDir, 'src/services/departments.ts'));
const { ruleApplies } = await import(join(backendDir, 'src/services/agent-rules.ts'));
const { sql } = await import(join(backendDir, 'src/repositories/sql-steps.ts'));

const get = (s, ...a) => db.prepare(s).get(...a);
const rows = (s, ...a) => db.prepare(s).all(...a);
const rule = (id) => { const r = get('SELECT * FROM agent_rules WHERE id = ?', id); return { ...r, targets: JSON.parse(r.targets), ids: r.department_ids ? JSON.parse(r.department_ids) : null }; };

// Today's data, made while the switch is off.
const memDept = await store.createDepartment(OWNER, 'Engineering', OWNER);
db.prepare(`INSERT INTO memory_project_scopes (owner_id, slug, name, department_id) VALUES (?, 'alpha', 'Alpha', ?)`).run(OWNER, memDept.id);
const agent = (id, name, dep) => db.prepare(`INSERT INTO agents_config (id, name, provider, model, department) VALUES (?, ?, 'ollama', 'm', ?)`).run(id, name, dep);
agent('a-omar', 'Omar', 'engineering');
agent('a-nora', 'Nora', 'marketing');
agent('a-lina', 'Lina', 'hr');
db.prepare(`INSERT INTO specialty_templates (id, name, department, description, revision, content_hash, config_json) VALUES ('sp-1', 'Backend developer', 'Engineering', 'd', 1, 'h', '{}')`).run();
db.prepare(`INSERT INTO boards (id, owner_id, name) VALUES ('b-1', ?, 'Engineering board')`).run(OWNER);
db.prepare(`INSERT INTO board_departments (board_id, department) VALUES ('b-1', 'engineering'), ('b-1', 'marketing')`).run();
db.prepare(`INSERT INTO board_columns (id, board_id, name, position) VALUES ('c-1', 'b-1', 'To do', 0)`).run();
db.prepare(`INSERT INTO board_cards (id, board_id, column_id, title, position, created_by) VALUES ('card-1', 'b-1', 'c-1', 'Ship', 0, ?)`).run(OWNER);
db.prepare(`INSERT INTO board_card_departments (card_id, department) VALUES ('card-1', 'Engineering')`).run();
db.prepare(`INSERT INTO team_hire_batches (id, owner_id, fingerprint, language, total) VALUES ('hb-1', ?, 'f', 'en', 1)`).run(OWNER);
db.prepare(`INSERT INTO team_hire_batch_items (batch_id, seq, department, role, title, preset) VALUES ('hb-1', 1, 'engineering', 'specialist', 'Dev', 'p')`).run();
const ruleRow = (id, targets) => db.prepare(`INSERT INTO agent_rules (id, text, who, targets) VALUES (?, 'Test before you say done.', 'departments', ?)`).run(id, JSON.stringify(targets));
ruleRow('r-eng', ['engineering']);
ruleRow('r-two', ['marketing', 'designers']);
ruleRow('r-mkt', ['marketing']);

test('switch off: memory keeps its own list and the new table stays empty', () => {
  assert.equal(get('SELECT COUNT(*) AS n FROM departments').n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM memory_departments').n, 1);
});

let eng, mkt, hr;
test('backfill makes one list with ids, asks once, and is idempotent', async () => {
  process.env.GIRRU_STORE_P3 = '1';
  const r1 = await deps.syncDepartments();
  assert.equal(r1.copied, 1);
  assert.equal(r1.created, 2, 'marketing and hr; engineering is memory\'s department');
  assert.equal(r1.questions, 1, 'designers is used by no agent, project or board');
  const list = rows('SELECT * FROM departments WHERE owner_id = ? ORDER BY norm_name', OWNER);
  assert.deepEqual(list.map((d) => d.name), ['Engineering', 'People and hiring', 'Marketing']);
  eng = list.find((d) => d.norm_name === 'engineering');
  mkt = list.find((d) => d.norm_name === 'marketing');
  hr = list.find((d) => d.norm_name === 'hr');
  assert.equal(eng.id, memDept.id, 'memory\'s department keeps its id');
  assert.equal(get('SELECT department_id FROM agents_config WHERE id = ?', 'a-omar').department_id, eng.id);
  assert.equal(get('SELECT department_id FROM specialty_templates WHERE id = ?', 'sp-1').department_id, eng.id, 'case duplicates are one');
  assert.equal(get('SELECT department_id FROM board_card_departments WHERE card_id = ?', 'card-1').department_id, eng.id);
  assert.deepEqual(rule('r-two').ids, [mkt.id]);
  assert.deepEqual(await sql().read(deps.verifyDepartmentsStep(OWNER)), []);
  const r2 = await deps.syncDepartments();
  assert.deepEqual(r2, { copied: 0, created: 0, filled: 0, questions: 0 });
  assert.equal((await deps.openDepartmentQuestions(OWNER)).length, 1);
});

test('memory reads the one list while the switch is on', async () => {
  const names = (await sql().read(store.listDepartmentsStep(OWNER))).map((d) => d.name);
  assert.deepEqual(names, ['General', 'Engineering', 'People and hiring', 'Marketing']);
});

test('rename: everything that names the department follows, and rules still apply', async () => {
  const before = get('SELECT version FROM agents_config WHERE id = ?', 'a-omar').version;
  await store.renameDepartment(OWNER, eng.id, 'Platform');
  assert.equal(get('SELECT department FROM agents_config WHERE id = ?', 'a-omar').department, 'platform');
  assert.ok(get('SELECT version FROM agents_config WHERE id = ?', 'a-omar').version > before, 'the agent\'s version moves on');
  assert.equal(get('SELECT department FROM specialty_templates WHERE id = ?', 'sp-1').department, 'Platform', 'templates keep case');
  assert.deepEqual(rows('SELECT department FROM board_departments WHERE board_id = ? ORDER BY department', 'b-1').map((r) => r.department), ['marketing', 'platform']);
  assert.equal(get('SELECT department FROM board_card_departments WHERE card_id = ?', 'card-1').department, 'platform');
  assert.equal(get('SELECT department FROM team_hire_batch_items WHERE batch_id = ?', 'hb-1').department, 'platform');
  assert.deepEqual(rule('r-eng').targets, ['platform']);
  assert.ok(ruleApplies({ projectId: null, who: 'departments', targets: rule('r-eng').targets }, { id: 'a-omar', department: 'platform' }, null));
  assert.equal(get('SELECT department_id FROM memory_project_scopes WHERE slug = ?', 'alpha').department_id, eng.id, 'the project keeps the same department');
  assert.deepEqual(await sql().read(deps.verifyDepartmentsStep(OWNER)), []);
  await assert.rejects(store.renameDepartment(OWNER, eng.id, 'marketing'), { code: 'name_taken' });
  await assert.rejects(deps.updateDepartment(OWNER, eng.id, { version: 1, color: '#123456' }), { code: 'version_conflict' });
});

test('merge moves everything and undo puts it back exactly', async () => {
  const snapshot = () => ({
    agents: rows('SELECT id, department, department_id FROM agents_config WHERE department IS NOT NULL ORDER BY id'),
    boards: rows('SELECT board_id, department, department_id FROM board_departments ORDER BY board_id, department'),
    rules: rows("SELECT id, targets, department_ids FROM agent_rules ORDER BY id"),
    projects: rows('SELECT slug, department_id FROM memory_project_scopes ORDER BY slug'),
  });
  const before = snapshot();
  const { mergeId, into } = await deps.mergeDepartments(OWNER, mkt.id, eng.id, OWNER);
  assert.equal(into.name, 'Platform');
  assert.equal(get('SELECT department FROM agents_config WHERE id = ?', 'a-nora').department, 'platform');
  assert.deepEqual(rows('SELECT department FROM board_departments WHERE board_id = ?', 'b-1').map((r) => r.department), ['platform']);
  assert.deepEqual(rule('r-mkt').targets, ['platform']);
  assert.equal(get('SELECT COUNT(*) AS n FROM departments WHERE id = ?', mkt.id).n, 0);
  await deps.undoMerge(OWNER, mergeId);
  const after = snapshot();
  assert.deepEqual(after.agents, before.agents);
  assert.deepEqual(after.boards, before.boards);
  assert.deepEqual(after.projects, before.projects);
  assert.deepEqual(after.rules.map((r) => [r.id, JSON.parse(r.targets)]), before.rules.map((r) => [r.id, JSON.parse(r.targets)]));
  await assert.rejects(deps.undoMerge(OWNER, mergeId), { code: 'already_undone' });
});

test('an upgrade question is answered once', async () => {
  const [qn] = await deps.openDepartmentQuestions(OWNER);
  await deps.answerDepartmentQuestion(OWNER, qn.id, null);
  assert.deepEqual(rule('r-two').targets, ['marketing'], '"Leave it" drops the unknown name; marketing stays');
  assert.equal((await deps.openDepartmentQuestions(OWNER)).length, 0);
});

test('delete: agents let go, a rule left without a department is paused', async () => {
  const preview = await lifecycle.previewDeleteDepartment(OWNER, mkt.id);
  await lifecycle.deleteDepartment(OWNER, mkt.id, preview.previewHash);
  const nora = get('SELECT department, department_id FROM agents_config WHERE id = ?', 'a-nora');
  assert.deepEqual({ ...nora }, { department: null, department_id: null });
  assert.equal(rule('r-mkt').paused, 1);
  assert.deepEqual(rule('r-mkt').targets, []);
  assert.equal(rule('r-two').paused, 1, 'its only department is gone too');
  assert.equal(get('SELECT COUNT(*) AS n FROM departments WHERE id = ?', mkt.id).n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM departments WHERE id = ?', hr.id).n, 1);
});

test('a new agent in a new department joins the list', async () => {
  const { agentConfigs } = await import(join(backendDir, 'src/repositories/agents-config.ts'));
  const a = await agentConfigs.createConfig({ userId: OWNER, role: 'owner' }, { name: 'Sami', department: 'Research', provider: 'ollama', model: 'm' });
  const d = get('SELECT d.name FROM agents_config a JOIN departments d ON d.id = a.department_id WHERE a.id = ?', a.id);
  assert.equal(d.name, 'Research');
});

test('the switch can go off again: memory shows the same list', async () => {
  const on = (await sql().read(store.listDepartmentsStep(OWNER))).map((d) => `${d.id}|${d.name}`);
  delete process.env.GIRRU_STORE_P3;
  const off = (await sql().read(store.listDepartmentsStep(OWNER))).map((d) => `${d.id}|${d.name}`);
  process.env.GIRRU_STORE_P3 = '1';
  assert.deepEqual(off, on);
  assert.ok(off.some((x) => x.endsWith('|Platform')), 'the rename made while on is there');
});
