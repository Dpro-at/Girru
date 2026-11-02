// RUNS-01: everything that runs, in one read model — chat replies, agent tasks, small helpers,
// coding apps, system jobs and chats that wait for an OK; schedules of every kind; a plain
// reason for every stop; secrets hidden; the owner sees all, anyone else only their own.
// Throwaway DB/keys/folders; no network.
// Run: node --import tsx --test test/runs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-runs-'));
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
for (const [id, role, name] of [['r-owner', 'owner', 'Mohamed'], ['r-sara', 'user', 'Sara']]) {
  db.prepare(`INSERT INTO users (id, email, username, full_name, password_hash, role, status, email_verified) VALUES (?, ?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, name, role);
}
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('a-nora', 'Nora', 'ollama', 'qwen-test', 1), ('a-omar', 'Omar', 'ollama', 'qwen-test', 0)`).run();
db.prepare(`UPDATE agents_config SET cron_enabled = 1, cron_schedule = '*/30 * * * *' WHERE id = 'a-omar'`).run();

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { createRun } = await import(join(backendDir, 'src/services/task-runs.ts'));
const { startCodingRun } = await import(join(backendDir, 'src/services/coding-runs.ts'));
const chatSchedules = await import(join(backendDir, 'src/services/chat-schedules.ts'));
const { stopReason } = await import(join(backendDir, 'src/services/runs.ts'));
const app = await buildServer({ logger: false });
await app.ready();
const call = (user, method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(user, 1)}` }, ...(payload ? { payload } : {}) });
const ok = async (r, code = 200) => { const x = await r; assert.equal(x.statusCode, code, x.body); return x.json(); };

const SECRET = `sk-ant-api03-${'Q'.repeat(40)}`;
const chat = async (user, title) => (await ok(call(user, 'POST', '/api/chat/conversations', { title }), 201)).id ?? (await ok(call(user, 'GET', '/api/chat/conversations'))).conversations[0].id;
const ownerChat = await chat('r-owner', 'Launch plan');
const saraChat = await chat('r-sara', 'Sara notes');
db.prepare('UPDATE chat_sessions SET title = ?, agent_id = ? WHERE id = ?').run('Launch plan', 'a-nora', ownerChat);
db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run('Sara notes', saraChat);
const t0 = Date.now() - 3_600_000;
function journal(runId, session, user, state, startedAt, opts = {}) {
  db.prepare('INSERT INTO chat_run_journal (run_id, session_id, user_id, agent_id, state, started_at, ended_at, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(runId, session, user, opts.agent ?? null, state, startedAt, opts.ended ?? null, opts.code ?? null);
  db.prepare("INSERT INTO chat_messages (id, session_id, role, content, run_id, status) VALUES (?, ?, 'user', ?, ?, 'complete')").run(`u-${runId}`, session, opts.ask ?? 'Plan the launch post', runId);
  if (state !== 'running') db.prepare("INSERT INTO chat_messages (id, session_id, role, content, run_id, status, model, parts, duration_ms, error_code) VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?)")
    .run(`m-${runId}`, session, opts.answer ?? 'Here is the post', runId, state === 'interrupted' ? 'error' : state, opts.model ?? 'subscription:claude-code', JSON.stringify([{ kind: 'tools', step: 0, calls: [{ id: 'c1', name: 'memory_search', input: '{}', output: 'found 8', ms: 900 }] }, { kind: 'text', text: opts.answer ?? 'Here is the post' }]), 4000, opts.code ?? null);
}
journal('run-done', ownerChat, 'r-owner', 'complete', t0 + 1000, { ended: t0 + 5000, answer: `The key is ${SECRET}` });
journal('run-offline', ownerChat, 'r-owner', 'error', t0 + 2000, { ended: t0 + 3000, code: 'model_unavailable' });
journal('schedule-x-1', ownerChat, 'r-owner', 'interrupted', t0 + 3000, { code: 'run_interrupted' });
journal('run-stopped', ownerChat, 'r-owner', 'stopped', t0 + 4000, { ended: t0 + 4500 });
journal('run-sara', saraChat, 'r-sara', 'error', t0 + 5000, { ended: t0 + 6000, code: 'content_limit' });

// An agent check-in task (no person behind it) and one of Sara's small helpers that waits for an OK.
const checkin = await createRun({ taskId: 'task-checkin', agentId: 'a-omar', userId: null, prompt: 'Check your tasks' });
db.prepare("UPDATE task_runs SET status = 'failed', status_reason = 'time limit reached', finished_at = datetime('now'), checkpoint_step = 3 WHERE id = ?").run(checkin.id);
const helper = await createRun({ taskId: 'task-helper', agentId: 'a-nora', userId: 'r-sara', prompt: 'Sum up the mails' });
db.prepare("INSERT INTO small_agent_runs (run_id, task_id, requested_by, kind, requested_tools, granted_tools, drawers, model, warnings) VALUES (?, 'task-helper', 'r-sara', 'summary', '[]', '[]', '[]', 'local:qwen', '[]')").run(helper.id);
db.prepare("UPDATE task_runs SET status = 'waiting_approval', status_reason = 'approval' WHERE id = ?").run(helper.id);

// A system job that failed, and a chat that waits for the owner's OK.
db.prepare("INSERT INTO cron_jobs (id, name, cron_expression, enabled, action_type, action_data) VALUES ('job-mem', 'memory-weekly-summary-r-owner', '0 22 * * 0', 1, 'memory-job', '{}')").run();
db.prepare("INSERT INTO job_executions (job_id, success, output, error, executed_at, duration, started_by) VALUES ('job-mem', 0, NULL, ?, ?, 1200, 'scheduled')").run(`fetch failed while sending token=${SECRET}`, new Date(t0 + 7000).toISOString());
db.prepare("INSERT INTO tool_approvals (id, status, agent_id, user_id, session_id, tool_name, params_encrypted, params_iv, params_tag, requested_at) VALUES ('ap-1', 'pending', 'a-nora', 'r-owner', ?, 'send_email', 'x', 'x', 'x', datetime('now'))").run(ownerChat);

// A coding app that was not installed.
const code = startCodingRun(ownerChat, 'Codex', 'a-nora', 'Write the test for the token refresh');
code.done('error', 'cli_missing');
await new Promise((r) => setTimeout(r, 50));

test('every stop has one plain reason, and only a real bug says "A bug"', () => {
  assert.equal(stopReason('chat', 'failed', 'model_unavailable').title, 'The app was offline');
  assert.equal(stopReason('chat', 'failed', 'run_interrupted').code, 'restarted');
  assert.equal(stopReason('task', 'failed', 'uncertain_step:4').code, 'unsure_step');
  assert.equal(stopReason('task', 'failed', 'verification failed: 2 links').code, 'check_failed');
  assert.equal(stopReason('task', 'failed', 'cost cap reached').code, 'over_budget');
  assert.equal(stopReason('chat', 'failed', 'secret_check_failed').code, 'secret');
  assert.equal(stopReason('chat', 'failed', 'content_limit').code, 'too_long');
  assert.equal(stopReason('chat', 'stopped', null).code, 'stopped_by_you');
  assert.equal(stopReason('schedule', 'stopped', 'archived').code, 'skipped');
  assert.equal(stopReason('job', 'failed', 'Job is not authorized to run').code, 'not_allowed_to_run');
  const bug = stopReason('job', 'failed', 'TypeError: x is undefined', { error: 'TypeError: x is undefined' });
  assert.equal(bug.code, 'bug'); assert.equal(bug.bug, true); assert.match(bug.detail, /TypeError/);
  for (const r of [stopReason('chat', 'failed', 'model_unavailable'), stopReason('task', 'failed', 'time limit')]) assert.equal(r.bug, false);
  assert.equal(stopReason('chat', 'done', null), null);
});

test('the owner sees every kind in its place, newest first, with the sidebar counts', async () => {
  const failed = await ok(call('r-owner', 'GET', '/api/runs?place=failed'));
  const ids = failed.runs.map((r) => r.id);
  for (const id of ['job:1', 'chat:schedule-x-1', 'chat:run-offline', 'chat:run-stopped', `task:${checkin.id}`, `code:${code.id}`, 'chat:run-sara']) assert.ok(ids.includes(id), id);
  const times = failed.runs.map((r) => Date.parse(r.startedAt));
  assert.deepEqual([...times].sort((a, b) => b - a), times, 'newest first');
  const byId = Object.fromEntries(failed.runs.map((r) => [r.id, r]));
  assert.equal(byId['chat:run-offline'].reason.title, 'The app was offline');
  assert.equal(byId['chat:run-offline'].app, 'Claude Code');
  assert.equal(byId['chat:run-offline'].agentName, 'Nora');
  assert.equal(byId['chat:schedule-x-1'].startedBy, 'schedule');
  assert.equal(byId['chat:schedule-x-1'].reason.code, 'restarted');
  assert.equal(byId['chat:run-stopped'].state, 'stopped');
  assert.equal(byId[`task:${checkin.id}`].reason.code, 'timed_out');
  assert.match(byId[`task:${checkin.id}`].reason.text, /step 4/);
  assert.equal(byId[`code:${code.id}`].reason.code, 'offline');
  assert.equal(byId['job:1'].title, 'Weekly memory summary');
  assert.equal(byId['job:1'].reason.code, 'offline');
  assert.doesNotMatch(JSON.stringify(failed), /sk-ant-api03/, 'secrets never leave');
  const waiting = await ok(call('r-owner', 'GET', '/api/runs?place=waiting'));
  assert.deepEqual(waiting.runs.map((r) => r.id).sort(), ['approval:ap-1', `task:${helper.id}`].sort());
  assert.ok(waiting.runs.every((r) => r.needsYou));
  assert.equal(waiting.counts.waiting, 2);
  const finished = await ok(call('r-owner', 'GET', '/api/runs?place=finished'));
  assert.deepEqual(finished.runs.map((r) => r.id), ['chat:run-done']);
  // Filters and search.
  assert.deepEqual((await ok(call('r-owner', 'GET', '/api/runs?place=failed&kind=job'))).runs.map((r) => r.id), ['job:1']);
  assert.ok((await ok(call('r-owner', 'GET', '/api/runs?place=failed&agent=a-omar'))).runs.every((r) => r.agentId === 'a-omar'));
  assert.deepEqual((await ok(call('r-owner', 'GET', '/api/runs?place=failed&q=offline'))).runs.map((r) => r.reason.code).filter((c) => c !== 'offline'), []);
  assert.equal((await call('r-owner', 'GET', '/api/runs?place=everything')).statusCode, 400);
});

test('paging: a page of 2, then the next one from where it stopped', async () => {
  const p1 = await ok(call('r-owner', 'GET', '/api/runs?place=failed&limit=2'));
  assert.equal(p1.runs.length, 2); assert.ok(p1.next);
  const p2 = await ok(call('r-owner', 'GET', `/api/runs?place=failed&limit=2&before=${p1.next}`));
  assert.equal(p2.runs.length, 2);
  assert.equal(p1.runs.some((r) => p2.runs.some((x) => x.id === r.id)), false, 'no run twice');
});

test('a member sees only their own runs, never system jobs or agent check-ins', async () => {
  const failed = await ok(call('r-sara', 'GET', '/api/runs?place=failed'));
  assert.deepEqual(failed.runs.map((r) => r.id), ['chat:run-sara']);
  assert.equal(failed.runs[0].reason.code, 'too_long');
  const waiting = await ok(call('r-sara', 'GET', '/api/runs?place=waiting'));
  assert.deepEqual(waiting.runs.map((r) => r.id), [`task:${helper.id}`]);
  assert.equal((await call('r-sara', 'GET', '/api/runs/item/chat:run-done')).statusCode, 404);
  assert.equal((await call('r-sara', 'GET', '/api/runs/item/job:1')).statusCode, 404);
  assert.equal((await call('r-sara', 'POST', `/api/runs/item/task:${checkin.id}/stop`)).statusCode, 404);
  const s = await ok(call('r-sara', 'GET', '/api/runs/schedules'));
  assert.equal(s.schedules.some((x) => x.kind === 'job' || x.kind === 'checkin'), false);
  assert.equal((await call('r-sara', 'GET', '/api/runs/schedules/job:job-mem/runs')).statusCode, 404);
});

test('one run: steps, log, result and Copy details, with secrets hidden', async () => {
  const d = await ok(call('r-owner', 'GET', '/api/runs/item/chat:run-done'));
  assert.equal(d.run.state, 'done');
  assert.deepEqual(d.steps.map((s) => [s.title, s.state]), [['memory search', 'done'], ['Answer in the chat', 'done']]);
  assert.ok(d.log.length >= 2);
  assert.doesNotMatch(d.result.text, /sk-ant-api03/);
  assert.match(d.copy, /^Run: Launch plan/m);
  assert.match(d.copy, /Run id: chat:run-done/);
  const j = await ok(call('r-owner', 'GET', '/api/runs/item/job:1'));
  assert.equal(j.run.reason.code, 'offline');
  assert.doesNotMatch(JSON.stringify(j), /sk-ant-api03/);
  const t = await ok(call('r-owner', 'GET', `/api/runs/item/task:${checkin.id}`));
  assert.match(t.copy, /Ran out of time/);
  const c = await ok(call('r-owner', 'GET', `/api/runs/item/code:${code.id}`));
  assert.equal(c.run.app, 'Codex');
  const a = await ok(call('r-owner', 'GET', '/api/runs/item/approval:ap-1'));
  assert.equal(a.steps[0].state, 'wait');
  assert.equal((await call('r-owner', 'GET', '/api/runs/item/nonsense')).statusCode, 400);
});

test('Stop and Retry keep the gates of the routes they stand for', async () => {
  assert.equal((await call('r-owner', 'POST', '/api/runs/item/chat:run-done/retry')).statusCode, 409, 'a finished reply is not retried');
  assert.equal((await call('r-sara', 'POST', '/api/runs/item/chat:run-offline/retry')).statusCode, 404, 'not her chat');
  assert.equal((await call('r-owner', 'POST', '/api/runs/item/job:1/retry')).statusCode, 409, 'a system job runs again with Run now');
  assert.equal((await call('r-owner', 'POST', '/api/runs/item/chat:run-done/stop')).statusCode, 404, 'not running');
  const stopped = await ok(call('r-owner', 'POST', `/api/runs/item/task:${helper.id}/stop`));
  assert.equal(stopped.status, 'cancelled');
});

test('schedules of every kind, with what happened the last time', async () => {
  await chatSchedules.setSchedule('r-owner', ownerChat, { every: 'daily', at: '09:00', message: 'Give me the news' });
  db.prepare(`UPDATE chat_schedules SET next_run = '2000-01-01T00:00:00.000Z' WHERE session_id = ?`).run(ownerChat);
  await chatSchedules.runDueSchedules(async () => false);
  const s = await ok(call('r-owner', 'GET', '/api/runs/schedules'));
  const byKind = Object.fromEntries(s.schedules.map((x) => [x.kind, x]));
  assert.equal(byKind.job.title, 'Weekly memory summary');
  assert.equal(byKind.job.when, 'Every Sunday at 22:00');
  assert.equal(byKind.job.lastResult, 'failed');
  assert.equal(byKind.checkin.agentName, 'Omar');
  assert.equal(byKind.chatsch.when, 'Every day at 09:00');
  assert.equal(byKind.chatsch.lastResult, 'skipped');
  assert.equal(byKind.chatsch.lastReason.code, 'skipped');
  const jobRuns = await ok(call('r-owner', 'GET', '/api/runs/schedules/job:job-mem/runs'));
  assert.deepEqual(jobRuns.runs.map((r) => r.id), ['job:1']);
  const chatRunsOf = await ok(call('r-owner', 'GET', `/api/runs/schedules/chatsch:${ownerChat}/runs`));
  assert.deepEqual(chatRunsOf.runs.map((r) => r.id), ['chat:schedule-x-1']);
  const checkinRuns = await ok(call('r-owner', 'GET', '/api/runs/schedules/checkin:a-omar/runs'));
  assert.deepEqual(checkinRuns.runs.map((r) => r.id), [`task:${checkin.id}`]);
});

test('Schedule a task (board RN6): one call makes the card with the instructions and how it repeats; owner only', async () => {
  const made = await ok(call('r-owner', 'POST', '/api/runs/schedules', { instructions: 'Every morning, sum up yesterday’s support mails.\nPut the summary in the chat.', agentId: 'a-nora', every: 'daily', at: '08:30', notify: 'all', newChat: false, thinking: 'deep' }), 201);
  assert.match(made.id, /^cardsch:/);
  const card = db.prepare('SELECT title, description FROM board_cards WHERE id = ?').get(made.cardId);
  assert.equal(card.title, 'Every morning, sum up yesterday’s support mails.');
  assert.match(card.description, /Put the summary in the chat/);
  const row = db.prepare('SELECT every, at_time, agent_id, notify, new_chat, thinking FROM card_schedules WHERE card_id = ?').get(made.cardId);
  assert.deepEqual({ ...row }, { every: 'daily', at_time: '08:30', agent_id: 'a-nora', notify: 'all', new_chat: 0, thinking: 'deep' });
  const s = await ok(call('r-owner', 'GET', '/api/runs/schedules'));
  assert.ok(s.schedules.some((x) => x.id === made.id && x.kind === 'cardsch' && x.when === 'Every day at 08:30'));
  // A pause from Runs sends only the schedule: the options stay.
  await ok(call('r-owner', 'PUT', `/api/boards/${made.boardId}/cards/${made.cardId}/schedule`, { every: 'daily', at: '08:30', agentId: 'a-nora', paused: true }));
  assert.equal(db.prepare('SELECT notify FROM card_schedules WHERE card_id = ?').get(made.cardId).notify, 'all');
  for (const bad of [{ instructions: '', every: 'daily', at: '08:30' }, { instructions: 'x', every: 'monthly', at: '08:30' }, { instructions: 'x', every: 'daily', at: '25:00' }, { instructions: 'x', every: 'daily', at: '08:30', notify: 'loud' }, { instructions: 'x', every: 'daily', at: '08:30', action: 'api-call' }]) {
    const before = db.prepare('SELECT COUNT(*) AS n FROM board_cards').get().n;
    assert.equal((await call('r-owner', 'POST', '/api/runs/schedules', bad)).statusCode, 400, JSON.stringify(bad));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM board_cards').get().n, before, 'no card left behind');
  }
  assert.equal((await call('r-sara', 'POST', '/api/runs/schedules', { instructions: 'x', every: 'daily', at: '08:30' })).statusCode, 403);
});

test('sub-tasks (board RN6): work a chat reply started shows under it, and a stopped one is said on the main task', async () => {
  journal('run-parent', ownerChat, 'r-owner', 'complete', t0 + 9000, { ended: t0 + 20000 });
  const { withChatRun } = await import(join(backendDir, 'src/services/chat-run-context.ts'));
  const ctx = { runId: 'run-parent', reviewTools: false, async beforeTool() { return 'x'; }, async afterTool() {} };
  const child = await withChatRun(ctx, () => startCodingRun(ownerChat, 'Codex', 'a-omar', 'Write the test'));
  child.done('error', 'cli_missing');
  const helperRun = await withChatRun(ctx, () => createRun({ taskId: 'task-sub', agentId: 'a-nora', userId: 'r-owner', prompt: 'Find the feature list' }));
  db.prepare("UPDATE task_runs SET status = 'completed', finished_at = datetime('now') WHERE id = ?").run(helperRun.id);
  const { startTeamResult } = await import(join(backendDir, 'src/services/team-results.ts'));
  const hand = await withChatRun(ctx, () => startTeamResult({ owner: 'r-owner', session: ownerChat, coordinator: 'a-nora', agent: 'a-omar', model: 'local:qwen' }));
  await new Promise((r) => setTimeout(r, 50));
  const d = await ok(call('r-owner', 'GET', '/api/runs/item/chat:run-parent'));
  assert.deepEqual(d.subtasks.map((x) => x.id).sort(), [`code:${child.id}`, `task:${helperRun.id}`, `handoff:${hand}`].sort());
  assert.ok(d.subtasks.every((x) => x.parentId === 'chat:run-parent'));
  assert.equal(d.subNotice.code, 'subtask_stopped');
  assert.match(d.subNotice.title, /app was offline/);
  const running = await ok(call('r-owner', 'GET', '/api/runs?place=running&kind=handoff'));
  assert.deepEqual(running.runs.map((x) => x.id), [`handoff:${hand}`]);
  assert.equal((await call('r-sara', 'GET', `/api/runs/item/handoff:${hand}`)).statusCode, 404);
  assert.match(d.copy, /sub-tasks?:/);
});

test.after(async () => { await app.close(); });
