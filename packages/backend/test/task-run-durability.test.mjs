import {fileURLToPath} from 'node:url';
// CORE-08: durable task runs — kill/restart test.
// A task runs in a child process (test/fixtures/task-run-runner.mjs) on a
// throwaway DB; the child is killed with SIGKILL mid-run, a new process
// resumes it. Side effects are counted in a ledger file written by stub
// tools. Model calls are stubbed (no network).
// Run: node --import tsx --test test/task-run-durability.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = fileURLToPath(new URL('../',import.meta.url));
const runnerPath = join(backendDir, 'test', 'fixtures', 'task-run-runner.mjs');
const dir = mkdtempSync(join(tmpdir(), 'ap-task-runs-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.TASK_RUN_LEASE_MS = '1500';
delete process.env.AGENT_EXEC_TOOLS;
delete process.env.TASK_RUN_MAX_STEPS;
delete process.env.TASK_RUN_MAX_DURATION_MS;
// R2: the stubbed model is a paid provider; autonomous paid calls need a
// daily cap above 0 (default 0 = off). Throwaway value, no real spend.
process.env.DAILY_PAID_CAP_CENTS = '1000000';
delete process.env.MODEL_PRICES_JSON;
const LEASE_WAIT = 1800;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };

const quiet = { log: console.log, warn: console.warn, info: console.info };
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`)
  .run(id, `${id}@example.test`, id, role);
addUser('tr-owner', 'owner');
addUser('tr-admin', 'admin');
addUser('tr-member', 'user');
addUser('tr-other', 'user');
addUser('tr-guest', 'guest');

const fixture = await import(runnerPath);
await fixture.registerStubTools(dir);
db.prepare(`INSERT INTO agents_config (id, name, provider, model) VALUES (?, ?, 'claude', 'claude-test')`).run(fixture.AGENT_ID, fixture.AGENT_ID);
const tools = await import(join(backendDir, 'src/tools/index.ts'));
const grants = await import(join(backendDir, 'src/tools/grants.ts'));
const avail = tools.createToolsRegistry({ workspaceDir: dir }).listRegistered();
await grants.setAgentGrants(fixture.AGENT_ID, { grants: fixture.STUB_TOOLS }, 'tr-owner', avail);
const { setAgentApiKey } = await import(join(backendDir, 'src/credentials/authority.ts'));
await setAgentApiKey(fixture.AGENT_ID, 'sk-ant-test-' + randomBytes(12).toString('hex'));

const runs = await import(join(backendDir, 'src/services/task-runs.ts'));
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

// --- helpers -----------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ledger = () => (existsSync(join(dir, 'ledger.txt')) ? readFileSync(join(dir, 'ledger.txt'), 'utf8').split('\n').filter(Boolean) : []);
const count = (prefix) => ledger().filter((l) => l.startsWith(prefix)).length;

function spawnRunner(mode, scenario, env = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', runnerPath, mode, scenario, dir], {
    cwd: backendDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
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

async function run(mode, scenario, env) {
  const r = await spawnRunner(mode, scenario, env).done;
  assert.equal(r.code, 0, `runner ${mode} ${scenario} failed: ${r.stderr.slice(-2000)}`);
  return r;
}

async function waitFor(pred, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}; ledger: ${ledger().join(' | ')}`);
}

const runOf = (taskId) => db.prepare('SELECT * FROM task_runs WHERE task_id = ?').get(taskId);
const stepsOf = (runId) => db.prepare('SELECT * FROM task_run_steps WHERE run_id = ? ORDER BY step_index').all(runId);
const keyOf = (line) => line.split(':').pop();

// --- kill / restart ------------------------------------------------------------

test('kill mid-run: done side effect happens once, in-flight non-idempotent step is not repeated, run waits for the owner', async () => {
  const a = spawnRunner('start', 'A', { HANG: '1' });
  const taskId = await a.taskId();
  await waitFor(() => count('hang_effect:start:A2') === 1, 'hang_effect to start');

  // Live lease: a second worker started now must not touch the run.
  const parallel = await run('recover', '_');
  assert.equal(parallel.result.executed, 0, 'live lease blocks a second worker');
  assert.equal(count('ledger_append:A1'), 1);
  assert.equal(count('hang_effect:start:A2'), 1);

  a.child.kill('SIGKILL');
  const killed = await a.done;
  assert.equal(killed.signal, 'SIGKILL');

  const r0 = runOf(taskId);
  assert.equal(r0.status, 'running');
  assert.deepEqual(stepsOf(r0.id).map((s) => [s.step_index, s.kind, s.tool_name, s.status]), [
    [0, 'model', null, 'completed'], [1, 'tool', 'ledger_append', 'completed'],
    [2, 'model', null, 'completed'], [3, 'tool', 'hang_effect', 'started'],
  ]);
  // The tool saw the step's deterministic idempotency key.
  assert.equal(keyOf(ledger().find((l) => l.startsWith('ledger_append:A1'))), stepsOf(r0.id)[1].idempotency_key);

  await sleep(LEASE_WAIT); // lease of the killed process expires
  const resumed = await run('recover', '_');
  assert.equal(resumed.result.executed, 1);
  assert.equal(resumed.result.modelCalls, 0, 'completed model steps are replayed, not called again');
  assert.equal(count('ledger_append:A1'), 1, 'completed side effect is not repeated');
  assert.equal(count('hang_effect:start:A2'), 1, 'uncertain non-idempotent step is not repeated');

  const r1 = runOf(taskId);
  assert.equal(r1.status, 'waiting_approval');
  assert.equal(r1.status_reason, 'uncertain_step:3');
  assert.equal(r1.attempt, 2);
  const s3 = stepsOf(r1.id)[3];
  assert.equal(s3.status, 'unknown');
  assert.match(s3.error, /not repeated automatically/i);

  // Only the owner decides what happened.
  const url = `/api/task-runs/${r1.id}/steps/3/resolve`;
  for (const id of ['tr-member', 'tr-admin']) {
    const res = await app.inject({ method: 'POST', url, headers: bearer(id), payload: { outcome: 'done' } });
    assert.equal(res.statusCode, 403, id);
  }
  const bad = await app.inject({ method: 'POST', url, headers: bearer('tr-owner'), payload: { outcome: 'maybe' } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: 'POST', url, headers: bearer('tr-owner'), payload: { outcome: 'done' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().run.status, 'queued');
  const again = await app.inject({ method: 'POST', url, headers: bearer('tr-owner'), payload: { outcome: 'done' } });
  assert.equal(again.statusCode, 409);

  const finished = await run('recover', '_');
  assert.equal(finished.result.executed, 1);
  assert.equal(finished.result.modelCalls, 1, 'only the final model step runs');
  assert.equal(count('ledger_append:A1'), 1);
  assert.equal(count('hang_effect:start:A2'), 1);
  const r2 = runOf(taskId);
  assert.equal(r2.status, 'completed');
  assert.equal(r2.output_preview, 'done A');
  assert.match(stepsOf(r2.id)[3].resolved_by, /^tr-owner:done$/);
});

test('kill during an idempotent step: it runs again with the same key and the run completes', async () => {
  const b = spawnRunner('start', 'B', { HANG: '1' });
  const taskId = await b.taskId();
  await waitFor(() => count('idem_lookup:start:B') === 1, 'idem_lookup to start');
  b.child.kill('SIGKILL');
  await b.done;
  await sleep(LEASE_WAIT);

  const resumed = await run('recover', '_');
  assert.equal(resumed.result.executed, 1);
  const starts = ledger().filter((l) => l.startsWith('idem_lookup:start:B'));
  assert.equal(starts.length, 2, 'idempotent step re-ran once');
  assert.equal(keyOf(starts[0]), keyOf(starts[1]), 'same idempotency key on re-run');
  assert.equal(count('idem_lookup:done:B'), 1);
  assert.equal(count('model:B:0'), 1, 'first model step not called again');
  const r = runOf(taskId);
  assert.equal(r.status, 'completed');
  assert.equal(r.output_preview, 'done B');
  assert.equal(stepsOf(r.id)[1].attempt, 2);
});

test('lease: two workers recovering the same run at once execute it exactly once', async () => {
  const c = spawnRunner('start', 'C', { HANG: '1' });
  const taskId = await c.taskId();
  await waitFor(() => count('idem_lookup:start:C') === 1, 'idem_lookup to start');
  c.child.kill('SIGKILL');
  await c.done;
  await sleep(LEASE_WAIT);

  const [w1, w2] = await Promise.all([
    spawnRunner('recover', '_', { IDEM_DELAY_MS: '1000' }).done,
    spawnRunner('recover', '_', { IDEM_DELAY_MS: '1000' }).done,
  ]);
  assert.equal(w1.code, 0, w1.stderr);
  assert.equal(w2.code, 0, w2.stderr);
  assert.equal(w1.result.executed + w2.result.executed, 1, 'exactly one worker claimed the run');
  assert.equal(count('idem_lookup:start:C'), 2, 'original attempt + one resumed attempt, never two');
  assert.equal(count('idem_lookup:done:C'), 1);
  const r = runOf(taskId);
  assert.equal(r.status, 'completed');
  assert.equal(r.lease_generation, 2);
  assert.equal(r.lease_owner, null);
});

// --- budget gate ---------------------------------------------------------------

test('budget: max steps stops the run with failed: budget (no auto-retry after side effects)', async () => {
  const d = spawnRunner('start', 'D', { TASK_RUN_MAX_STEPS: '5' });
  const taskId = await d.taskId();
  const res = await d.done;
  assert.equal(res.code, 0, res.stderr);
  const r = runOf(taskId);
  assert.equal(r.status, 'failed');
  assert.match(r.status_reason, /^budget: max steps 5 reached/);
  assert.equal(r.steps_used, 5);
  assert.equal(stepsOf(r.id).length, 5);
  assert.equal(res.result.taskStatus, 'failed', 'task failed, not re-queued for a fresh retry');
});

test('budget: max duration stops a hanging step; its outcome is recorded as unknown', async () => {
  const e = spawnRunner('start', 'E', { HANG: '1', TASK_RUN_MAX_DURATION_MS: '1000' });
  const taskId = await e.taskId();
  const res = await e.done;
  assert.equal(res.code, 0, res.stderr);
  const r = runOf(taskId);
  assert.equal(r.status, 'failed');
  assert.match(r.status_reason, /^budget: max duration/);
  assert.equal(stepsOf(r.id)[1].status, 'unknown');
  assert.equal(count('hang_effect:start:E'), 1);
});

// --- approvals inside a run -------------------------------------------------------

test('approval inside a run: the run waits, the owner approves once, the run continues without paying twice', async () => {
  const f = spawnRunner('start', 'F');
  const taskId = await f.taskId();
  const res = await f.done;
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.result.output, /waiting for the owner/);
  const r0 = runOf(taskId);
  assert.equal(r0.status, 'waiting_approval');
  assert.equal(r0.status_reason, 'approval');
  const step = stepsOf(r0.id)[1];
  assert.equal(step.status, 'waiting_approval');
  const approval = db.prepare('SELECT * FROM tool_approvals WHERE id = ?').get(step.approval_id);
  assert.equal(approval.run_id, r0.id);
  assert.equal(approval.run_step, 1);
  assert.equal(count('stub_pay'), 0);

  // A restart while waiting changes nothing.
  await run('recover', '_');
  assert.equal(runOf(taskId).status, 'waiting_approval');

  const detail = await app.inject({ method: 'GET', url: `/api/approvals/${approval.id}`, headers: bearer('tr-owner') });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().approval.runScope.runId, r0.id);
  const approve = await app.inject({ method: 'POST', url: `/api/approvals/${approval.id}/approve`, headers: bearer('tr-owner'),
    payload: { paramsHash: detail.json().approval.paramsHash } });
  assert.equal(approve.statusCode, 200, approve.body);
  assert.equal(count('stub_pay:5'), 1);
  assert.equal(keyOf(ledger().find((l) => l.startsWith('stub_pay:5'))), step.idempotency_key, 'approved call keeps the step key');
  assert.equal(runOf(taskId).status, 'queued', 'decided approval queues the run again');

  const resumed = await run('recover', '_');
  assert.equal(resumed.result.executed, 1);
  assert.equal(resumed.result.modelCalls, 1);
  assert.equal(count('stub_pay:5'), 1, 'payment ran exactly once');
  const r1 = runOf(taskId);
  assert.equal(r1.status, 'completed');
  assert.equal(stepsOf(r1.id)[1].status, 'completed');
});

// --- API --------------------------------------------------------------------------

test('task-runs API: owner sees all, others only their own (404), guests refused; no secrets in views; cancel is audited', async () => {
  const mine = await runs.createRun({ taskId: 'api-task-1', agentId: fixture.AGENT_ID, userId: 'tr-member', prompt: 'secret prompt text' });
  const theirs = await runs.createRun({ taskId: 'api-task-2', agentId: fixture.AGENT_ID, userId: 'tr-other', prompt: 'x' });
  assert.equal((await runs.createRun({ taskId: 'api-task-1', agentId: fixture.AGENT_ID, userId: 'tr-member', prompt: 'y' })).id, mine.id, 'one unfinished run per task');

  const list = await app.inject({ method: 'GET', url: '/api/task-runs', headers: bearer('tr-member') });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.json().runs.map((r) => r.id), [mine.id]);
  const all = await app.inject({ method: 'GET', url: '/api/task-runs?limit=200', headers: bearer('tr-owner') });
  assert.ok(all.json().runs.some((r) => r.id === theirs.id) && all.json().runs.some((r) => r.id === mine.id));

  assert.equal((await app.inject({ method: 'GET', url: `/api/task-runs/${theirs.id}`, headers: bearer('tr-member') })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `/api/task-runs/${theirs.id}/cancel`, headers: bearer('tr-member') })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/task-runs', headers: bearer('tr-guest') })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/api/task-runs' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/task-runs?status=bogus', headers: bearer('tr-owner') })).statusCode, 400);

  // A finished run with steps: the view has metadata only.
  const done = db.prepare(`SELECT id FROM task_runs WHERE status = 'completed' LIMIT 1`).get();
  const view = await app.inject({ method: 'GET', url: `/api/task-runs/${done.id}`, headers: bearer('tr-owner') });
  assert.equal(view.statusCode, 200);
  const body = view.body;
  assert.ok(view.json().steps.length > 0);
  for (const banned of ['result_encrypted', 'input_encrypted', 'resultEncrypted', 'secret prompt text', 'sk-ant-test']) {
    assert.ok(!body.includes(banned), `view leaks ${banned}`);
  }

  const cancel = await app.inject({ method: 'POST', url: `/api/task-runs/${mine.id}/cancel`, headers: bearer('tr-member') });
  assert.equal(cancel.statusCode, 200, cancel.body);
  assert.equal(cancel.json().run.status, 'cancelled');
  assert.equal((await app.inject({ method: 'POST', url: `/api/task-runs/${mine.id}/cancel`, headers: bearer('tr-member') })).statusCode, 409);
  const audited = db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'task_run.cancel' AND resource_id = ? AND success = 1`).get(mine.id);
  assert.equal(audited.n, 1);
  // Owner may cancel anyone's run; a cancelled queued run is never claimed.
  const ownerCancel = await app.inject({ method: 'POST', url: `/api/task-runs/${theirs.id}/cancel`, headers: bearer('tr-owner') });
  assert.equal(ownerCancel.statusCode, 200);
  assert.equal(await runs.claimRun(theirs.id), null);
});

test('cancel a run waiting for approval: its pending approval is denied and can never run', async () => {
  const f = spawnRunner('start', 'F');
  const taskId = await f.taskId();
  await f.done;
  const r = runOf(taskId);
  assert.equal(r.status, 'waiting_approval');
  const approvalId = stepsOf(r.id)[1].approval_id;
  const before = count('stub_pay:5');
  const res = await app.inject({ method: 'POST', url: `/api/task-runs/${r.id}/cancel`, headers: bearer('tr-owner') });
  assert.equal(res.statusCode, 200);
  assert.equal(db.prepare('SELECT status FROM tool_approvals WHERE id = ?').get(approvalId).status, 'denied');
  const detail = await app.inject({ method: 'GET', url: `/api/approvals/${approvalId}`, headers: bearer('tr-owner') });
  const approve = await app.inject({ method: 'POST', url: `/api/approvals/${approvalId}/approve`, headers: bearer('tr-owner'),
    payload: { paramsHash: detail.json().approval.paramsHash } });
  assert.equal(approve.statusCode, 409);
  assert.equal(count('stub_pay:5'), before);
  assert.equal(runOf(taskId).status, 'cancelled');
});

test('auth gate: task-run routes are user tier, resolve is owner only', () => {
  const table = app.routeAccessTable;
  const find = (m, u) => table.find((r) => r.method === m && r.url === u)?.access;
  assert.equal(find('GET', '/api/task-runs'), 'user');
  assert.equal(find('GET', '/api/task-runs/:id'), 'user');
  assert.equal(find('POST', '/api/task-runs/:id/cancel'), 'user');
  assert.equal(find('POST', '/api/task-runs/:id/steps/:index/resolve'), 'owner');
  assert.equal(gate.resolveRouteAccess('POST', '/api/task-runs/:id/steps/:index/resolve'), 'owner');
});
