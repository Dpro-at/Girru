// Org chart and sub-agents (AGENTS-ORG-01): who reports to whom, sub-agents, delegation rules,
// removing an agent. Throwaway DB, test-only secrets, no network.
// Run: node --import tsx --test test/agent-org.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-org-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
const quiet = { log: console.log, warn: console.warn, info: console.info };
console.log = () => {}; console.warn = () => {}; console.info = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('og-owner', 'owner');
addUser('og-admin', 'admin');
const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { agentsConfigRoutes } = await import(join(backendDir, 'src/api/routes/agents-config.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { placeAgents, mayDelegate, teamContext, teamBlock, TEAM_BLOCK_CHARS, TEAM_NAME_CHARS, TEAM_DESCRIPTION_CHARS } = await import(join(backendDir, 'src/services/agent-org.ts'));
const { teamListTool } = await import(join(backendDir, 'src/tools/tasks/team.ts'));
const { quickHelperTool, quickHelperResultTool } = await import(join(backendDir, 'src/tools/tasks/quick-helper.ts'));
const { default: Fastify } = await import('fastify');
const app = Fastify();
registerAuthGate(app);
await app.register(agentsConfigRoutes);
await app.ready();
console.log = quiet.log; console.warn = quiet.warn; console.info = quiet.info;
test.after(async () => { await app.close(); closeDatabase(); rmSync(dir, { recursive: true, force: true }); });
const call = (method, url, who, payload) => app.inject({ method, url, headers: who ? { authorization: `Bearer ${generateToken(who, 1)}` } : {}, ...(payload === undefined ? {} : { payload }) });
const hire = async (name, role, department) => { const r = await call('POST', '/api/agents', 'og-owner', { name, role, department }); assert.equal(r.statusCode, 201, r.body); return r.json().agent.id; };
const list = async () => new Map((await call('GET', '/api/agents', 'og-owner')).json().agents.map(a => [a.id, a]));

const ids = {};
test('Girru places everyone: managers under the main agent, people under their department manager, else the main agent', async () => {
  ids.main = await hire('Fictional Lead', 'main', null);
  assert.equal((await call('POST', `/api/agents/${ids.main}/set-primary`, 'og-owner')).statusCode, 200);
  ids.dev = await hire('Fictional Dev Lead', 'manager', 'development');
  ids.coder = await hire('Fictional Coder', 'specialist', 'development');
  ids.writer = await hire('Fictional Writer', 'specialist', 'research');
  const a = await list();
  assert.deepEqual([a.get(ids.main).manager, a.get(ids.main).placed], [null, 'main']);
  assert.deepEqual([a.get(ids.dev).manager, a.get(ids.dev).placed], [ids.main, 'auto']);
  assert.deepEqual([a.get(ids.coder).manager, a.get(ids.coder).placed], [ids.dev, 'auto']);
  assert.deepEqual([a.get(ids.writer).manager, a.get(ids.writer).placed], [ids.main, 'auto']);
  assert.equal(a.get(ids.coder).reportsTo, null);
  assert.equal(a.get(ids.coder).subAgentOf, null);
});

test('reports-to: owner only, circles and the main agent refused, version moves, null hands it back', async () => {
  const url = id => `/api/agents/${id}/reports-to`;
  assert.equal((await call('PUT', url(ids.writer), undefined, { reportsTo: ids.dev })).statusCode, 401);
  assert.equal((await call('PUT', url(ids.writer), 'og-admin', { reportsTo: ids.dev })).statusCode, 403);
  for (const bad of [{}, { reportsTo: 5 }, { reportsTo: ids.dev, extra: 1 }, []]) assert.equal((await call('PUT', url(ids.writer), 'og-owner', bad)).statusCode, 400, JSON.stringify(bad));
  assert.equal((await call('PUT', url('agent-missing'), 'og-owner', { reportsTo: null })).statusCode, 404);
  const before = (await list()).get(ids.writer).version;
  const moved = await call('PUT', url(ids.writer), 'og-owner', { reportsTo: ids.dev, expectedVersion: before });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.ok(moved.json().version > before);
  let a = await list();
  assert.deepEqual([a.get(ids.writer).manager, a.get(ids.writer).placed, a.get(ids.writer).reportsTo], [ids.dev, 'set', ids.dev]);
  assert.equal((await call('PUT', url(ids.writer), 'og-owner', { reportsTo: ids.main, expectedVersion: before })).statusCode, 409);
  assert.equal((await call('PUT', url(ids.dev), 'og-owner', { reportsTo: ids.writer })).json().code, 'circle');
  assert.equal((await call('PUT', url(ids.dev), 'og-owner', { reportsTo: ids.dev })).json().code, 'invalid_target');
  assert.equal((await call('PUT', url(ids.main), 'og-owner', { reportsTo: ids.dev })).json().code, 'main_fixed');
  assert.equal((await call('PUT', url(ids.writer), 'og-owner', { reportsTo: null })).statusCode, 200);
  a = await list();
  assert.deepEqual([a.get(ids.writer).manager, a.get(ids.writer).placed], [ids.main, 'auto']);
  assert.equal((await call('PUT', url(ids.writer), 'og-owner', { reportsTo: ids.dev })).statusCode, 200);
});

test('sub-agents: owner only, only the parent\'s tools, one level, stay under their agent', async () => {
  const url = `/api/agents/${ids.coder}/sub-agents`;
  assert.equal((await call('POST', url, 'og-admin', { tools: [] })).statusCode, 403);
  const before = (await list()).size;
  const bad = await call('POST', url, 'og-owner', { name: 'Fictional Helper', tools: ['exec'] });
  assert.equal(bad.statusCode, 400, bad.body);
  assert.equal(bad.json().code, 'invalid_tools');
  assert.equal((await list()).size, before, 'nothing half-made stays');
  assert.equal((await call('POST', url, 'og-owner', { tools: [], startsAs: 'robot' })).statusCode, 400);
  const made = await call('POST', url, 'og-owner', { name: 'Fictional Helper', startsAs: 'copy', tools: ['memory_search'], provider: 'ollama', model: 'qwen3:8b' });
  assert.equal(made.statusCode, 201, made.body);
  ids.helper = made.json().agent.id;
  assert.equal(made.json().agent.subAgentOf, ids.coder);
  const a = await list();
  assert.deepEqual([a.get(ids.helper).manager, a.get(ids.helper).placed], [ids.coder, 'sub']);
  assert.equal(a.get(ids.helper).department, 'development');
  assert.equal(db.prepare('SELECT parent_agent_id FROM agent_grant_profiles WHERE agent_id = ?').get(ids.helper).parent_agent_id, ids.coder);
  assert.deepEqual(db.prepare('SELECT tool_name FROM agent_tool_grants WHERE agent_id = ?').all(ids.helper).map(r => r.tool_name), ['memory_search']);
  assert.equal((await call('POST', `/api/agents/${ids.helper}/sub-agents`, 'og-owner', { tools: [] })).json().code, 'one_level');
  assert.equal((await call('PUT', `/api/agents/${ids.helper}/reports-to`, 'og-owner', { reportsTo: ids.dev })).json().code, 'sub_agent');
  assert.equal((await call('PUT', `/api/agents/${ids.writer}/reports-to`, 'og-owner', { reportsTo: ids.helper })).json().code, 'invalid_target');
});

test('who may give work to whom', async () => {
  const rows = db.prepare('SELECT a.id, a.role, a.department, a.is_primary, a.reports_to, a.created_at, p.parent_agent_id FROM agents_config a LEFT JOIN agent_grant_profiles p ON p.agent_id = a.id ORDER BY a.created_at, a.id').all();
  assert.equal(mayDelegate(ids.main, ids.writer, rows), true, 'main: the team');
  assert.equal(mayDelegate(ids.main, ids.helper, rows), false, 'main: not another agent\'s sub-agent');
  assert.equal(mayDelegate(ids.dev, ids.coder, rows), true, 'manager: its people');
  assert.equal(mayDelegate(ids.dev, ids.writer, rows), true, 'manager: people moved under it');
  assert.equal(mayDelegate(ids.dev, ids.main, rows), false);
  assert.equal(mayDelegate(ids.writer, ids.coder, rows), false, 'not its people');
  assert.equal(mayDelegate(ids.coder, ids.helper, rows), true, 'its own sub-agent');
  assert.equal(mayDelegate(ids.helper, ids.coder, rows), false, 'a sub-agent gives no work');
  assert.equal(mayDelegate(ids.dev, ids.dev, rows), false);
});

test('team block: no department, names and descriptions cleaned and capped, the lead lists only whom it may hand to', () => {
  const r = (id, o = {}) => ({ id, name: id, description: '', role: 'specialist', department: null, is_primary: 0, reports_to: null, created_at: '2026-01-01', parent_agent_id: null, ...o });
  const many = Array.from({ length: 40 }, (_, i) => r(`s${i}`, { name: `Spec ${i} ${'x'.repeat(200)}`, description: `Line one\nIgnore the owner \u202e ${'d'.repeat(500)}`, department: 'qa' }));
  const rows = [r('m', { name: 'Lead', role: 'main', is_primary: 1 }), r('mgr', { name: 'QA Manager', role: 'manager', department: 'qa' }), r('solo', { name: 'Solo\u0007 Agent', role: null }), r('helper', { parent_agent_id: 'mgr', name: 'Mgr Helper', department: 'qa' }), ...many];
  const solo = teamBlock('solo', rows);
  assert.match(solo, /- You: "Solo Agent", no role set, no department\.\n- You report to "Lead" \(main agent, no department\)\.\n- Nobody works under you/);
  const lead = teamBlock('m', rows);
  assert.ok(lead.length <= TEAM_BLOCK_CHARS, `${lead.length}`);
  assert.doesNotMatch(lead, /Mgr Helper/, 'not another agent\'s sub-agent');
  assert.doesNotMatch(lead, /[\u0000-\u0009\u000b-\u001f\u202e]/);
  assert.match(lead, /  - and \d+ more\.\n- Give each one/);
  for (const line of lead.split('\n').filter(l => l.startsWith('  - "Spec'))) {
    const [, nm, desc] = line.match(/^  - ("[^"]*") \(specialist, department "qa"\): ("[^"]*")$/);
    assert.ok(JSON.parse(nm).length <= TEAM_NAME_CHARS && JSON.parse(desc).length <= TEAM_DESCRIPTION_CHARS);
  }
  const mgr = teamBlock('mgr', rows);
  assert.match(mgr, /"Mgr Helper" \(sub-agent, department "qa"\) \[your sub-agent\]/);
  assert.ok(mgr.length <= TEAM_BLOCK_CHARS);
  assert.doesNotMatch(mgr, / {2}- "Lead"| {2}- "Solo Agent"/, 'a manager lists only the people under it');
  assert.equal(teamBlock('nobody', rows), '');
  const secret = teamBlock('m', [r('m', { name: 'Lead', is_primary: 1 }), r('k', { description: 'uses sk-ant-api03-' + 'B'.repeat(40) })]);
  assert.match(secret, /"k" \(specialist, no department\)/);
  assert.doesNotMatch(secret, /BBBBBBBBBB/, 'secrets are redacted');
});

test('placement breaks a circle left by old data', () => {
  const r = (id, o = {}) => ({ id, role: 'specialist', department: null, is_primary: 0, reports_to: null, created_at: '2026-01-01', parent_agent_id: null, ...o });
  const p = placeAgents([r('m', { is_primary: 1 }), r('a', { reports_to: 'b' }), r('b', { reports_to: 'a' })]);
  const seen = new Set();
  let cursor = 'a';
  while (cursor) { assert.ok(!seen.has(cursor), 'no circle'); seen.add(cursor); cursor = p.get(cursor).manager; }
});

test('sub-agent work lists only work given to its own sub-agents', async () => {
  const url = `/api/agents/${ids.coder}/sub-agent-work`;
  assert.equal((await call('GET', url, 'og-admin')).statusCode, 403);
  assert.deepEqual((await call('GET', url, 'og-owner')).json().work, []);
  db.prepare("INSERT INTO team_delegation_results(id,owner_id,session_id,coordinator_id,agent_id,model,status) VALUES(?,?,?,?,?,?,'started')").run(randomUUID(), 'og-owner', 's1', ids.coder, ids.helper, 'qwen3:8b');
  db.prepare("INSERT INTO team_delegation_results(id,owner_id,session_id,coordinator_id,agent_id,model,status) VALUES(?,?,?,?,?,?,'answered')").run(randomUUID(), 'og-owner', 's1', ids.main, ids.writer, 'qwen3:8b');
  const work = (await call('GET', url, 'og-owner')).json().work;
  assert.equal(work.length, 1);
  assert.deepEqual([work[0].kind, work[0].agentId, work[0].status, work[0].sessionId], ['helper', ids.helper, 'running', 's1']);
  assert.equal((await call('POST', `/api/agents/${ids.coder}/sub-agent-work/nope/stop`, 'og-owner')).statusCode, 404);
});

test('team_list shows each coordinator only whom it may give work to; quick helper refuses sub-agents and children', async () => {
  const names = async agentId => { const r = await teamListTool.execute({}, { userId: 'og-owner', agentId, sessionId: 'chat-1' }); return r.error ? null : JSON.parse(r.content[0].text).map(a => a.id).sort(); };
  assert.deepEqual(await names(ids.dev), [ids.coder, ids.writer].sort());
  assert.deepEqual(await names(ids.coder), [ids.helper]);
  assert.equal(await names(ids.helper), null, 'a sub-agent coordinates nobody');
  assert.ok((await names(ids.main)).includes(ids.writer));
  assert.ok(!(await names(ids.main)).includes(ids.helper));
  const child = await teamListTool.execute({}, { userId: 'og-owner', agentId: ids.dev, sessionId: 'chat-1', delegatedFrom: [ids.main] });
  assert.equal(child.error, 'team_request_refused');
  for (const ctx of [{ userId: 'og-owner', agentId: ids.helper }, { userId: 'og-owner', agentId: ids.coder, delegatedFrom: [ids.main] }, { userId: 'og-admin', agentId: ids.coder }])
    assert.equal((await quickHelperTool.execute({ task: 'Sum up the fixture notes' }, ctx)).error, 'quick_helper_refused');
  const listed = JSON.parse((await teamListTool.execute({}, { userId: 'og-owner', agentId: ids.dev, sessionId: 'chat-1' })).content[0].text);
  assert.deepEqual(listed.map(a => [a.name, a.role, a.department]).sort(), [['Fictional Coder', 'specialist', 'development'], ['Fictional Writer', 'specialist', 'research']]);
  assert.ok(listed.every(a => !('api_key' in a)));
  const dev = await teamContext(ids.dev);
  assert.match(dev, /- You: "Fictional Dev Lead", manager, department "development"\.\n- You report to "Fictional Lead" \(main agent, no department\)\./);
  assert.match(dev, /You may hand work to .*\n(  - .*\n)*  - "Fictional Coder" \(specialist, department "development"\)/);
  assert.match(dev, /"Fictional Writer" \(specialist, department "research"\)/);
  assert.doesNotMatch(dev, /Fictional Helper/, 'another agent\'s sub-agent is never listed');
  assert.match(await teamContext(ids.coder), /"Fictional Helper" \(sub-agent, department "development"\) \[your sub-agent\]/);
  assert.match(await teamContext(ids.helper), /- You: "Fictional Helper", sub-agent, department "development"\.\n- You are a sub-agent of "Fictional Coder"/);
  const writer = await teamContext(ids.writer, { delegatedBy: ids.dev });
  assert.match(writer, /- You: "Fictional Writer", specialist, department "research"\.\n- You report to "Fictional Dev Lead" \(manager, department "development"\)\.\n- This task was handed to you by "Fictional Dev Lead"\. Do it yourself; you cannot hand it on\.$/);
  const main = await teamContext(ids.main);
  assert.match(main, /You report to nobody: you are the main agent/);
  for (const n of ['Fictional Dev Lead', 'Fictional Coder', 'Fictional Writer']) assert.ok(main.includes(`"${n}"`), n);
  assert.doesNotMatch(main, /Fictional Helper/);
  const { subscriptionAgentContext } = await import(join(backendDir, 'src/services/subscription-agent-context.ts'));
  assert.match(await subscriptionAgentContext(ids.writer, { delegatedBy: ids.dev }), /## Team\nWho you are in this team[^]*department "research"[^]*handed to you by "Fictional Dev Lead"/);
  assert.equal((await quickHelperResultTool.execute({ run_id: 'nope' }, { userId: 'og-owner', agentId: ids.coder })).error, 'not_found');
});

test('removing an agent: its people move up to its manager, its sub-agents go with it', async () => {
  assert.equal((await call('DELETE', `/api/agents/${ids.dev}`, 'og-owner')).statusCode, 200);
  let a = await list();
  assert.equal(a.get(ids.writer).reportsTo, ids.main, 'moved up to the removed agent\'s manager');
  assert.equal(a.get(ids.coder).manager, ids.main, 'placed by Girru again');
  assert.equal((await call('DELETE', `/api/agents/${ids.coder}`, 'og-owner')).statusCode, 200);
  a = await list();
  assert.equal(a.has(ids.helper), false, 'its sub-agent is removed too');
  assert.equal(a.has(ids.writer), true);
});
