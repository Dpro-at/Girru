import {fileURLToPath} from 'node:url';
// S1.2 fix: the delegation origin of a task (who spawned it, its parent task)
// is recorded server-side and never taken from model input. A task without a
// recorded origin that the owner did not create through the API runs with at
// most the minimal default grants. Recurring copies keep the origin and never
// take the assignee from task input.
// Run: node --import tsx --test test/task-delegation-grants.test.mjs
// Throwaway DB + cwd, random test-only secrets, model calls stubbed (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { switchValueOn } from './helpers/switches.mjs';
const backendDir = fileURLToPath(new URL('../',import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'ap-delegation-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.AGENT_EXEC_TOOLS;
// R2: cron runs call a (stubbed) paid model; autonomous paid calls need a
// daily cap above 0 (default 0 = off). Throwaway value, no real spend.
process.env.DAILY_PAID_CAP_CENTS = '1000000';
delete process.env.MODEL_PRICES_JSON;

const modelRequests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (!String(url).startsWith('https://api.anthropic.com/')) throw new Error(`unexpected network call in test: ${url}`);
  modelRequests.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
const orchestrator = getOrchestrator();
await orchestrator.initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const { taskCreateTool } = await import(join(backendDir, 'src/tools/tasks/task-create.tool.ts'));
const cronSvc = await import(join(backendDir, 'src/services/agent-cron.ts'));
const { setAgentApiKey } = await import(join(backendDir, 'src/credentials/authority.ts'));

const addAgent = (id, autoApprove = 1) => {
  db.prepare(`INSERT INTO agents_config (id, name, provider, model, auto_approve_tasks) VALUES (?, ?, 'claude', 'claude-test', ?)`).run(id, id, autoApprove);
  orchestrator.registerAgent({ id, name: id, role: 'worker', capabilities: [], maxConcurrentTasks: 10 });
};
addAgent('d-parent');
addAgent('d-child');
const avail = tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();
await grants.setAgentGrants('d-parent', { grants: ['memory_search'] }, 'owner', avail);
await grants.setAgentGrants('d-child', { grants: ['memory_search', 'read', 'write'] }, 'owner', avail);
await setAgentApiKey('d-child', 'sk-ant-test-' + randomBytes(12).toString('hex'));

console.log = quiet.log;
console.warn = quiet.warn;

test.after(() => {
  globalThis.fetch = realFetch;
  try { orchestrator.close(); } catch { /* ignore */ }
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const quietly = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };
const effective = async (agentId, taskId) =>
  [...(await grants.loadAgentGrants(agentId, avail, cronSvc.delegatingAgents(taskId))).tools.keys()].sort();

test('task_create records the spawner server-side; model cannot set approval, recurrence or assignee overrides', async () => {
  assert.equal(taskCreateTool.input_schema.properties.requires_approval, undefined);
  const res = await quietly(() => taskCreateTool.execute({
    title: 't', description: 'd', assigned_to: 'd-child', requires_approval: 'false',
    input_data: { topic: 'x', _meta: { repeat_schedule: '* * * * *', repeat_assigned_to: 'd-parent' }, _upstream: 'y' },
  }, { workspaceDir: dir, agentId: 'd-parent' }));
  assert.equal(res.error, undefined, res.content[0].text);
  const task = orchestrator.getTask(res.details.taskId);
  assert.equal(task.spawnedBy, 'd-parent');
  assert.equal(task.origin, 'agent');
  assert.deepEqual(task.input, { topic: 'x' });
  const row = orchestrator.db.prepare('SELECT spawned_by, origin FROM tasks WHERE id = ?').get(task.id);
  assert.deepEqual({ ...row }, { spawned_by: 'd-parent', origin: 'agent' }, 'origin persisted');
  // The child only gets what the spawning parent has.
  assert.deepEqual((await effective('d-child', task.id)), ['memory_search']);
});

test('requires_approval comes only from the target agent setting', async () => {
  db.prepare(`UPDATE agents_config SET auto_approve_tasks = 0 WHERE id = 'd-child'`).run();
  try {
    const res = await quietly(() => taskCreateTool.execute({ title: 't', description: 'd', assigned_to: 'd-child', requires_approval: 'false' },
      { workspaceDir: dir, agentId: 'd-parent' }));
    assert.equal(orchestrator.getTask(res.details.taskId).status, 'pending');
  } finally {
    db.prepare(`UPDATE agents_config SET auto_approve_tasks = 1 WHERE id = 'd-child'`).run();
  }
});

test('a task with no recorded origin (not created by the owner) fails closed to the default set', async () => {
  const forged = await quietly(() => orchestrator.createTask({ title: 'f', description: 'f' }));
  assert.deepEqual((await effective('d-child', forged.id)), ['memory_search']);
  assert.ok((await effective('d-child', forged.id)).every((t) => grants.DEFAULT_AGENT_TOOLS.includes(t)));
  // task_create without a calling agent: no spawner -> fail closed too.
  const res = await quietly(() => taskCreateTool.execute({ title: 'n', description: 'n', assigned_to: 'd-child' }, { workspaceDir: dir }));
  assert.deepEqual((await effective('d-child', res.details.taskId)), ['memory_search']);
  // Unknown task id: fail closed.
  assert.deepEqual((await effective('d-child', 'task_missing')), ['memory_search']);
  // A non-owner API caller is an unknown principal as well.
  const admin = await quietly(() => orchestrator.createTask({ title: 'a', description: 'a', origin: 'user:some-admin' }));
  assert.deepEqual((await effective('d-child', admin.id)), ['memory_search']);
});

test('owner-created tasks run with the agent\'s own grants', async () => {
  const owned = await quietly(() => orchestrator.createTask({ title: 'o', description: 'o', origin: 'owner' }));
  assert.deepEqual(cronSvc.delegatingAgents(owned.id), []);
  assert.deepEqual((await effective('d-child', owned.id)), ['memory_search', 'read', 'write']);
});

// STORE-MAP-01 P2 (AG1): an agent may read its own guides (guide_read) wherever it runs; it is prompt text on demand, not a grant.
const P2_ON = switchValueOn(process.env.GIRRU_STORE_P2 ?? '');
const noGuide = (list) => list.filter((n) => n !== 'guide_read');
test('cron run: delegated task offers only the subset; recurring copy keeps origin and assignee', async () => {
  const parentTask = await quietly(() => orchestrator.createTask({ title: 'p', description: 'p', origin: 'owner' }));
  await quietly(() => orchestrator.assignTask(parentTask.id, 'd-parent'));
  const created = await quietly(() => taskCreateTool.execute({ title: 'c', description: 'c', assigned_to: 'd-child' },
    { workspaceDir: dir, agentId: 'd-parent', taskId: parentTask.id }));
  const child = orchestrator.getTask(created.details.taskId);
  assert.equal(child.parentId, parentTask.id);
  // Owner-set recurrence (the model cannot set _meta); forged assignee override in input is ignored.
  child.input = { _meta: { repeat_schedule: '0 * * * *', repeat_assigned_to: 'd-parent' } };

  modelRequests.length = 0;
  await quietly(() => cronSvc.runAgentTask({ id: 'd-child', name: 'd-child', model: 'claude-test', provider: 'claude',
    system_prompt: null, temperature: 0.1, max_tokens: 100, cron_schedule: '', cron_enabled: 0 }, child.id, 'c'));
  assert.equal(modelRequests.length, 1);
  assert.deepEqual(noGuide((modelRequests[0].tools || []).map((t) => t.name)).sort(), ['memory_search']);

  const copies = orchestrator.listTasks({}).filter((t) => t.id !== child.id && t.title === 'c' && t.status === 'assigned');
  assert.equal(copies.length, 1, 'recurring copy created');
  assert.equal(copies[0].assignedTo, 'd-child', 'assignee never taken from task input');
  assert.equal(copies[0].spawnedBy, 'd-parent');
  assert.equal(copies[0].parentId, parentTask.id);
  assert.deepEqual((await effective('d-child', copies[0].id)), ['memory_search']);
});
