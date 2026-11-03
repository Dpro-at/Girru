// S0-Q.23: Evolution never changes an agent by itself. A cycle (route, evolve-all
// or the scheduler job) files pending proposals for system-prompt / PERSONALITY.md
// additions; only the owner's approval applies one (reviewHash, CAS on the base
// content hash). Capabilities are never changed by any Evolution path.
// Run: node --import tsx --test test/evolution-proposals.test.mjs
// Throwaway DB + cwd, random test-only secrets, hash embeddings, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-evolution-proposals-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.MEMORY_EMBEDDINGS = 'hash';

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
addUser('ep-owner', 'owner');
addUser('ep-admin', 'admin');
addUser('ep-user', 'user');

const CAPS = JSON.stringify({ webSearch: false, fileOperations: false, memory: true, executeCommands: false });
const PROMPT = 'You are a careful helper.';
const addAgent = (id) => {
  db.prepare(`INSERT INTO agents_config (id, name, system_prompt, capabilities) VALUES (?, ?, ?, ?)`).run(id, `Agent ${id}`, PROMPT, CAPS);
  // Default allowed_evolutions includes capability_added: it must still never apply.
  db.prepare(`INSERT INTO agent_evolution_config (agent_id, enabled, min_confidence_threshold, min_sample_size) VALUES (?, 1, 0.7, 10)`).run(id);
};
/** Activity that yields failure_pattern, optimization and new_capability (fileOperations) insights. */
const seedActivity = (agentId) => {
  const ins = db.prepare(`INSERT INTO agent_activity (id, agent_id, action_type, tool_name, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const at = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < 12; i++) ins.run(randomUUID(), agentId, 'task_failed', null, `could not read file report-${i}.txt`, JSON.stringify({ error: 'timeout' }), at);
  for (let i = 0; i < 3; i++) ins.run(randomUUID(), agentId, 'task_completed', null, 'done', '{}', at);
};
for (const id of ['ep-cycle', 'ep-route', 'ep-sched', 'ep-decide', 'ep-stale', 'ep-all']) { addAgent(id); seedActivity(id); }

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { default: evolutionRoutes } = await import(join(backendDir, 'src/api/routes/evolution.ts'));
const { evolveAgent } = await import(join(backendDir, 'src/services/agent-evolution-orchestrator.js'));
const EP = await import(join(backendDir, 'src/services/evolution-proposals.ts'));
const { getAgentDir } = await import(join(backendDir, 'src/services/agent-files.ts'));
const { scheduleAgentEvolution } = await import(join(backendDir, 'src/services/agent-evolution-scheduler.js'));
const { getCronEngine } = await import(join(backendDir, 'src/scheduler/engine.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { storeP4Enabled } = await import(join(backendDir, 'src/services/store-p4.ts'));
const store = await import(join(backendDir, 'src/services/personality-store.ts'));
// STORE-MAP-01 P4 (G3): with the switch on, Evolution suggests in Personality review (a personality text proposal)
// and never adds to the owner instructions; the review table of this file is no longer used for these kinds.
const P4 = storeP4Enabled();
const P4_SKIP = P4 && 'P4 on: Evolution text goes to Personality review (approve/stale covered by store-p4-personality and personality-evolution)';
const { default: Fastify } = await import('fastify');
const engine = getCronEngine();

const app = Fastify();
registerAuthGate(app);
await app.register(evolutionRoutes);
await app.ready();

Object.assign(console, quiet);

test.after(async () => {
  globalThis.fetch = realFetch;
  await engine.stop();
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const quietly = async (fn) => { const s = { ...console }; console.log = () => {}; console.warn = () => {}; console.info = () => {}; console.error = () => {}; try { return await fn(); } finally { Object.assign(console, s); } };
const personalityFile = (id) => join(getAgentDir(id), 'PERSONALITY.md');
const personalityText = (id) => (existsSync(personalityFile(id)) ? readFileSync(personalityFile(id), 'utf-8') : null);
/** Everything Evolution must not touch by itself. */
const snapshot = (id) => {
  const row = db.prepare('SELECT system_prompt, capabilities FROM agents_config WHERE id = ?').get(id);
  return { ...row, personality: personalityText(id) };
};
const pendingOf = (id, kind) => db.prepare(`SELECT * FROM evolution_proposals WHERE agent_id = ? AND status = 'pending'${kind ? ' AND kind = ?' : ''} ORDER BY rowid`).all(...[id, ...(kind ? [kind] : [])]);
const personalityPendingOf = (id) => db.prepare(`SELECT * FROM personality_proposals WHERE agent_id = ? AND status = 'pending' AND source = 'evolution' ORDER BY rowid`).all(id);
const historyOf = (id) => db.prepare('SELECT * FROM agent_evolution_history WHERE agent_id = ? ORDER BY rowid').all(id);
const post = (url, who, payload = {}) => app.inject({ method: 'POST', url, headers: auth(who), payload });
const proposalUrl = (agentId, pid, action) => `/api/evolution/${agentId}/proposals/${pid}/${action}`;
const view = async (agentId, pid) => {
  const res = await app.inject({ method: 'GET', url: `/api/evolution/${agentId}/proposals/${pid}`, headers: auth('ep-admin') });
  assert.equal(res.statusCode, 200, res.body);
  return res.json().proposal;
};

test('an evolve cycle changes nothing and files pending prompt + PERSONALITY.md proposals', async () => {
  const before = snapshot('ep-cycle');
  const result = await quietly(() => evolveAgent('ep-cycle'));
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.evolved, false);
  assert.ok(result.proposed >= (P4 ? 1 : 2), JSON.stringify(result.proposals));
  assert.deepEqual(snapshot('ep-cycle'), before, 'system_prompt, capabilities and PERSONALITY.md unchanged');
  assert.deepEqual(historyOf('ep-cycle'), [], 'no history row: nothing was applied');
  if (P4) {
    assert.deepEqual(pendingOf('ep-cycle'), [], 'nothing in the old review table');
    assert.ok(result.proposals.some((p) => p.status === 'skipped' && p.reason === 'owner_instructions_only'), JSON.stringify(result.proposals));
    assert.ok(personalityPendingOf('ep-cycle').length >= 1, 'a Personality review suggestion');
    const again = await quietly(() => evolveAgent('ep-cycle'));
    assert.deepEqual(snapshot('ep-cycle'), before);
    assert.equal(again.evolved, false);
    return;
  }

  const prompts = pendingOf('ep-cycle', 'prompt_append');
  const notes = pendingOf('ep-cycle', 'personality_text');
  assert.ok(prompts.length >= 1 && notes.length >= 1);
  for (const p of [...prompts, ...notes]) {
    assert.ok(p.proposed_text.length <= EP.MAX_PROPOSED_TEXT_CHARS);
    assert.equal(p.source, 'evolution');
    assert.equal(p.created_by, EP.EVOLUTION_AUTHOR);
  }
  // Capability ideas come back as an informational note only.
  const caps = result.suggestedCapabilities;
  assert.ok(caps.some((c) => c.capability === 'fileOperations' && c.applied === false), JSON.stringify(caps));

  // A second cycle does not file the same proposals again.
  const count = pendingOf('ep-cycle').length;
  const again = await quietly(() => evolveAgent('ep-cycle'));
  assert.equal(again.proposed, 0, JSON.stringify(again.proposals));
  assert.ok(again.proposals.every((p) => p.status === 'skipped' && p.reason === 'pending_exists'));
  assert.equal(pendingOf('ep-cycle').length, count);
});

test('admin can no longer evolve (403); owner can, and the route only proposes', async () => {
  const before = snapshot('ep-route');
  const admin = await post('/api/evolution/ep-route/evolve', 'ep-admin');
  assert.equal(admin.statusCode, 403, admin.body);
  assert.equal(pendingOf('ep-route').length, 0);
  for (const [m, u] of [['POST', '/api/evolution/evolve-all'], ['PUT', '/api/evolution/ep-route/config'],
    ['POST', '/api/evolution/ep-route/rollback/x'], ['POST', '/api/evolution/ep-route/analyze']]) {
    const res = await app.inject({ method: m, url: u, headers: auth('ep-admin'), payload: {} });
    assert.equal(res.statusCode, 403, `${m} ${u}: ${res.body}`);
  }

  const owner = await quietly(() => post('/api/evolution/ep-route/evolve', 'ep-owner'));
  assert.equal(owner.statusCode, 200, owner.body);
  assert.equal(owner.json().evolved, false);
  assert.ok(owner.json().proposed >= (P4 ? 1 : 2));
  assert.deepEqual(snapshot('ep-route'), before);
  if (P4) assert.ok(personalityPendingOf('ep-route').length >= 1);

  // Reads stay admin; plain users are refused.
  const list = await app.inject({ method: 'GET', url: '/api/evolution/ep-route/proposals?status=pending', headers: auth('ep-admin') });
  assert.equal(list.statusCode, 200, list.body);
  assert.ok(list.json().total >= (P4 ? 0 : 2));
  const user = await app.inject({ method: 'GET', url: '/api/evolution/ep-route/proposals', headers: auth('ep-user') });
  assert.equal(user.statusCode, 403);
});

test('the scheduler job and evolve-all only file proposals too', async () => {
  const before = snapshot('ep-sched');
  await scheduleAgentEvolution('ep-sched', 'daily');
  const job = db.prepare(`SELECT id FROM cron_jobs WHERE name = 'agent-evolution-ep-sched'`).get();
  const out = await quietly(() => engine.executeJob(job.id));
  assert.equal(out.success, true, out.error);
  assert.ok(out.output.proposed >= 2);
  assert.deepEqual(snapshot('ep-sched'), before);

  const allBefore = snapshot('ep-all');
  const all = await quietly(() => post('/api/evolution/evolve-all', 'ep-owner'));
  assert.equal(all.statusCode, 200, all.body);
  assert.equal(all.json().summary.evolved, 0);
  assert.ok(all.json().summary.proposed >= 2);
  assert.deepEqual(snapshot('ep-all'), allBefore);
});

test('approve with the right hash applies; double approve 409; non-owner 403; bad hashes refused', { skip: P4_SKIP }, async () => {
  await quietly(() => evolveAgent('ep-decide'));
  const [prompt] = pendingOf('ep-decide', 'prompt_append');
  const [note] = pendingOf('ep-decide', 'personality_text');
  const pv = await view('ep-decide', prompt.id);
  assert.match(pv.reviewHash, /^[0-9a-f]{64}$/);

  const adminTry = await post(proposalUrl('ep-decide', prompt.id, 'approve'), 'ep-admin', { expectedReviewHash: pv.reviewHash });
  assert.equal(adminTry.statusCode, 403, adminTry.body);
  const noHash = await post(proposalUrl('ep-decide', prompt.id, 'approve'), 'ep-owner', {});
  assert.equal(noHash.statusCode, 400);
  assert.equal(noHash.json().code, 'review_hash_required');
  const wrongHash = await post(proposalUrl('ep-decide', prompt.id, 'approve'), 'ep-owner', { expectedReviewHash: 'a'.repeat(64) });
  assert.equal(wrongHash.statusCode, 409);
  assert.equal(wrongHash.json().code, 'review_changed');
  assert.equal(snapshot('ep-decide').system_prompt, PROMPT, 'nothing applied by refused attempts');

  const ok = await post(proposalUrl('ep-decide', prompt.id, 'approve'), 'ep-owner', { expectedReviewHash: pv.reviewHash });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().proposal.status, 'approved');
  assert.equal(ok.json().proposal.decidedBy, 'ep-owner');
  assert.equal(snapshot('ep-decide').system_prompt, PROMPT + prompt.proposed_text);
  const [hist] = historyOf('ep-decide');
  assert.equal(hist.id, ok.json().historyId);
  assert.equal(hist.evolution_type, 'prompt_update');
  assert.equal(hist.before_value, PROMPT);

  const twice = await post(proposalUrl('ep-decide', prompt.id, 'approve'), 'ep-owner', { expectedReviewHash: pv.reviewHash });
  assert.equal(twice.statusCode, 409);
  assert.equal(twice.json().code, 'already_decided');
  assert.equal(snapshot('ep-decide').system_prompt, PROMPT + prompt.proposed_text, 'applied once');

  // PERSONALITY.md note: appended to the file on approval only.
  const beforeFile = personalityText('ep-decide') ?? '';
  const nv = await view('ep-decide', note.id);
  const okNote = await post(proposalUrl('ep-decide', note.id, 'approve'), 'ep-owner', { expectedReviewHash: nv.reviewHash });
  assert.equal(okNote.statusCode, 200, okNote.body);
  assert.equal(personalityText('ep-decide'), beforeFile + note.proposed_text);

  // Rollback restores the prompt (owner), once.
  const rb = await post(`/api/evolution/ep-decide/rollback/${hist.id}`, 'ep-owner');
  assert.equal(rb.statusCode, 200, rb.body);
  assert.equal(snapshot('ep-decide').system_prompt, PROMPT);
  const rb2 = await post(`/api/evolution/ep-decide/rollback/${hist.id}`, 'ep-owner');
  assert.equal(rb2.statusCode, 409);
  assert.equal(rb2.json().code, 'already_rolled_back');

  // Reject and cancel: nothing changes.
  const rest = pendingOf('ep-decide');
  assert.ok(rest.length >= 2, `pending left: ${rest.length}`);
  {
    const before = snapshot('ep-decide');
    const r = await post(proposalUrl('ep-decide', rest[0].id, 'reject'), 'ep-owner', { expectedReviewHash: (await view('ep-decide', rest[0].id)).reviewHash, note: 'no' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().proposal.status, 'rejected');
    const c = await post(proposalUrl('ep-decide', rest[1].id, 'cancel'), 'ep-owner', { expectedReviewHash: (await view('ep-decide', rest[1].id)).reviewHash });
    assert.equal(c.statusCode, 200, c.body);
    assert.equal(c.json().proposal.status, 'cancelled');
    assert.deepEqual(snapshot('ep-decide'), before);
  }
});

test('a changed base gives 409 stale (prompt and PERSONALITY.md); rollback after a later change is refused', { skip: P4_SKIP }, async () => {
  await quietly(() => evolveAgent('ep-stale'));
  const [prompt] = pendingOf('ep-stale', 'prompt_append');
  const [note] = pendingOf('ep-stale', 'personality_text');
  const pv = await view('ep-stale', prompt.id);
  const nv = await view('ep-stale', note.id);

  db.prepare('UPDATE agents_config SET system_prompt = ? WHERE id = ?').run('Edited by the owner.', 'ep-stale');
  const stale = await post(proposalUrl('ep-stale', prompt.id, 'approve'), 'ep-owner', { expectedReviewHash: pv.reviewHash });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().code, 'stale');
  assert.equal(db.prepare('SELECT status FROM evolution_proposals WHERE id = ?').get(prompt.id).status, 'stale');
  assert.equal(snapshot('ep-stale').system_prompt, 'Edited by the owner.');

  mkdirSync(getAgentDir('ep-stale'), { recursive: true });
  writeFileSync(personalityFile('ep-stale'), '# Edited by hand\n');
  const staleNote = await post(proposalUrl('ep-stale', note.id, 'approve'), 'ep-owner', { expectedReviewHash: nv.reviewHash });
  assert.equal(staleNote.statusCode, 409);
  assert.equal(staleNote.json().code, 'stale');
  assert.equal(personalityText('ep-stale'), '# Edited by hand\n');

  // Approve a fresh proposal, then edit the prompt: rollback must not drop the edit.
  const fresh = await EP.createEvolutionProposal('ep-stale', { kind: 'prompt_append', title: 't', proposedText: '\n\nextra', reason: 'r' });
  assert.equal(fresh.status, 'proposed');
  const applied = await EP.approveEvolutionProposal('ep-stale', fresh.proposal.id, 'ep-owner', fresh.proposal.reviewHash);
  db.prepare('UPDATE agents_config SET system_prompt = ? WHERE id = ?').run('Edited again.', 'ep-stale');
  const rb = await post(`/api/evolution/ep-stale/rollback/${applied.historyId}`, 'ep-owner');
  assert.equal(rb.statusCode, 409);
  assert.equal(rb.json().code, 'stale');
  assert.equal(snapshot('ep-stale').system_prompt, 'Edited again.');
});

test('capabilities are never changed by any Evolution path', async () => {
  const agents = ['ep-cycle', 'ep-route', 'ep-sched', 'ep-decide', 'ep-stale', 'ep-all'];
  const caps = () => agents.map((id) => db.prepare('SELECT capabilities FROM agents_config WHERE id = ?').get(id).capabilities);
  assert.deepEqual(caps(), agents.map(() => CAPS), 'after every path in the tests above');

  // An old capability history row (written before S0-Q.23) cannot be rolled back by Evolution.
  db.prepare(`INSERT INTO agent_evolution_history (id, agent_id, evolution_type, change_description, before_value, after_value, trigger_reason, status)
              VALUES ('old-cap', 'ep-cycle', 'capability_added', 'Enabled capability: executeCommands', ?, ?, 'old', 'active')`)
    .run(JSON.stringify({ executeCommands: true }), CAPS);
  const rb = await post('/api/evolution/ep-cycle/rollback/old-cap', 'ep-owner');
  assert.equal(rb.statusCode, 409);
  assert.equal(rb.json().code, 'rollback_unsupported');

  // Approving every remaining pending proposal still never touches capabilities.
  for (const id of agents) {
    for (const p of pendingOf(id)) {
      try { await EP.approveEvolutionProposal(id, p.id, 'ep-owner', (await view(id, p.id)).reviewHash); } catch (err) { assert.ok(err instanceof EP.EvolutionProposalError); }
    }
  }
  await quietly(() => evolveAgent('ep-cycle'));
  assert.deepEqual(caps(), agents.map(() => CAPS));
});

test('proposed text is bounded and stored verbatim as data', async () => {
  await assert.rejects(
    () => EP.createEvolutionProposal('ep-cycle', { kind: 'prompt_append', title: 't', proposedText: 'x'.repeat(EP.MAX_PROPOSED_TEXT_CHARS + 1), reason: 'r' }),
    (err) => err instanceof EP.EvolutionProposalError && err.status === 400 && err.code === 'invalid_input',
  );
  await assert.rejects(() => EP.createEvolutionProposal('ep-cycle', { kind: 'capability', title: 't', proposedText: 'x', reason: 'r' }), EP.EvolutionProposalError);
  const odd = '\n\n${process.exit(1)} <script>alert(1)</script> `rm -rf /`';
  const out = await EP.createEvolutionProposal('ep-cycle', { kind: P4 ? 'personality_text' : 'prompt_append', title: 'odd', proposedText: odd, reason: 'r' });
  if (P4) {
    assert.equal(out.status, 'personality_proposed');
    assert.ok((await store.getPersonalityProposal('ep-cycle', out.proposalId)).proposedText.endsWith(odd), 'stored verbatim after the current text');
  } else {
    assert.equal(out.status, 'proposed');
    assert.equal(out.proposal.proposedText, odd);
  }
  assert.equal((await EP.createEvolutionProposal('nope', { kind: P4 ? 'personality_text' : 'prompt_append', title: 't', proposedText: 'x', reason: 'r' })).reason, 'agent_not_found');
});
