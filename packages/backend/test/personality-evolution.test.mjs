// CORE-01d (MEM-03): Evolution proposes personality drift from verified
// task-run outcomes (never applies it), role/department editing, proposal
// cancel. Run: node --import tsx --test test/personality-evolution.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-personality-evolution-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${String(url)}`); };

const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error };
console.log = () => {};
console.warn = () => {};
console.info = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('pe-owner', 'owner');
addUser('pe-admin', 'admin');
addUser('pe-admin2', 'admin');
addUser('pe-user', 'user');
const addAgent = (id) => db.prepare(`INSERT INTO agents_config (id, name) VALUES (?, ?)`).run(id, `Agent ${id}`);
for (const id of ['pe-evo', 'pe-quiet', 'pe-locked', 'pe-cycle', 'pe-cancel', 'pe-route']) addAgent(id);

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { agentPersonalityRoutes } = await import(join(backendDir, 'src/api/routes/agent-personality.ts'));
const { agentsConfigRoutes } = await import(join(backendDir, 'src/api/routes/agents-config.ts'));
const { default: evolutionRoutes } = await import(join(backendDir, 'src/api/routes/evolution.ts'));
const P = await import(join(backendDir, 'src/services/personality.ts'));
const store = await import(join(backendDir, 'src/services/personality-store.ts'));
const evo = await import(join(backendDir, 'src/services/personality-evolution.ts'));
const { evolveAgent } = await import(join(backendDir, 'src/services/agent-evolution-orchestrator.js'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { storeP4Enabled } = await import(join(backendDir, 'src/services/store-p4.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(agentPersonalityRoutes);
await app.register(agentsConfigRoutes);
await app.register(evolutionRoutes);
await app.ready();

Object.assign(console, quiet);

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => (id ? { authorization: `Bearer ${generateToken(id, 1)}` } : {});
const base = (id) => `/api/agents/${id}/personality`;
const quietly = async (fn) => { const s = { ...console }; console.log = () => {}; console.warn = () => {}; console.info = () => {}; console.error = () => {}; try { return await fn(); } finally { Object.assign(console, s); } };
const versionsOf = (id) => db.prepare('SELECT version FROM agent_personality_versions WHERE agent_id = ? ORDER BY version').all(id).map((r) => r.version);
// STORE-MAP-01 P4: with the switch on, the record also gets one system 'import' version (the PERSONALITY.md text, once).
const changesOf = (id) => db.prepare("SELECT version FROM agent_personality_versions WHERE agent_id = ? AND source <> 'import' ORDER BY version").all(id).map((r) => r.version);
const proposalsOf = (id, source) => db.prepare(`SELECT * FROM personality_proposals WHERE agent_id = ?${source ? ' AND source = ?' : ''} ORDER BY rowid`).all(...[id, ...(source ? [source] : [])]);

/** A finished contract run with its verification rounds (R1 columns). */
function addRun(agentId, { firstRound = 'verified', final = 'verified', review = null, reviewer = 'owner', daysAgo = 0 } = {}) {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO task_runs (id, task_id, agent_id, status, max_steps, max_duration_ms, verification_status, max_verification_retries,
      review_decision, reviewer_kind, finished_at)
    VALUES (?, ?, ?, 'completed', 10, 60000, ?, 1, ?, ?, datetime('now', ?))
  `).run(id, `task-${id}`, agentId, final, review, review ? reviewer : null, `-${daysAgo} days`);
  db.prepare(`INSERT INTO task_run_verifications (run_id, round, status, reasons, checks, verifier) VALUES (?, 0, ?, '[]', '[]', 'deterministic-checks/v1')`).run(id, firstRound);
  return id;
}

const stats = (o) => ({ windowDays: 30, contractRuns: 10, firstRoundFailures: [], ownerRejections: [], verificationExhausted: [], ...o });
const ids = (n, p = 'r') => Array.from({ length: n }, (_, i) => `${p}${i}`);

// --- the pure rule ---------------------------------------------------------------

test('suggestPersonalityDrift: repeated unchecked claims raise doubt and thoroughness by 2..5', () => {
  assert.equal(evo.suggestPersonalityDrift(stats({})), null, 'nothing repeats');
  assert.equal(evo.suggestPersonalityDrift(stats({ firstRoundFailures: ids(2) })), null, 'twice is not repeated');
  const three = evo.suggestPersonalityDrift(stats({ firstRoundFailures: ids(3) }));
  assert.deepEqual(three.delta, { doubt: 2, thoroughness: 2 });
  assert.deepEqual(three.evidence, ['task-run:r0', 'task-run:r1', 'task-run:r2']);
  assert.match(three.reason, /^Evolution: 3 of 10 contract runs .*acceptance checks/);
  assert.deepEqual(evo.suggestPersonalityDrift(stats({ firstRoundFailures: ids(4) })).delta, { doubt: 3, thoroughness: 3 });
  assert.deepEqual(evo.suggestPersonalityDrift(stats({ contractRuns: 50, firstRoundFailures: ids(12) })).delta, { doubt: 5, thoroughness: 5 }, 'capped at 5');
  // A small share of many runs is not a pattern.
  assert.equal(evo.suggestPersonalityDrift(stats({ contractRuns: 100, firstRoundFailures: ids(5) })), null);
  assert.equal(evo.suggestPersonalityDrift(stats({ contractRuns: 0, firstRoundFailures: ids(5) })), null);
  assert.deepEqual([3, 4, 5, 6, 9].map(evo.stepFor), [2, 3, 4, 5, 5]);
});

test('suggestPersonalityDrift: owner rejections raise thoroughness, exhausted retries raise persistence; largest step wins', () => {
  assert.deepEqual(evo.suggestPersonalityDrift(stats({ ownerRejections: ids(3, 'o') })).delta, { thoroughness: 2 });
  assert.deepEqual(evo.suggestPersonalityDrift(stats({ verificationExhausted: ids(5, 'x') })).delta, { persistence: 4 });
  const all = evo.suggestPersonalityDrift(stats({ firstRoundFailures: ids(3), ownerRejections: ids(6, 'o'), verificationExhausted: ids(3, 'x') }));
  assert.deepEqual(all.delta, { doubt: 2, thoroughness: 5, persistence: 2 }, 'max per trait, not a sum');
  assert.equal(all.evidence.length, 12);
  assert.ok(all.evidence.every((e) => /^task-run:/.test(e)));
  // Evidence never exceeds the proposal limit; caution is never touched.
  const many = evo.suggestPersonalityDrift(stats({ contractRuns: 60, firstRoundFailures: ids(15), ownerRejections: ids(15, 'o') }));
  assert.equal(many.evidence.length, store.MAX_EVIDENCE_ITEMS);
  assert.equal(many.delta.caution, undefined);
  for (const s of [all, many]) for (const v of Object.values(s.delta)) assert.ok(v >= 2 && v <= 5);
});

// --- Evolution files a proposal, never a version ------------------------------------

test('Evolution path: verified outcomes create one pending proposal and no version; dedup while pending', async () => {
  await store.savePersonalityVersion('pe-evo', { preset: 'balanced-assistant' }, 'pe-owner');
  const before = await store.getCurrentPersonality('pe-evo');
  const failed = [1, 2, 3].map(() => addRun('pe-evo', { firstRound: 'failed_verification' }));
  addRun('pe-evo'); addRun('pe-evo');
  addRun('pe-evo', { firstRound: 'failed_verification', daysAgo: 60 }); // outside the window
  addRun('pe-quiet'); // another agent's runs do not count

  const s = await evo.collectOutcomeStats('pe-evo');
  assert.equal(s.contractRuns, 5);
  assert.deepEqual([...s.firstRoundFailures].sort(), [...failed].sort());

  const out = await evo.proposeDriftFromOutcomes('pe-evo');
  assert.equal(out.status, 'proposed');
  const p = out.proposal;
  assert.equal(p.status, 'pending');
  assert.equal(p.source, 'evolution');
  assert.equal(p.createdBy, 'evolution');
  assert.deepEqual(p.delta, { doubt: 2, thoroughness: 2 });
  assert.deepEqual([...p.evidence].sort(), failed.map((id) => `task-run:${id}`).sort());
  assert.deepEqual(versionsOf('pe-evo'), [before.version], 'no version written');
  assert.deepEqual((await store.getCurrentPersonality('pe-evo')).traits, before.traits);

  // Dedup: a second cycle while the first is pending files nothing.
  addRun('pe-evo', { firstRound: 'failed_verification' });
  const again = await evo.proposeDriftFromOutcomes('pe-evo');
  assert.equal(again.status, 'skipped');
  assert.equal(again.reason, 'pending_exists');
  assert.equal(again.proposalId, p.id);
  assert.equal(proposalsOf('pe-evo', 'evolution').length, 1);
  // Also enforced inside the insert transaction (not only the pre-check).
  await assert.rejects(() => import(join(backendDir, 'src/repositories/index.ts')).then(({ repositories }) =>
    import(join(backendDir, 'src/repositories/actor.ts')).then(({ SYSTEM_ACTOR }) =>
      repositories.agents.proposePersonalityDrift(SYSTEM_ACTOR, 'pe-evo', { delta: { doubt: 2 }, reason: 'x' }))),
  (e) => e.code === 'pending_exists' && e.status === 409);
  // A person's proposal is not blocked by the Evolution one.
  const own = await app.inject({ method: 'POST', url: `${base('pe-evo')}/proposals`, headers: auth('pe-owner'), payload: { delta: { warmth: 2 }, reason: 'owner idea' } });
  assert.equal(own.statusCode, 201, own.body);

  // Once the owner decides it, Evolution may propose again.
  const rej = await app.inject({ method: 'POST', url: `${base('pe-evo')}/proposals/${p.id}/reject`, headers: auth('pe-owner'), payload: { expectedReviewHash: p.reviewHash } });
  assert.equal(rej.statusCode, 200, rej.body);
  const next = await evo.proposeDriftFromOutcomes('pe-evo');
  assert.equal(next.status, 'proposed');
  assert.deepEqual(next.proposal.delta, { doubt: 3, thoroughness: 3 }, '4 failures now');
  assert.deepEqual(versionsOf('pe-evo'), [before.version], 'still no version: only the owner applies drift');
});

test('Evolution path: no signal, locked personality and unknown agent are skips, not errors', async () => {
  addRun('pe-quiet'); addRun('pe-quiet');
  assert.deepEqual((await evo.proposeDriftFromOutcomes('pe-quiet')).reason, 'no_signal');
  for (let i = 0; i < 3; i++) addRun('pe-locked', { review: 'rejected' });
  addRun('pe-locked', { review: 'rejected', reviewer: 'large_agent' }); // not the owner
  assert.equal((await evo.collectOutcomeStats('pe-locked')).ownerRejections.length, 3);
  await store.setPersonalityLocked('pe-locked', true, 'pe-owner');
  assert.equal((await evo.proposeDriftFromOutcomes('pe-locked')).reason, 'personality_locked');
  assert.equal((await evo.proposeDriftFromOutcomes('ghost')).reason, 'agent_not_found');
  assert.equal(proposalsOf('pe-locked').length + proposalsOf('pe-quiet').length, 0);
});

test('the evolve cycle runs the proposal step (system actor) and never applies drift', async () => {
  db.prepare(`INSERT OR REPLACE INTO agent_evolution_config (agent_id, enabled) VALUES ('pe-cycle', 1)`).run();
  for (let i = 0; i < 3; i++) addRun('pe-cycle', { firstRound: 'failed_verification', final: 'failed_verification' });
  const result = await quietly(() => evolveAgent('pe-cycle'));
  assert.equal(result.personalityProposal.status, 'proposed', JSON.stringify(result));
  assert.deepEqual(result.personalityProposal.delta, { doubt: 2, thoroughness: 2, persistence: 2 });
  assert.equal(result.skipped, true, 'the config part still needs its sample size');
  assert.deepEqual(versionsOf('pe-cycle'), []);
  const second = await quietly(() => evolveAgent('pe-cycle'));
  assert.equal(second.personalityProposal.reason, 'pending_exists');
  assert.equal(proposalsOf('pe-cycle', 'evolution').length, 1);
  // Disabled Evolution: nothing at all.
  db.prepare(`UPDATE agent_evolution_config SET enabled = 0 WHERE agent_id = 'pe-cycle'`).run();
  assert.equal((await evolveAgent('pe-cycle')).personalityProposal, undefined);
});

test('POST /api/evolution/:agentId/personality-proposal: owner only, 201 proposed / 200 skipped / 404', async () => {
  const url = '/api/evolution/pe-route/personality-proposal';
  for (const [who, code] of [[null, 401], ['pe-admin', 403], ['pe-user', 403]]) {
    assert.equal((await app.inject({ method: 'POST', url, headers: auth(who), payload: {} })).statusCode, code, String(who));
  }
  const none = await app.inject({ method: 'POST', url, headers: auth('pe-owner'), payload: {} });
  assert.equal(none.statusCode, 200, none.body);
  assert.equal(none.json().reason, 'no_signal');
  for (let i = 0; i < 3; i++) addRun('pe-route', { firstRound: 'failed_verification', daysAgo: 10 });
  assert.equal((await app.inject({ method: 'POST', url, headers: auth('pe-owner'), payload: { windowDays: 7 } })).json().reason, 'no_signal', 'outside a 7-day window');
  const made = await app.inject({ method: 'POST', url, headers: auth('pe-owner'), payload: { windowDays: 14 } });
  assert.equal(made.statusCode, 201, made.body);
  assert.equal(made.json().proposal.source, 'evolution');
  assert.equal(made.json().stats.firstRoundFailures.length, 3);
  assert.equal((await app.inject({ method: 'POST', url, headers: auth('pe-owner'), payload: {} })).json().reason, 'pending_exists');
  assert.equal((await app.inject({ method: 'POST', url, headers: auth('pe-owner'), payload: { windowDays: 0 } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/evolution/ghost/personality-proposal', headers: auth('pe-owner'), payload: {} })).statusCode, 404);
  assert.deepEqual(versionsOf('pe-route'), []);
});

// --- role / department editing -------------------------------------------------------

test('PUT /api/agents/:id edits role/department with create validation; the personality stays', async () => {
  const created = await quietly(() => app.inject({ method: 'POST', url: '/api/agents', headers: auth('pe-owner'), payload: { name: 'Role Editing Agent', role: 'evaluator' } }));
  assert.equal(created.statusCode, 201, created.body);
  const agent = created.json().agent;
  const before = await store.getCurrentPersonality(agent.id);
  assert.equal(before.preset, 'strict-evaluator');
  const put = (payload, who = 'pe-owner') => quietly(() => app.inject({ method: 'PUT', url: `/api/agents/${agent.id}`, headers: auth(who), payload }));

  const ok = await put({ role: 'specialist', department: '  Marketing  Team ', expectedVersion: agent.version });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().agent.role, 'specialist');
  assert.equal(ok.json().agent.department, 'marketing team');
  assert.equal(ok.json().agent.version, agent.version + 1);
  // Role change: metadata only.
  const after = await store.getCurrentPersonality(agent.id);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.traits, before.traits);
  assert.equal(after.preset, 'strict-evaluator');
  assert.deepEqual(versionsOf(agent.id), [1]);

  // Admin may edit too; null clears.
  const cleared = await put({ role: null, department: '' }, 'pe-admin');
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().agent.role, null);
  assert.equal(cleared.json().agent.department, null);
  assert.equal((await put({ role: 'manager' }, 'pe-user')).statusCode, 403);

  const current = cleared.json().agent;
  for (const payload of [{ role: 'emperor' }, { role: 7 }, { department: 'x'.repeat(65) }, { department: ['dev'] }]) {
    const res = await put(payload);
    assert.equal(res.statusCode, 400, `${JSON.stringify(payload).slice(0, 50)} -> ${res.body}`);
    assert.equal(res.json().code, 'invalid_role');
  }
  // CAS (BE-UI-01): a stale expectedVersion is refused and nothing changes.
  const stale = await put({ role: 'manager', expectedVersion: agent.version });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, 'version_conflict');
  const row = db.prepare('SELECT role, department, version FROM agents_config WHERE id = ?').get(agent.id);
  assert.deepEqual({ ...row }, { role: null, department: null, version: current.version });
});

test('duplicate copies role and department, not personality versions (P4: the record as version 1)', async () => {
  const created = await quietly(() => app.inject({ method: 'POST', url: '/api/agents', headers: auth('pe-owner'), payload: { name: 'Dup Source Agent', role: 'specialist', department: 'Finance' } }));
  const src = created.json().agent;
  const dup = await quietly(() => app.inject({ method: 'POST', url: `/api/agents/${src.id}/duplicate`, headers: auth('pe-admin') }));
  assert.equal(dup.statusCode, 201, dup.body);
  assert.equal(dup.json().agent.role, 'specialist');
  assert.equal(dup.json().agent.department, 'finance');
  assert.deepEqual(versionsOf(dup.json().agent.id), storeP4Enabled() ? [1] : []);
  assert.deepEqual(versionsOf(src.id), [1]);
});

// --- cancel ------------------------------------------------------------------------

test('cancel: owner cancels any pending proposal; creator admin cancels own; others 403; decided -> 409', async () => {
  await store.savePersonalityVersion('pe-cancel', { preset: 'balanced-assistant' }, 'pe-owner');
  const propose = async (who, reason) => {
    const res = await app.inject({ method: 'POST', url: `${base('pe-cancel')}/proposals`, headers: auth(who), payload: { delta: { curiosity: 2 }, reason } });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  };
  const cancel = (pid, payload, who) => app.inject({ method: 'POST', url: `${base('pe-cancel')}/proposals/${pid}/cancel`, headers: auth(who), payload });
  const before = changesOf('pe-cancel');

  // Owner cancels an admin's proposal.
  const a = await propose('pe-admin', 'admin idea');
  const ownerCancel = await cancel(a.id, { expectedReviewHash: a.reviewHash }, 'pe-owner');
  assert.equal(ownerCancel.statusCode, 200, ownerCancel.body);
  assert.equal(ownerCancel.json().status, 'cancelled');
  assert.equal(ownerCancel.json().decidedBy, 'pe-owner');
  // Double cancel -> 409 already_decided.
  const twice = await cancel(a.id, { expectedReviewHash: a.reviewHash }, 'pe-owner');
  assert.equal(twice.statusCode, 409);
  assert.equal(twice.json().code, 'already_decided');

  // The creating admin cancels its own; another admin or a user may not.
  const b = await propose('pe-admin', 'second idea');
  assert.equal((await cancel(b.id, { expectedReviewHash: b.reviewHash }, 'pe-admin2')).statusCode, 403);
  assert.equal((await cancel(b.id, { expectedReviewHash: b.reviewHash }, 'pe-user')).statusCode, 403);
  assert.equal((await cancel(b.id, { expectedReviewHash: b.reviewHash }, null)).statusCode, 401);
  assert.equal((await cancel(b.id, {}, 'pe-admin')).json().code, 'review_hash_required');
  assert.equal((await cancel(b.id, { expectedReviewHash: 'c'.repeat(64) }, 'pe-admin')).json().code, 'review_changed');
  const own = await cancel(b.id, { expectedReviewHash: b.reviewHash }, 'pe-admin');
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.json().decidedBy, 'pe-admin');

  // An admin cannot cancel an owner's or Evolution's proposal.
  const c = await propose('pe-owner', 'owner idea');
  assert.equal((await cancel(c.id, { expectedReviewHash: c.reviewHash }, 'pe-admin')).statusCode, 403);

  // Cancel after approve -> 409, the approved version stays.
  const ok = await app.inject({ method: 'POST', url: `${base('pe-cancel')}/proposals/${c.id}/approve`, headers: auth('pe-owner'), payload: { expectedReviewHash: c.reviewHash } });
  assert.equal(ok.statusCode, 200, ok.body);
  const late = await cancel(c.id, { expectedReviewHash: c.reviewHash }, 'pe-owner');
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().code, 'already_decided');
  assert.equal(changesOf('pe-cancel').length, before.length + 1, 'only the approval wrote a version');
  assert.equal((await cancel('00000000-0000-0000-0000-000000000000', { expectedReviewHash: c.reviewHash }, 'pe-admin')).statusCode, 404);

  const audit = db.prepare(`SELECT user_id FROM audit_logs WHERE action = 'agent_personality.proposal.cancel' AND success = 1 ORDER BY rowid`).all();
  assert.deepEqual(audit.map((r) => r.user_id), ['pe-owner', 'pe-admin']);
});
