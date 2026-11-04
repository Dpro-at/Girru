// B2.2b-3: agents (configs, CAS, role/department, personality versions and
// proposals), tool grants, task runs (lifecycle, steps, verification,
// durability rules, approvals), the cost budget and hasAgentApiKey on
// PostgreSQL, end to end, including the concurrency rules with two pool
// clients at the same time.
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on
// 127.0.0.1 that the PostgreSQL runner has already migrated (it writes test
// rows and never cleans up: drop the database afterwards). Otherwise every
// test skips. scripts/pg/integration.sh runs it.
//
// The SQLite file (a temp file, never the real .data) is watched: any
// statement on a ported table that reaches SQLite during these tests is a
// failure (last test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';

const PORTED_TABLES = /\b(agents_config|agent_personality_versions|personality_proposals|evolution_proposals|agent_evolution_history|agent_tool_grants|agent_grant_profiles|used_agent_names|task_runs|task_run_steps|task_run_verifications|task_contracts|tool_approvals|paid_usage|interactive_usage|small_agent_runs)\b/i;
const sqliteHits = [];

let m = {};
let dir;
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-agents-tasks-'));
  mkdirSync(join(dir, '.data'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  // SQLite still backs the modules that are not ported yet: a temp file, never the real .data.
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;
  process.env.AGENT_PLAYER_PG_POOL_MAX = '6';
  process.env.TASK_RUN_LEASE_MS = '60000';

  const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
  await getDatabase({ path: process.env.DATABASE_PATH }).initialize(); // B2.2d-17: an explicit temp SQLite file, watched for strays
  // Watch SQLite: a ported table must never be touched there on PostgreSQL.
  const mgr = getDatabase();
  const raw = mgr.getDb();
  for (const target of [mgr, raw]) {
    const original = target.prepare;
    target.prepare = function (sql) {
      if (PORTED_TABLES.test(String(sql))) sqliteHits.push(String(sql).replace(/\s+/g, ' ').slice(0, 120));
      return original.call(this, sql);
    };
  }
  m = {
    closeDatabase,
    pool: await import('../src/db/pg/pool.ts'),
    repos: await import('../src/repositories/index.ts'),
    actor: await import('../src/repositories/actor.ts'),
    users: (await import('../src/repositories/pg/users-store.ts')).pgUsersStore,
    agentsConfig: await import('../src/repositories/agents-config.ts'),
    store: await import('../src/services/personality-store.ts'),
    grants: await import('../src/tools/grants.ts'),
    runs: await import('../src/services/task-runs.ts'),
    contracts: await import('../src/services/task-contracts.ts'),
    budget: await import('../src/services/cost-budget.ts'),
    authority: await import('../src/credentials/authority.ts'),
    evolution: await import('../src/services/evolution-proposals.ts'),
    steps: await import('../src/repositories/sql-steps.ts'),
  };
}

const tag = randomBytes(4).toString('hex');
const one = (sql, ...p) => m.pool.pgOne(sql, ...p);
const all = (sql, ...p) => m.pool.pgAll(sql, ...p);
const pgRun = (sql, ...p) => m.pool.pgRun(sql, ...p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TEXT_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const silent = async (fn) => {
  const s = { log: console.log, warn: console.warn, info: console.info };
  console.log = () => {}; console.warn = () => {}; console.info = () => {};
  try { return await fn(); } finally { Object.assign(console, s); }
};

/**
 * Hold a lock on a second pool client while `work` starts, so the
 * concurrent calls inside really overlap; released after `ms`.
 */
async function withHeldLock(lockSql, params, work, ms = 250) {
  const pool = await m.pool.getPgPool();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(lockSql, params);
    const pending = work();
    await sleep(ms);
    await c.query('COMMIT');
    return await pending;
  } finally {
    c.release();
  }
}

const A = {};
const ids = {};

test.before(async () => {
  if (!URL_) return;
  const owner = await m.users.create({ email: `owner-${tag}@pg.test`, username: `owner_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'owner' });
  const admin = await m.users.create({ email: `admin-${tag}@pg.test`, username: `admin_${tag}`, password: `pw-${randomBytes(8).toString('hex')}`, role: 'admin' });
  A.owner = m.actor.userActor({ id: owner.id, role: 'owner' });
  A.admin = m.actor.userActor({ id: admin.id, role: 'admin' });
  ids.owner = owner.id;
});

test.after(async () => {
  if (!URL_) return;
  await m.pool.closePgPool();
  m.closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

test('agent create, read and CAS update: a wrong version is a 409; the trigger bumps the version', { skip }, async () => {
  const agents = m.repos.repositories.agents;
  const created = await silent(() => agents.createConfig(A.admin, { name: `PG Agent ${tag}`, description: 'd', role: 'specialist', department: 'Research' }));
  ids.agent = created.id;
  assert.equal(created.name, `PG Agent ${tag}`);
  assert.equal(created.version, 1);
  assert.equal(created.role, 'specialist');
  assert.equal(created.department, 'research');
  assert.match(created.created_at, TEXT_TS, 'TEXT timestamp in the SQLite format');
  assert.equal(typeof created.temperature, 'number');
  assert.equal(typeof created.max_tokens, 'number');
  assert.deepEqual(await agents.getConfig(A.admin, created.id), created);
  assert.ok((await agents.listConfigs(A.admin)).some((r) => r.id === created.id));

  // The name is reserved company-wide (same transaction as the insert).
  assert.equal((await one('SELECT agent_id FROM used_agent_names WHERE agent_id = ? AND reason = ?', created.id, 'create'))?.agent_id, created.id);
  await assert.rejects(() => agents.createConfig(A.admin, { name: `pg agent ${tag}` }), (e) => e.name === 'AgentNameTakenError' || /taken|used/i.test(e.message));

  const v2 = await agents.updateConfig(A.admin, created.id, { description: 'changed', expectedVersion: 1 });
  assert.equal(v2.description, 'changed');
  assert.equal(v2.version, 2, 'the PostgreSQL trigger bumped the version');

  await assert.rejects(() => agents.updateConfig(A.admin, created.id, { description: 'stale', expectedVersion: 1 }),
    (e) => e instanceof m.agentsConfig.AgentConfigConflictError && e.current.version === 2);
  // If-Match form too, and the CAS inside the UPDATE (a version that moves between read and write).
  await assert.rejects(() => agents.updateConfig(A.admin, created.id, { description: 'stale' }, '"1"'), m.agentsConfig.AgentConfigConflictError);
  assert.equal((await agents.getConfig(A.admin, created.id)).description, 'changed', 'nothing written by the refused updates');

  // Two concurrent updates with the same expected version: exactly one wins.
  const results = await withHeldLock('SELECT id FROM agents_config WHERE id = $1 FOR UPDATE', [created.id], () => Promise.allSettled([
    agents.updateConfig(A.admin, created.id, { description: 'A', expectedVersion: 2 }),
    agents.updateConfig(A.admin, created.id, { description: 'B', expectedVersion: 2 }),
  ]));
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.ok(results.find((r) => r.status === 'rejected').reason instanceof m.agentsConfig.AgentConfigConflictError);
  assert.equal((await agents.getConfig(A.admin, created.id)).version, 3);
});

test('role and department edit (CORE-01d): validated, versioned, personality untouched', { skip }, async () => {
  const agents = m.repos.repositories.agents;
  const before = await m.store.getCurrentPersonality(ids.agent);
  const updated = await agents.updateConfig(A.admin, ids.agent, { role: 'manager', department: '  Sales ' });
  assert.equal(updated.role, 'manager');
  assert.equal(updated.department, 'sales');
  assert.equal(updated.version, 4, 'role/department are in the trigger column list (migration 076)');
  await assert.rejects(() => agents.updateConfig(A.admin, ids.agent, { role: 'boss' }), (e) => e.code === 'invalid_role');
  const cleared = await agents.updateConfig(A.admin, ids.agent, { role: null, department: null, expectedVersion: 4 });
  assert.equal(cleared.role, null);
  assert.equal(cleared.department, null);
  assert.equal(cleared.version, 5);
  assert.deepEqual(await m.store.getCurrentPersonality(ids.agent), before, 'a role change never touches the personality');
});

test('personality versions: seed, save, lock, unlock, rollback (append-only)', { skip }, async () => {
  const agents = m.repos.repositories.agents;
  const seeded = await agents.currentPersonality(A.owner, ids.agent);
  assert.equal(seeded.version, 1, 'seeded from the role at creation');
  assert.equal(seeded.source, 'seed');
  assert.match(seeded.createdAt, ISO_Z);
  const v2 = await agents.savePersonality(A.owner, ids.agent, { traits: { warmth: 20 }, note: 'pg' });
  assert.equal(v2.version, 2);
  assert.equal(v2.traits.warmth, 20);
  const v3 = await agents.setPersonalityLocked(A.owner, ids.agent, true);
  assert.equal(v3.locked, true);
  await assert.rejects(() => agents.savePersonality(A.owner, ids.agent, { traits: { warmth: 30 } }), m.store.PersonalityLockedError);
  await agents.setPersonalityLocked(A.owner, ids.agent, false);
  const v5 = await agents.rollbackPersonality(A.owner, ids.agent, 1);
  assert.equal(v5.version, 5);
  assert.equal(v5.basedOnVersion, 1);
  assert.deepEqual(v5.traits, seeded.traits);
  assert.deepEqual((await agents.personalityVersions(A.owner, ids.agent)).map((v) => v.version), [5, 4, 3, 2, 1]);
  await assert.rejects(() => agents.rollbackPersonality(A.owner, ids.agent, 99), m.store.PersonalityNotFoundError);

  // Concurrent saves never reuse a version number (the agent row is locked).
  const saves = await Promise.all([1, 2, 3].map((n) => agents.savePersonality(A.owner, ids.agent, { traits: { warmth: 40 + n } })));
  assert.deepEqual(saves.map((v) => v.version).sort(), [6, 7, 8]);
});

test('a proposal is approved atomically: two concurrent approvals give one version only', { skip }, async () => {
  const agents = m.repos.repositories.agents;
  const p = await agents.proposePersonalityDrift(m.actor.SYSTEM_ACTOR, ids.agent, { delta: { doubt: 4 }, reason: 'pg concurrency' });
  assert.equal(p.status, 'pending');
  assert.equal(p.source, 'evolution');
  assert.match(p.createdAt, ISO_Z);
  await assert.rejects(() => agents.proposePersonalityDrift(m.actor.SYSTEM_ACTOR, ids.agent, { delta: { doubt: 2 }, reason: 'again' }),
    (e) => e.code === 'pending_exists', 'one pending Evolution proposal per agent');
  const before = (await agents.personalityVersions(A.owner, ids.agent)).length;

  // Both approvals read 'pending' first; the agent row is held by a third client, then released.
  const results = await withHeldLock('SELECT id FROM agents_config WHERE id = $1 FOR UPDATE', [ids.agent], () => Promise.allSettled([
    agents.approvePersonalityProposal(A.owner, ids.agent, p.id, p.reviewHash),
    agents.approvePersonalityProposal(A.owner, ids.agent, p.id, p.reviewHash),
  ]));
  const ok = results.filter((r) => r.status === 'fulfilled');
  const refused = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.reason?.message)));
  assert.equal(refused.length, 1);
  assert.ok(refused[0].reason instanceof m.store.PersonalityProposalError);
  assert.equal(refused[0].reason.code, 'already_decided');
  const after = await agents.personalityVersions(A.owner, ids.agent);
  assert.equal(after.length, before + 1, 'exactly one new version');
  assert.equal(after[0].source, 'evolution');
  const decided = await agents.personalityProposal(A.owner, ids.agent, p.id);
  assert.equal(decided.status, 'approved');
  assert.equal(decided.appliedVersion, after[0].version);
  assert.match(decided.decidedAt, ISO_Z);
  assert.equal((await agents.personalityProposals(A.owner, ids.agent, 'approved')).length, 1);

  // Reject / cancel use the same claim.
  const q = await agents.createPersonalityProposal(A.admin, ids.agent, { delta: { warmth: -2 }, reason: 'admin idea' });
  const r2 = await Promise.allSettled([
    agents.rejectPersonalityProposal(A.owner, ids.agent, q.id, q.reviewHash, 'no'),
    agents.cancelPersonalityProposal(A.owner, ids.agent, q.id, q.reviewHash),
  ]);
  assert.deepEqual(r2.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
});

test('Evolution proposals: approve applies once, rollback restores (PostgreSQL)', { skip }, async (t) => {
  // The prompt_append path of Evolution (GIRRU_STORE_P4 off); with P4 on it becomes a personality proposal.
  const p4 = process.env.GIRRU_STORE_P4; process.env.GIRRU_STORE_P4 = '0';
  t.after(() => { if (p4 === undefined) delete process.env.GIRRU_STORE_P4; else process.env.GIRRU_STORE_P4 = p4; });
  const out = await m.evolution.createEvolutionProposal(ids.agent, { kind: 'prompt_append', title: 't', proposedText: '\nPG line', reason: 'r' });
  assert.equal(out.status, 'proposed');
  const dup = await m.evolution.createEvolutionProposal(ids.agent, { kind: 'prompt_append', title: 't', proposedText: '\nPG line', reason: 'r' });
  assert.equal(dup.status, 'skipped');
  assert.equal(dup.reason, 'pending_exists');
  const results = await Promise.allSettled([1, 2].map(() => m.evolution.approveEvolutionProposal(ids.agent, out.proposal.id, ids.owner, out.proposal.reviewHash)));
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  const { historyId } = results.find((r) => r.status === 'fulfilled').value;
  assert.match((await one('SELECT system_prompt FROM agents_config WHERE id = ?', ids.agent)).system_prompt, /PG line$/);
  await m.evolution.rollbackEvolutionHistory(ids.agent, historyId);
  assert.doesNotMatch((await one('SELECT system_prompt FROM agents_config WHERE id = ?', ids.agent)).system_prompt, /PG line/);
  await assert.rejects(() => m.evolution.rollbackEvolutionHistory(ids.agent, historyId), (e) => e.code === 'already_rolled_back');
});

// ---------------------------------------------------------------------------
// Tool grants
// ---------------------------------------------------------------------------

const AVAILABLE = ['memory_search', 'memory_save', 'read', 'write', 'web_fetch', 'storage_search'].map((name) => ({ name }));

test('tool grants: seeded once, replaced with CAS, intersected with the parent', { skip }, async () => {
  const agents = m.repos.repositories.agents;
  const view = await agents.grantView(A.owner, ids.agent, AVAILABLE);
  assert.equal(view.source, 'default');
  assert.equal(view.version, 1);
  assert.deepEqual(view.grants.map((g) => g.tool).sort(), [...m.grants.DEFAULT_AGENT_TOOLS].sort());

  const changed = await agents.setGrants(A.owner, ids.agent, { grants: ['memory_search', 'read', { tool: 'web_fetch', scopes: { destinations: ['a'] } }], expectedVersion: 1 }, AVAILABLE);
  assert.deepEqual(changed.after, ['memory_search', 'read', 'web_fetch']);
  assert.equal(changed.version, 2);
  await assert.rejects(() => agents.setGrants(A.owner, ids.agent, { grants: ['read'], expectedVersion: 1 }, AVAILABLE), m.grants.GrantConflictError);
  assert.deepEqual((await agents.grantView(A.owner, ids.agent, AVAILABLE)).grants.map((g) => g.tool), ['memory_search', 'read', 'web_fetch'], 'nothing written by the refused replace');

  // Two concurrent replaces with the same version: one wins, the other is a conflict.
  const results = await withHeldLock('SELECT agent_id FROM agent_grant_profiles WHERE agent_id = $1 FOR UPDATE', [ids.agent], () => Promise.allSettled([
    agents.setGrants(A.owner, ids.agent, { grants: ['memory_search'], expectedVersion: 2 }, AVAILABLE),
    agents.setGrants(A.owner, ids.agent, { grants: ['read'], expectedVersion: 2 }, AVAILABLE),
  ]));
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.ok(results.find((r) => r.status === 'rejected').reason instanceof m.grants.GrantConflictError);
  const winner = results.find((r) => r.status === 'fulfilled').value.after;
  assert.deepEqual((await agents.grantView(A.owner, ids.agent, AVAILABLE)).grants.map((g) => g.tool), winner);

  // A child agent only gets a subset of its parent; effective grants intersect.
  const child = await silent(() => agents.createConfig(A.admin, { name: `PG Child ${tag}` }));
  ids.child = child.id;
  await agents.setGrants(A.owner, ids.agent, { grants: ['memory_search', 'read'] }, AVAILABLE);
  await assert.rejects(() => agents.setGrants(A.owner, child.id, { grants: ['write'], parentAgentId: ids.agent }, AVAILABLE), /subset/);
  await agents.setGrants(A.owner, child.id, { grants: ['memory_search', 'read'], parentAgentId: ids.agent }, AVAILABLE);
  await agents.setGrants(A.owner, ids.agent, { grants: ['memory_search'] }, AVAILABLE);
  assert.deepEqual([...(await m.grants.loadAgentGrants(child.id, AVAILABLE)).tools.keys()], ['memory_search']);
  assert.deepEqual([...(await m.grants.loadAgentGrants('no-such-agent', AVAILABLE)).tools.keys()], []);

  // The concurrent first use of a new agent seeds its profile once.
  const fresh = await silent(() => agents.createConfig(A.admin, { name: `PG Fresh ${tag}` }));
  const loads = await Promise.all([1, 2, 3].map(() => m.grants.loadAgentGrants(fresh.id, AVAILABLE)));
  for (const g of loads) assert.deepEqual([...g.tools.keys()].sort(), [...m.grants.DEFAULT_AGENT_TOOLS].sort());
  assert.equal((await one('SELECT COUNT(*) AS n FROM agent_grant_profiles WHERE agent_id = ?', fresh.id)).n, 1);
});

// ---------------------------------------------------------------------------
// Task runs
// ---------------------------------------------------------------------------

test('task-run lifecycle: create, claim, steps, verification, review (PostgreSQL)', { skip }, async () => {
  const R = m.runs;
  const taskId = `pg-task-${tag}`;
  const run = await R.createRun({ taskId, agentId: ids.agent, userId: ids.owner, prompt: 'secret prompt' });
  ids.run = run.id;
  assert.equal(run.status, 'queued');
  assert.match(run.created_at, TEXT_TS);
  assert.equal(typeof run.max_steps, 'number');
  assert.equal(run.input_encrypted.includes('secret prompt'), false);
  assert.equal(await R.runPrompt(run), 'secret prompt');
  assert.equal((await R.createRun({ taskId, agentId: ids.agent, userId: ids.owner, prompt: 'again' })).id, run.id, 'one unfinished run per task');

  // Two creates for a new task at the same time: one row, both get it.
  const twin = await Promise.all([1, 2].map(() => R.createRun({ taskId: `${taskId}-twin`, agentId: ids.agent, userId: ids.owner, prompt: 'x' })));
  assert.equal(twin[0].id, twin[1].id);

  // Two workers claim at the same time: exactly one lease.
  const leases = await Promise.all([R.claimRun(run.id, 'worker-a'), R.claimRun(run.id, 'worker-b')]);
  const lease = leases.find(Boolean);
  assert.equal(leases.filter(Boolean).length, 1);
  assert.equal(lease.generation, 1);
  assert.equal(await R.holdsLease(lease), true);
  assert.equal(await R.heartbeat(lease), true);

  const s0 = await R.durableStep(lease, 0, { kind: 'model', name: 'model', input: { q: 1 }, idempotent: true, run: async () => ({ answer: 42 }) });
  assert.deepEqual(s0, { result: { answer: 42 }, replayed: false });
  const replay = await R.durableStep(lease, 0, { kind: 'model', name: 'model', input: { q: 1 }, idempotent: true, run: async () => assert.fail('never runs again') });
  assert.deepEqual(replay, { result: { answer: 42 }, replayed: true });
  await assert.rejects(() => R.durableStep(lease, 0, { kind: 'model', name: 'model', input: { q: 2 }, idempotent: true, run: async () => 1 }), R.ReplayMismatchError);
  await R.recordStepUsage(run.id, 0, { provider: 'claude', model: 'm', inputTokens: 10, outputTokens: 5, costCents: 0.5, source: 'provider' });
  const steps = await R.getSteps(run.id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].status, 'completed');
  assert.match(steps[0].completed_at, TEXT_TS);
  assert.equal(steps[0].cost_cents, 0.5);
  assert.equal((await R.getRun(run.id)).checkpoint_step, 0);
  assert.equal((await R.getRun(run.id)).steps_used, 1);

  // Verification: the first stored verdict of a round wins (a resumed run replays it).
  const v0 = await R.storeVerification(lease, 0, { status: 'needs_review', reasons: ['check me'], checks: [] }, 'deterministic-checks/v1');
  assert.equal(v0.status, 'needs_review');
  const again = await R.storeVerification(lease, 0, { status: 'verified', reasons: [], checks: [] }, 'other');
  assert.equal(again.status, 'needs_review');
  assert.equal((await R.listVerifications(run.id)).length, 1);
  await R.setRunVerification(lease, 'needs_review', ['check me']);
  assert.equal(await R.finishAttempt(lease, 'completed', null, 'done'), true);
  assert.equal(await R.finishAttempt(lease, 'completed', null, 'twice'), false, 'fenced: the lease is gone');
  const done = await R.getRun(run.id);
  assert.equal(done.status, 'completed');
  assert.match(done.finished_at, TEXT_TS);
  assert.equal(done.cost_cents, 0.5);

  // Review once; a concurrent second review is refused. Either review may win the race.
  const reviews = await Promise.allSettled([
    R.reviewRun(run.id, 'accept', ids.owner, 'owner', null),
    R.reviewRun(run.id, 'reject', ids.owner, 'owner', 'no'),
  ]);
  assert.deepEqual(reviews.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(reviews.find((r) => r.status === 'rejected').reason.status, 409);
  const winner = reviews[0].status === 'fulfilled' ? 'accepted' : 'rejected';
  assert.equal(reviews.find((r) => r.status === 'fulfilled').value.review_decision, winner);
  assert.ok((await R.listRuns({ userId: ids.owner })).some((r) => r.id === run.id));
  assert.ok((await R.listRuns({ userId: null })).every((r) => r.user_id === null), 'user_id IS NOT DISTINCT FROM NULL');
  const detail = await R.runDetailView(await R.getRun(run.id));
  assert.equal(detail.verification.review.decision, winner);
  assert.match(detail.createdAt, ISO_Z);
});

test('durability rules: an interrupted side effect is not repeated; approvals decide waiting steps', { skip }, async () => {
  const R = m.runs;
  const run = await R.createRun({ taskId: `pg-dur-${tag}`, agentId: ids.agent, userId: ids.owner, prompt: 'p' });
  let lease = await R.claimRun(run.id, 'w1');
  let sends = 0;
  const send = { kind: 'tool', name: 'demo_send', input: { to: 'x' }, idempotent: false, run: async () => { sends++; return { ok: true }; } };
  await R.durableStep(lease, 0, send);
  assert.equal(sends, 1);
  // Simulate a crash after the step started but before it was recorded, and the lease expiring.
  await pgRun(`UPDATE task_run_steps SET status = 'started', result_encrypted = NULL WHERE run_id = ? AND step_index = 0`, run.id);
  await pgRun('UPDATE task_runs SET lease_expires_at = 0 WHERE id = ?', run.id);
  lease = await R.claimRun(run.id, 'w2');
  assert.ok(lease, 'expired lease: another worker claims');
  await assert.rejects(() => R.durableStep(lease, 0, send), (e) => e instanceof R.RunPausedError && e.reason === 'uncertain_step:0');
  assert.equal(sends, 1, 'never repeated automatically');
  assert.equal((await R.getSteps(run.id))[0].status, 'unknown');
  await R.finishAttempt(lease, 'waiting_approval', 'uncertain_step:0');
  const resolved = await R.resolveUncertainStep(run.id, 0, 'done', ids.owner);
  assert.equal(resolved.status, 'queued');
  assert.equal((await R.getSteps(run.id))[0].resolved_by, `${ids.owner}:done`);
  await assert.rejects(() => R.resolveUncertainStep(run.id, 0, 'done', ids.owner), (e) => e.status === 409);

  // A tool step that asks for approval: the run waits; the decided approval is replayed, never re-run.
  lease = await R.claimRun(run.id, 'w3');
  const approvalId = `ap-${tag}`;
  await pgRun(`INSERT INTO tool_approvals (id, status, agent_id, tool_name, params_encrypted, params_iv, params_tag, run_id, run_step)
              VALUES (?, 'pending', ?, 'demo_risky', 'x', 'x', 'x', ?, 1)`, approvalId, ids.agent, run.id);
  let risky = 0;
  const spec = {
    kind: 'tool', name: 'demo_risky', input: { a: 1 }, idempotent: false,
    run: async () => { risky++; return { details: { status: 'pending_approval', approvalId } }; },
    pendingApprovalOf: (r) => r?.details?.approvalId ?? null,
    approvalOutcome: (a) => ({ decided: a.status, preview: a.result_preview }),
  };
  await assert.rejects(() => R.durableStep(lease, 1, spec), (e) => e instanceof R.RunPausedError && e.reason === 'approval');
  await R.finishAttempt(lease, 'waiting_approval', 'approval');
  assert.equal(await R.requeueDecidedApprovalRuns(), 0, 'still pending: keeps waiting');
  await pgRun(`UPDATE tool_approvals SET status = 'executed', result_preview = 'sent once' WHERE id = ?`, approvalId);
  assert.equal(await R.requeueDecidedApprovalRuns(), 1);
  assert.equal((await R.getRun(run.id)).status, 'queued');
  lease = await R.claimRun(run.id, 'w4');
  const out = await R.durableStep(lease, 1, spec);
  assert.deepEqual(out, { result: { decided: 'executed', preview: 'sent once' }, replayed: true });
  assert.equal(risky, 1);

  // Cancel: a live run stops before its next step; its pending approvals are denied.
  await pgRun(`INSERT INTO tool_approvals (id, status, agent_id, tool_name, params_encrypted, params_iv, params_tag, run_id, run_step)
              VALUES (?, 'pending', ?, 'demo_risky', 'x', 'x', 'x', ?, 2)`, `${approvalId}-2`, ids.agent, run.id);
  const cancelled = await R.cancelRun(run.id, ids.owner);
  assert.equal(cancelled.cancel_requested, 1);
  assert.equal((await one('SELECT status FROM tool_approvals WHERE id = ?', `${approvalId}-2`)).status, 'denied');
  await assert.rejects(() => R.durableStep(lease, 2, { kind: 'model', name: 'model', input: {}, idempotent: true, run: async () => 1 }), R.RunCancelledError);
});

test('rollback on error: nothing of a failed transaction or a refused step is kept', { skip }, async () => {
  const R = m.runs;
  const taskId = `pg-rb-${tag}`;
  // A run created inside a transaction that then fails is rolled back with it.
  await assert.rejects(() => m.repos.withTransaction(A.owner, async () => {
    await R.createRun({ taskId, agentId: ids.agent, userId: ids.owner, prompt: 'p' });
    assert.ok(await R.activeRunForTask(taskId), 'visible inside the transaction');
    throw new Error('boom');
  }), /boom/);
  assert.equal(await R.activeRunForTask(taskId), undefined);

  // Budget: the step over max_steps is refused and reserves nothing.
  const run = await R.createRun({ taskId, agentId: ids.agent, userId: ids.owner, prompt: 'p', maxSteps: 1 });
  const lease = await R.claimRun(run.id, 'w-rb');
  await R.durableStep(lease, 0, { kind: 'model', name: 'model', input: 0, idempotent: true, run: async () => 0 });
  await assert.rejects(() => R.durableStep(lease, 1, { kind: 'model', name: 'model', input: 1, idempotent: true, run: async () => 1 }),
    (e) => e instanceof R.BudgetExceededError && e.which === 'steps');
  assert.equal((await R.getRun(run.id)).steps_used, 1);
  assert.equal((await R.getSteps(run.id)).length, 1);

  // A stale worker (lost lease) can neither reserve nor record a step.
  await pgRun('UPDATE task_runs SET lease_expires_at = 0, max_steps = 5 WHERE id = ?', run.id);
  const fresh = await R.claimRun(run.id, 'w-rb-2');
  await assert.rejects(() => R.durableStep(lease, 1, { kind: 'model', name: 'model', input: 1, idempotent: true, run: async () => 1 }), R.LeaseLostError);
  assert.equal((await R.getSteps(run.id)).length, 1);
  assert.equal((await R.getRun(run.id)).steps_used, 1);
  // A step that fails is recorded failed, its run attempt goes on fenced.
  await assert.rejects(() => R.durableStep(fresh, 1, { kind: 'model', name: 'model', input: 1, idempotent: true, run: async () => { throw new Error('model down'); } }), /model down/);
  assert.equal((await R.getSteps(run.id))[1].status, 'failed');

  // The contract store upserts on PostgreSQL.
  await m.contracts.storeTaskContract(taskId, { goal: 'g', maxVerificationRetries: 0 }, ids.owner);
  await m.contracts.storeTaskContract(taskId, { goal: 'g2', maxVerificationRetries: 0 }, ids.owner);
  assert.equal((await m.contracts.getTaskContract(taskId)).goal, 'g2');
});

// ---------------------------------------------------------------------------
// Cost budget
// ---------------------------------------------------------------------------

test('cost budget: a reservation cannot be double-spent by two concurrent clients; release frees it', { skip }, async () => {
  const B = m.budget;
  process.env.MODEL_PRICES_JSON = JSON.stringify({ claude: { default: { input: 1, output: 1 } } });
  const req = { provider: 'claude', model: 'pg-model', payload: { messages: ['x'.repeat(300)] }, maxOutputTokens: 4000, purpose: 'task_run' };
  const est = B.costCents(B.priceFor('claude', 'pg-model'), B.estimateTokens(req.payload), 4000);
  const spentBefore = await B.spentCents();
  // The cap (whole cents) fits one reservation, never two.
  process.env.DAILY_PAID_CAP_CENTS = String(Math.floor(spentBefore + est * 1.5));
  assert.ok(Number(process.env.DAILY_PAID_CAP_CENTS) >= spentBefore + est && Number(process.env.DAILY_PAID_CAP_CENTS) < spentBefore + 2 * est);
  try {
    // Both calls wait on the budget lock (held by a third client), then run one after another.
    const results = await withHeldLock('SELECT pg_advisory_xact_lock($1)', [B.BUDGET_LOCK_KEY], () => Promise.allSettled([B.reservePaidCall(req), B.reservePaidCall(req)]));
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 1, JSON.stringify(results.map((r) => r.reason?.message)));
    const refused = results.find((r) => r.status === 'rejected').reason;
    assert.ok(refused instanceof B.CostBudgetError);
    assert.equal(refused.which, 'daily_cap');
    const ticket = ok[0].value;
    assert.equal(typeof ticket.id, 'number', 'RETURNING id instead of lastInsertRowid');
    assert.equal((await one('SELECT status FROM paid_usage WHERE id = ?', ticket.id)).status, 'reserved');
    assert.ok(Math.abs((await B.spentCents()) - (spentBefore + est)) < 0.001);

    await B.releasePaidCall(ticket);
    assert.equal((await one('SELECT status FROM paid_usage WHERE id = ?', ticket.id)).status, 'released');
    assert.ok(Math.abs((await B.spentCents()) - spentBefore) < 0.001, 'released: no longer counted');

    const next = await B.reservePaidCall({ ...req, runId: ids.run, stepIndex: 0, runLimitCents: est * 2 });
    const used = await B.recordPaidCall(next, { inputTokens: 100, outputTokens: 100 });
    assert.equal(used.source, 'provider');
    const row = await one('SELECT status, cost_cents, updated_at FROM paid_usage WHERE id = ?', next.id);
    assert.equal(row.status, 'recorded');
    assert.match(row.updated_at, TEXT_TS);
    const view = await B.budgetView();
    assert.equal(view.dailyCapCents, Number(process.env.DAILY_PAID_CAP_CENTS));
    assert.ok(view.byProvider.some((p) => p.provider === 'claude'));
  } finally {
    delete process.env.MODEL_PRICES_JSON;
    delete process.env.DAILY_PAID_CAP_CENTS;
  }
});

// ---------------------------------------------------------------------------
// Credential authority
// ---------------------------------------------------------------------------

test('hasAgentApiKey reads agents_config on PostgreSQL', { skip }, async () => {
  const { hasAgentApiKey } = m.authority;
  assert.equal(await hasAgentApiKey(ids.child), false);
  await pgRun('UPDATE agents_config SET api_key_credential_id = ? WHERE id = ?', `cred-${tag}`, ids.child);
  assert.equal(await hasAgentApiKey(ids.child), true);
  assert.equal(await hasAgentApiKey('no-such-agent'), false);
  assert.equal(await hasAgentApiKey('bad id!'), false, 'invalid ids are never queried');
});

test('no ported table was touched on SQLite while the driver was PostgreSQL', { skip }, () => {
  assert.deepEqual(sqliteHits, []);
});
