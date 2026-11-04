// R1: task contracts and result verification.
// Contract validation at task create (400, never wider than the agent's
// grants), deterministic verification (verified / failed_verification /
// needs_review), bounded retry rounds that never repeat completed side
// effects (also across a SIGKILL + resume), owner-only review API, the
// small-agent card's needs_review, and the run view (contract without input
// values or secrets). Throwaway DB/keys; model calls are stubbed (no network).
// Run: node --import tsx --test test/task-contracts.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { switchValueOn } from './helpers/switches.mjs';
const backendDir = process.cwd();
const runnerPath = join(backendDir, 'test', 'fixtures', 'task-run-runner.mjs');
const dir = mkdtempSync(join(tmpdir(), 'ap-task-contracts-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.TASK_RUN_LEASE_MS = '1500';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
// The stubbed model is a paid provider; allow autonomous paid calls (throwaway cap).
process.env.DAILY_PAID_CAP_CENTS = '1000000';
for (const k of ['AGENT_EXEC_TOOLS', 'TASK_RUN_MAX_STEPS', 'TASK_RUN_MAX_DURATION_MS', 'MODEL_PRICES_JSON', 'SMALL_AGENT_MODEL', 'SMALL_AGENT_MAX_STEPS', 'OLLAMA_THINK']) delete process.env[k];
const LEASE_WAIT = 1800;

// --- stubbed models --------------------------------------------------------------
const modelBodies = [];
const toolUse = (t, name, input) => ({ content: [{ type: 'tool_use', id: `tu-${t}-${name}`, name, input }], stop_reason: 'tool_use' });
const text = (s) => ({ content: [{ type: 'text', text: s }], stop_reason: 'end_turn' });
function script(sc, t) {
  switch (sc) {
    case 'V': return t === 0 ? toolUse(t, 'idem_lookup', { q: 'V' }) : text('{"title":"GOOD V","n":2}');
    case 'F': return text('nope');
    case 'RV': return text('GOOD review');
    case 'RJ': return text('GOOD reject');
    case 'S': return t === 0 ? toolUse(t, 'ledger_append', { entry: 'S1' }) : t === 1 ? text('bad draft') : text('GOOD S');
    case 'X': return t === 0 ? toolUse(t, 'ledger_append', { entry: 'X1' }) : text(`still bad ${t}`);
    case 'N': return t === 0 ? toolUse(t, 'ledger_append', { entry: 'N1' }) : text('GOOD N');
    case 'W': return text('GOOD W');
    case 'VIEW': return text('GOOD view');
    default: return text('?');
  }
}
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const body = JSON.parse(init.body);
  if (target === 'http://127.0.0.1:11434/api/chat') {
    return new Response(JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'Draft: hello team.' }, prompt_eval_count: 12, eval_count: 6 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (!target.startsWith('https://api.anthropic.com/')) throw new Error(`unexpected network call in test: ${target}`);
  const first = String(body.messages[0].content);
  const sc = /SCENARIO:(\w+)/.exec(first)?.[1] ?? '?';
  const t = body.messages.filter((m) => m.role === 'assistant').length;
  modelBodies.push({ sc, t, body });
  return new Response(JSON.stringify(script(sc, t)), { status: 200, headers: { 'content-type': 'application/json' } });
};

const quiet = { log: console.log, warn: console.warn, info: console.info };
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
const orchestrator = getOrchestrator();
await orchestrator.initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`)
  .run(id, `${id}@example.test`, id, role);
addUser('tr-owner', 'owner');
addUser('tc-admin', 'admin');
addUser('tc-member', 'user');

const fixture = await import(runnerPath);
await fixture.registerStubTools(dir);
const AGENT = fixture.AGENT_ID;
db.prepare(`INSERT INTO agents_config (id, name, provider, model) VALUES (?, ?, 'claude', 'claude-test')`).run(AGENT, AGENT);
orchestrator.registerAgent({ id: AGENT, name: AGENT, role: 'worker', capabilities: [], maxConcurrentTasks: 50 });
const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const avail = tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();
await grants.setAgentGrants(AGENT, { grants: [...fixture.STUB_TOOLS, 'memory_search'] }, 'tr-owner', avail);
const { setAgentApiKey } = await import(join(backendDir, 'src/credentials/authority.ts'));
await setAgentApiKey(AGENT, 'sk-ant-test-' + randomBytes(12).toString('hex'));

const contracts = await import(join(backendDir, 'src/services/task-contracts.ts'));
const scope = await import(join(backendDir, 'src/tools/memory/scope.ts'));
const { selectDrawers } = await import(join(backendDir, 'src/memory/drawers.ts'));
const runs = await import(join(backendDir, 'src/services/task-runs.ts'));
const cron = await import(join(backendDir, 'src/services/agent-cron.ts'));
const sandbox = await import(join(backendDir, 'src/tools/core/file-sandbox.ts'));
const gate = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const bearer = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });

console.log = quiet.log;
console.info = quiet.info;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  try { await app.close(); } catch { /* ignore */ }
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

// --- helpers -----------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ledger = () => (existsSync(join(dir, 'ledger.txt')) ? readFileSync(join(dir, 'ledger.txt'), 'utf8').split('\n').filter(Boolean) : []);
const count = (prefix) => ledger().filter((l) => l.startsWith(prefix)).length;
const runOf = (taskId) => db.prepare('SELECT * FROM task_runs WHERE task_id = ?').get(taskId);
const stepsOf = (runId) => db.prepare('SELECT * FROM task_run_steps WHERE run_id = ? ORDER BY step_index').all(runId);
const roundsOf = (runId) => db.prepare('SELECT * FROM task_run_verifications WHERE run_id = ? ORDER BY round').all(runId);
const createTask = (payload, who = 'tr-owner') => app.inject({ method: 'POST', url: '/api/multi-agent/tasks', headers: bearer(who), payload });

/** Create a task with a contract through the API, then run it like the cron tick does. */
async function runScenario(sc, contract) {
  const res = await createTask({ title: `SCENARIO:${sc}`, description: 'contract test', assignedTo: AGENT, contract });
  assert.equal(res.statusCode, 201, res.body);
  const taskId = res.json().task.id;
  const output = await cron.runAgentTask({ id: AGENT, name: AGENT, model: 'claude-test', provider: 'claude', system_prompt: null,
    temperature: 0, max_tokens: 100, cron_schedule: '', cron_enabled: 0 }, taskId, `SCENARIO:${sc}`);
  return { taskId, output, run: runOf(taskId), task: orchestrator.getTask(taskId) };
}

function spawnRunner(mode, scenario, env = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', runnerPath, mode, scenario, dir], {
    cwd: backendDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.on('exit', (code, signal) => {
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
    resolve({ code, signal, result: line ? JSON.parse(line.slice(7)) : null, stdout, stderr });
  }));
  const taskId = async () => {
    for (let i = 0; i < 400; i++) {
      const m = /^TASK (\S+)$/m.exec(stdout);
      if (m) return m[1];
      await sleep(25);
    }
    throw new Error(`no task id from runner: ${stderr}`);
  };
  return { child, done, taskId };
}

async function waitFor(pred, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}; ledger: ${ledger().join(' | ')}`);
}

// --- validation ------------------------------------------------------------------------

test('contract validation at task create: invalid contracts are 400 and create nothing', async () => {
  const before = orchestrator.listTasks({ limit: 1000 }).length;
  const bad = [
    [{}, /goal is required/],
    [{ goal: 'x', extra: 1 }, /unknown field "extra"/],
    [{ goal: 'x', checks: [{ type: 'llm_judge' }] }, /checks\[0\]\.type/],
    [{ goal: 'x', checks: [{ type: 'schema_valid' }] }, /schema_valid needs/],
    [{ goal: 'x', checks: [{ type: 'file_exists', path: '/etc/passwd' }] }, /relative path inside the agent workspace/],
    [{ goal: 'x', checks: [{ type: 'file_exists', path: '../secrets.env' }] }, /relative path inside the agent workspace/],
    [{ goal: 'x', checks: [{ type: 'max_length', chars: 0 }] }, /chars must be an integer/],
    [{ goal: 'x', output: { format: 'text', schema: { type: 'object' } } }, /schema needs format 'json'/],
    [{ goal: 'x', output: { format: 'json', schema: { type: 'object', required: 'a' } } }, /required must be a list/],
    [{ goal: 'x', review: 'anyone' }, /review must be/],
    [{ goal: 'x', budget: { maxSteps: 100000 } }, /maxSteps \(server limit\)/],
    [{ goal: 'x', budget: { maxCostCents: -1 } }, /maxCostCents/],
    [{ goal: 'x', allowedTools: ['exec'] }, /exceeds the agent's grants: exec/],
    [{ goal: 'x', allowedTools: ['idem_lookup'], checks: [{ type: 'tool_called', tool: 'ledger_append' }] }, /not in contract\.allowedTools/],
    [{ goal: 'x', checks: [{ type: 'tool_called', tool: 'exec' }] }, /not granted to the agent/],
    [{ goal: 'x', allowedDrawers: ['task:other-task'] }, /task drawers cannot be set/],
    [{ goal: 'x', allowedDrawers: ['project:a', 'project:b'] }, /at most one project/],
    [{ goal: 'x', allowedDrawers: ['nope'] }, /allowedDrawers/],
    [{ goal: 'x', maxVerificationRetries: 9 }, /maxVerificationRetries/],
    ['just text', /contract must be an object/],
  ];
  for (const [contract, re] of bad) {
    const res = await createTask({ title: 'v', description: 'v', assignedTo: AGENT, contract });
    assert.equal(res.statusCode, 400, `${JSON.stringify(contract)} -> ${res.body}`);
    assert.match(res.json().error, re, JSON.stringify(contract));
  }
  // allowedTools without an assignee cannot be checked against grants.
  const noAgent = await createTask({ title: 'v', description: 'v', contract: { goal: 'x', allowedTools: ['idem_lookup'] } });
  assert.equal(noAgent.statusCode, 400);
  assert.match(noAgent.json().error, /needs an assigned agent/);
  assert.equal(orchestrator.listTasks({ limit: 1000 }).length, before, 'no task was created');
});

test('contract cannot exceed grants: a non-owner creator only gets the minimal default set', async () => {
  // ledger_append is granted to the agent, but an admin-created task runs
  // with at most the default set (S1.2), so the contract may not name it.
  const admin = await createTask({ title: 'v', description: 'v', assignedTo: AGENT, contract: { goal: 'x', allowedTools: ['ledger_append'] } }, 'tc-admin');
  assert.equal(admin.statusCode, 400);
  assert.match(admin.json().error, /exceeds the agent's grants: ledger_append/);
  const adminOk = await createTask({ title: 'v', description: 'v', assignedTo: AGENT, contract: { goal: 'x', allowedTools: ['memory_search'] } }, 'tc-admin');
  assert.equal(adminOk.statusCode, 201, adminOk.body);
  const owner = await createTask({ title: 'v', description: 'v', assignedTo: AGENT,
    contract: { goal: 'Summarize the ledger', inputs: { apiToken: 'sk-ant-secretvalue1234567890' }, allowedTools: ['ledger_append'] } });
  assert.equal(owner.statusCode, 201, owner.body);
  assert.equal(owner.json().hasContract, true);
  // Stored encrypted: neither the goal nor the input value is in the row.
  const row = db.prepare('SELECT * FROM task_contracts WHERE task_id = ?').get(owner.json().task.id);
  assert.ok(row);
  assert.ok(!JSON.stringify(row).includes('Summarize the ledger'));
  assert.ok(!JSON.stringify(row).includes('sk-ant-secretvalue'));
  // A member cannot create tasks at all (gate: admin tier for multi-agent writes).
  assert.equal((await createTask({ title: 'v', description: 'v', contract: { goal: 'x' } }, 'tc-member')).statusCode, 403);
});

test('contract drawers: a non-owner creator cannot request project/people drawers (400 contract_drawers_owner_only)', async () => {
  for (const drawers of [['project:alpha'], ['people:sara'], ['owner', 'project:alpha']]) {
    const res = await createTask({ title: 'v', description: 'v', assignedTo: AGENT, contract: { goal: 'x', allowedDrawers: drawers } }, 'tc-admin');
    assert.equal(res.statusCode, 400, `${drawers} -> ${res.body}`);
    assert.equal(res.json().code, 'contract_drawers_owner_only');
    assert.match(res.json().error, /only the owner may request/);
  }
  const ok = await createTask({ title: 'v', description: 'v', assignedTo: AGENT, contract: { goal: 'x', allowedDrawers: ['owner', 'experience'] } }, 'tc-admin');
  assert.equal(ok.statusCode, 201, ok.body);
  // Direct validation fails closed when the creator is not stated.
  assert.throws(() => contracts.validateContract({ goal: 'x', allowedDrawers: ['project:alpha'] }, { grants: null, maxSteps: 60, maxDurationMs: 60_000 }),
    (e) => e instanceof contracts.ContractValidationError && e.code === 'contract_drawers_owner_only');
  // The owner may name them (still within the selectDrawers limits).
  const owner = await createTask({ title: 'v', description: 'v', assignedTo: AGENT, contract: { goal: 'x', allowedDrawers: ['owner', 'project:alpha', 'people:sara'] } });
  assert.equal(owner.statusCode, 201, owner.body);
  const ownerTooWide = await createTask({ title: 'v', description: 'v', assignedTo: AGENT, contract: { goal: 'x', allowedDrawers: ['project:a', 'project:b'] } });
  assert.equal(ownerTooWide.statusCode, 400);
});

test('contract drawers never widen the run scope, also when the context has none set', () => {
  const { contractRunDrawers } = contracts;
  const { toolMemoryDrawers } = scope;
  const ids = (ds) => ds.map((d) => (d.key ? `${d.kind}:${d.key}` : d.kind)).sort();
  const c = contracts.validateContract({ goal: 'x', allowedDrawers: ['owner', 'experience', 'project:alpha', 'people:sara'] },
    { grants: null, maxSteps: 60, maxDurationMs: 60_000, creatorIsOwner: true });
  // No drawers on the context: the owner default (owner + experience) is the ceiling.
  assert.deepEqual(ids(contractRunDrawers(c, toolMemoryDrawers({}))), ['experience', 'owner']);
  assert.deepEqual(ids(contractRunDrawers(c, toolMemoryDrawers(undefined))), ['experience', 'owner']);
  // Stored run drawers: only their intersection with the contract.
  assert.deepEqual(ids(contractRunDrawers(c, toolMemoryDrawers({ memoryDrawers: [{ kind: 'owner' }, { kind: 'project', key: 'alpha' }] }))), ['owner', 'project:alpha']);
  assert.deepEqual(ids(contractRunDrawers(c, toolMemoryDrawers({ memoryDrawers: [] }))), []);
  // A run whose drawers come from selectDrawers keeps the contract inside them.
  const sel = selectDrawers({ audience: 'owner', project: 'alpha', people: ['sara'] });
  assert.deepEqual(ids(contractRunDrawers(c, sel)), ['experience', 'owner', 'people:sara', 'project:alpha']);
  const otherProject = selectDrawers({ audience: 'owner', project: 'beta' });
  assert.deepEqual(ids(contractRunDrawers(c, otherProject)), ['experience', 'owner']);
  // Outsider audience: nothing.
  assert.deepEqual(contractRunDrawers(c, selectDrawers({ audience: 'outsider' })), []);
});

// --- verification ----------------------------------------------------------------------------

test('verification passes: json schema, contains, max length and tool_called -> verified, task completed', async () => {
  const { run, task } = await runScenario('V', {
    goal: 'Look up V and report it as JSON',
    output: { format: 'json', schema: { type: 'object', required: ['title', 'n'], properties: { title: { type: 'string' }, n: { type: 'integer' } } } },
    checks: [{ type: 'non_empty' }, { type: 'contains', text: 'good' }, { type: 'max_length', chars: 100 }, { type: 'tool_called', tool: 'idem_lookup' }],
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.verification_status, 'verified');
  assert.deepEqual(JSON.parse(run.verification_reasons), []);
  assert.equal(task.status, 'completed');
  const rounds = roundsOf(run.id);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].verifier, 'deterministic-checks/v1');
  assert.ok(JSON.parse(rounds[0].checks).every((c) => c.passed));
  // The model saw the contract.
  const prompt = String(modelBodies.find((b) => b.sc === 'V').body.messages[0].content);
  assert.match(prompt, /## Task contract/);
  assert.match(prompt, /Acceptance checks/);
});

test('verification fails without retries: failed_verification with reasons; execution completed, task failed (no retry)', async () => {
  const { run, task } = await runScenario('F', {
    goal: 'Say GOOD as JSON', output: { format: 'json' },
    checks: [{ type: 'contains', text: 'GOOD', caseSensitive: true }, { type: 'file_exists', path: 'reports/f.md' }],
    maxVerificationRetries: 0,
  });
  assert.equal(run.status, 'completed', 'execution status is separate from verification');
  assert.equal(run.verification_status, 'failed_verification');
  const reasons = JSON.parse(run.verification_reasons);
  assert.ok(reasons.some((r) => /not valid JSON/.test(r)), reasons.join('|'));
  assert.ok(reasons.some((r) => /does not contain "GOOD"/.test(r)));
  assert.ok(reasons.some((r) => /reports\/f\.md" does not exist/.test(r)));
  assert.equal(task.status, 'failed');
  assert.match(task.error, /^verification failed/);
  assert.equal(task.retryCount, 0, 'not re-queued');
});

test('file_exists checks the agent workspace only', async () => {
  const ws = sandbox.ensureAgentWorkspace(AGENT);
  mkdirSync(join(ws, 'reports'), { recursive: true });
  writeFileSync(join(ws, 'reports', 'w.md'), '# report');
  const { run } = await runScenario('W', { goal: 'Write the report', checks: [{ type: 'file_exists', path: 'reports/w.md' }] });
  assert.equal(run.verification_status, 'verified');
});

test('failed verification retries in the same run without repeating the completed side effect', async () => {
  const { run, task } = await runScenario('S', {
    goal: 'Append S1 and answer with GOOD', checks: [{ type: 'contains', text: 'GOOD' }, { type: 'tool_called', tool: 'ledger_append' }],
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.verification_status, 'verified');
  assert.equal(run.verification_round, 1);
  assert.equal(task.status, 'completed');
  assert.equal(count('ledger_append:S1'), 1, 'side effect ran once');
  assert.deepEqual(stepsOf(run.id).map((s) => [s.kind, s.tool_name, s.status]), [
    ['model', null, 'completed'], ['tool', 'ledger_append', 'completed'], ['model', null, 'completed'], ['model', null, 'completed'],
  ]);
  const rounds = roundsOf(run.id);
  assert.deepEqual(rounds.map((r) => r.status), ['failed_verification', 'verified']);
  // The retry round told the model why.
  const retry = modelBodies.filter((b) => b.sc === 'S').find((b) => b.t === 2);
  const last = retry.body.messages[retry.body.messages.length - 1];
  assert.match(String(last.content), /did not pass the task's acceptance checks/);
  assert.match(String(last.content), /does not contain "GOOD"/);
});

test('retries are bounded: after N rounds the result is failed_verification', async () => {
  const { run, task } = await runScenario('X', { goal: 'GOOD please', checks: [{ type: 'contains', text: 'GOOD' }], maxVerificationRetries: 2 });
  assert.equal(run.verification_status, 'failed_verification');
  assert.deepEqual(roundsOf(run.id).map((r) => r.status), ['failed_verification', 'failed_verification', 'failed_verification']);
  assert.equal(count('ledger_append:X1'), 1);
  assert.equal(stepsOf(run.id).filter((s) => s.kind === 'model').length, 4);
  assert.equal(task.status, 'failed');
});

test('kill during a retry round: the resumed run replays the stored verdict and never repeats the side effect', async () => {
  const contract = JSON.stringify({ goal: 'GOOD G', checks: [{ type: 'contains', text: 'GOOD' }], maxVerificationRetries: 1 });
  const g = spawnRunner('start', 'G', { HANG_MODEL_T: '2', CONTRACT_JSON: contract });
  const taskId = await g.taskId();
  await waitFor(() => count('model:G:2') === 1, 'the retry model call to start');
  g.child.kill('SIGKILL');
  await g.done;
  const r0 = runOf(taskId);
  assert.equal(r0.status, 'running');
  assert.deepEqual(roundsOf(r0.id).map((r) => r.status), ['failed_verification'], 'round 0 verdict is durable');
  await sleep(LEASE_WAIT);

  const resumed = await spawnRunner('recover', '_').done;
  assert.equal(resumed.code, 0, resumed.stderr.slice(-2000));
  assert.equal(resumed.result.executed, 1);
  assert.equal(resumed.result.modelCalls, 1, 'only the interrupted retry model step runs again');
  assert.equal(count('ledger_append:G1'), 1, 'completed side effect not repeated');
  assert.equal(count('model:G:0'), 1);
  assert.equal(count('model:G:1'), 1);
  const r1 = runOf(taskId);
  assert.equal(r1.status, 'completed');
  assert.equal(r1.verification_status, 'verified');
  assert.deepEqual(roundsOf(r1.id).map((r) => r.status), ['failed_verification', 'verified']);
});

// STORE-MAP-01 P2 (AG1): an agent may read its own guides (guide_read) wherever it runs; it is prompt text on demand, not a grant.
const P2_ON = switchValueOn(process.env.GIRRU_STORE_P2 ?? '');
const noGuide = (list) => list.filter((n) => n !== 'guide_read');
test('allowedTools narrows the run: only those tools are offered, others are refused', async () => {
  const { run } = await runScenario('N', { goal: 'GOOD N', allowedTools: ['idem_lookup'] });
  const offered = modelBodies.find((b) => b.sc === 'N').body.tools.map((t) => t.name);
  assert.deepEqual(noGuide(offered), ['idem_lookup']);
  assert.equal(count('ledger_append:N1'), 0, 'tool outside the contract was refused');
  assert.equal(run.verification_status, 'verified');
});

// --- review ---------------------------------------------------------------------------------

test('review requested: needs_review holds the task; only the owner accepts or rejects, once', async () => {
  const { run, task } = await runScenario('RV', { goal: 'GOOD review', checks: [{ type: 'non_empty' }], review: 'large_agent' });
  assert.equal(run.status, 'completed');
  assert.equal(run.verification_status, 'needs_review');
  assert.match(JSON.parse(run.verification_reasons)[0], /review by a large agent/);
  assert.equal(task.status, 'review', 'task held for review');

  const url = `/api/task-runs/${run.id}/review`;
  assert.equal((await app.inject({ method: 'POST', url, payload: { decision: 'accept' } })).statusCode, 401);
  for (const who of ['tc-admin', 'tc-member']) {
    assert.equal((await app.inject({ method: 'POST', url, headers: bearer(who), payload: { decision: 'accept' } })).statusCode, 403, who);
  }
  assert.equal((await app.inject({ method: 'POST', url, headers: bearer('tr-owner'), payload: { decision: 'maybe' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url, headers: bearer('tr-owner'), payload: { decision: 'accept', reviewer: 'bot' } })).statusCode, 400);
  const ok = await app.inject({ method: 'POST', url, headers: bearer('tr-owner'), payload: { decision: 'accept', reviewer: 'large_agent', note: 'looks right' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().run.verification.review.decision, 'accepted');
  assert.equal(ok.json().run.verification.review.reviewer, 'large_agent');
  assert.equal(orchestrator.getTask(run.task_id).status, 'completed');
  assert.equal(orchestrator.getTask(run.task_id).output.output, 'GOOD review');
  assert.equal((await app.inject({ method: 'POST', url, headers: bearer('tr-owner'), payload: { decision: 'reject' } })).statusCode, 409, 'only once');
  const audited = db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'task_run.review' AND resource_id = ? AND success = 1`).get(run.id);
  assert.equal(audited.n, 1);

  const rj = await runScenario('RJ', { goal: 'GOOD reject', review: 'owner' });
  const rej = await app.inject({ method: 'POST', url: `/api/task-runs/${rj.run.id}/review`, headers: bearer('tr-owner'), payload: { decision: 'reject', note: 'wrong tone' } });
  assert.equal(rej.statusCode, 200);
  const t = orchestrator.getTask(rj.taskId);
  assert.equal(t.status, 'failed');
  assert.match(t.error, /rejected by review: wrong tone/);
  assert.equal(t.retryCount, 0);

  // A verified run is not reviewable.
  const verified = db.prepare(`SELECT id FROM task_runs WHERE verification_status = 'verified' LIMIT 1`).get();
  assert.equal((await app.inject({ method: 'POST', url: `/api/task-runs/${verified.id}/review`, headers: bearer('tr-owner'), payload: { decision: 'accept' } })).statusCode, 409);
});

test('small-agent card says needs_review -> the run is needs_review (free local model)', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/small-agent/runs', headers: bearer('tr-owner'), payload: { task: 'Draft a note', kind: 'draft' } });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().run_id;
  await waitFor(async () => (await runs.getRun(id))?.status === 'completed', 'the small-agent run');
  const run = await runs.getRun(id);
  assert.equal(run.verification_status, 'needs_review');
  assert.match(JSON.parse(run.verification_reasons)[0], /not purely informational/);
  assert.equal(run.cost_cents, 0, 'local model costs nothing');
  const step = stepsOf(id)[0];
  assert.equal(step.provider, 'ollama');
  assert.equal(step.input_tokens, 12);
  assert.equal(step.usage_source, 'provider');
});

// --- view ------------------------------------------------------------------------------------

test('GET /api/task-runs/:id shows the contract (no input values, no secrets), verification and cost', async () => {
  const { run } = await runScenario('VIEW', {
    goal: 'Use the key sk-ant-abcdefghijklmnop1234 to say GOOD',
    inputs: { password: 'hunter2-very-secret', topic: 'release' },
    checks: [{ type: 'contains', text: 'GOOD' }],
    budget: { maxSteps: 10, maxCostCents: 500 },
  });
  assert.equal(run.max_steps, 10, 'contract budget lowers the step limit');
  assert.equal(run.max_cost_cents, 500);
  const res = await app.inject({ method: 'GET', url: `/api/task-runs/${run.id}`, headers: bearer('tr-owner') });
  assert.equal(res.statusCode, 200);
  const body = res.body;
  const view = res.json().run;
  assert.equal(view.contract.version, 1);
  assert.deepEqual(view.contract.inputKeys, ['password', 'topic']);
  assert.match(view.contract.goal, /\[REDACTED\]/);
  for (const banned of ['hunter2', 'sk-ant-abcdefghijklmnop1234', 'release', 'contract_encrypted', 'input_encrypted']) {
    assert.ok(!body.includes(banned), `view leaks ${banned}`);
  }
  assert.equal(view.verification.status, 'verified');
  assert.equal(view.verificationRounds.length, 1);
  assert.equal(view.hasContract, true);
  assert.ok(view.budget.costCents > 0, 'paid model cost is shown');
  assert.equal(view.budget.maxCostCents, 500);
  assert.ok(res.json().steps[0].usage.costCents > 0);
  // The list view carries the verification status too.
  const list = await app.inject({ method: 'GET', url: `/api/task-runs?taskId=${run.task_id}`, headers: bearer('tr-owner') });
  assert.equal(list.json().runs[0].verification.status, 'verified');
});

test('auth gate: review is owner only', () => {
  const find = (m, u) => app.routeAccessTable.find((r) => r.method === m && r.url === u)?.access;
  assert.equal(find('POST', '/api/task-runs/:id/review'), 'owner');
  assert.equal(gate.resolveRouteAccess('POST', '/api/task-runs/:id/review'), 'owner');
});
