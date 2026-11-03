// CORE-01: versioned agent personality, owner-only API, behaviour mapping.
// Run: node --import tsx --test test/personality.test.mjs
// Throwaway DB + cwd, random test-only secrets, model call stubbed (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-personality-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.AGENT_EXEC_TOOLS;
delete process.env.OLLAMA_URL;

// ---- model stub: records what chat sends to the (local) model --------------
const modelCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (!/^http:\/\/(127\.0\.0\.1|localhost):11434\/api\/chat$/.test(target)) {
    throw new Error(`unexpected network call in test: ${target}`);
  }
  modelCalls.push(JSON.parse(init.body));
  return new Response(JSON.stringify({ message: { role: 'assistant', content: 'stub reply' } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};

const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('pe-owner', 'owner');
addUser('pe-admin', 'admin');
addUser('pe-user', 'user');
db.prepare(`INSERT INTO agents_config (id, name, system_prompt, model, provider, temperature, max_tokens) VALUES ('pe-agent', 'Pe Agent', 'Hand-written prompt.', 'stub-model', 'ollama', 0.7, 4096)`).run();
db.prepare(`INSERT INTO agents_config (id, name) VALUES ('pe-other', 'Pe Other')`).run();

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { agentPersonalityRoutes } = await import(join(backendDir, 'src/api/routes/agent-personality.ts'));
const { chatRoutes } = await import(join(backendDir, 'src/api/routes/chat.ts'));
const P = await import(join(backendDir, 'src/services/personality.ts'));
const store = await import(join(backendDir, 'src/services/personality-store.ts'));
const { writePersonality } = await import(join(backendDir, 'src/services/agent-files.ts'));
const { storeP4Enabled } = await import(join(backendDir, 'src/services/store-p4.ts'));
// STORE-MAP-01 P4: with the switch on, the first save also imports the hand-written PERSONALITY.md text once (one 'import' version).
const IMPORTED = storeP4Enabled() ? 1 : 0;
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const app = Fastify();
registerAuthGate(app);
await app.register(agentPersonalityRoutes);
await app.register(chatRoutes);
await app.ready();

console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const base = (id) => `/api/agents/${id}/personality`;
const ROUTES = [
  ['GET', 'current'], ['GET', 'versions'], ['POST', 'versions'], ['POST', 'lock'], ['POST', 'unlock'], ['POST', 'rollback'],
];
const save = (id, payload, who = 'pe-owner') => app.inject({ method: 'POST', url: `${base(id)}/versions`, headers: auth(who), payload });
const versionsOf = (id) => db.prepare('SELECT version FROM agent_personality_versions WHERE agent_id = ? ORDER BY version').all(id).map((r) => r.version);
const quietly = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };

test('only the owner may read or change a personality (gate + handler)', async () => {
  for (const [method, path] of ROUTES) {
    const url = `${base('main-agent')}/${path}`;
    assert.equal((await app.inject({ method, url, payload: method === 'POST' ? {} : undefined })).statusCode, 401, `${method} ${path} anon`);
    for (const who of ['pe-admin', 'pe-user']) {
      const res = await app.inject({ method, url, headers: auth(who), payload: method === 'POST' ? { traits: { doubt: 1 }, version: 1 } : undefined });
      assert.equal(res.statusCode, 403, `${method} ${path} as ${who}`);
    }
  }
  assert.deepEqual(versionsOf('main-agent'), [1]);
});

test('main agent v1 is seeded in the database', async () => {
  const res = await app.inject({ method: 'GET', url: `${base('main-agent')}/current`, headers: auth('pe-owner') });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.version, 1);
  assert.equal(body.source, 'seed');
  assert.equal(body.dialect, 'ar-IQ');
  assert.deepEqual(body.traits, { ...P.MAIN_AGENT_V1.traits });
  assert.equal(body.locked, false);
  assert.deepEqual(body.traitNames, [...P.TRAIT_NAMES]);
  assert.ok(body.presets.some((p) => p.id === 'careful-auditor'));
  assert.equal(body.behavior.dialect, 'ar-IQ');
  // An agent without a stored version reads as defaults (version 0).
  const other = (await app.inject({ method: 'GET', url: `${base('pe-other')}/current`, headers: auth('pe-owner') })).json();
  assert.equal(other.version, 0);
  assert.equal(other.source, 'default');
  assert.equal((await app.inject({ method: 'GET', url: `${base('ghost')}/current`, headers: auth('pe-owner') })).statusCode, 404);
});

test('invalid input is refused and stores nothing', async () => {
  const before = versionsOf('pe-agent');
  for (const payload of [
    {}, { note: 'only a note' }, { traits: { doubt: 101 } }, { traits: { doubt: -1 } }, { traits: { doubt: 50.5 } },
    { traits: { doubt: '50' } }, { traits: { bravery: 50 } }, { traits: [1, 2] }, { traits: 'high' },
    { preset: 'evil-genius' }, { dialect: 'klingon' }, { dialect: 'ar-iq' }, { lockedTraits: ['doubt', 'nope'] },
    { traits: { doubt: 10 }, permissions: ['exec'] }, { traits: { doubt: 10 }, grants: ['write'] }, { note: 'x'.repeat(501), traits: { doubt: 1 } },
  ]) {
    const res = await save('pe-agent', payload);
    assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 80));
  }
  assert.equal((await save('ghost', { traits: { doubt: 1 } })).statusCode, 404);
  assert.deepEqual(versionsOf('pe-agent'), before);
});

test('saved, reloaded and versioned; PERSONALITY.md keeps a readable copy', async () => {
  await writePersonality('pe-agent', '# Pe Agent\n\nHand-written notes stay.\n');
  const r1 = await save('pe-agent', { preset: 'careful-auditor', dialect: 'de', note: 'start' });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().version, 1);
  assert.deepEqual(r1.json().traits, P.PRESETS['careful-auditor'].traits);
  const r2 = await save('pe-agent', { traits: { verbosity: 10, warmth: 90 }, lockedTraits: ['doubt'] });
  assert.equal(r2.statusCode, 200, r2.body);
  const v2 = r2.json();
  assert.equal(v2.version, 2 + IMPORTED);
  assert.equal(v2.basedOnVersion, 1 + IMPORTED);
  assert.equal(v2.preset, 'careful-auditor');
  assert.equal(v2.dialect, 'de'); // kept from v1
  assert.equal(v2.traits.verbosity, 10);
  assert.equal(v2.traits.doubt, P.PRESETS['careful-auditor'].traits.doubt);
  assert.equal(v2.createdBy, 'pe-owner');

  // Reload (fresh read from the database).
  const cur = (await app.inject({ method: 'GET', url: `${base('pe-agent')}/current`, headers: auth('pe-owner') })).json();
  assert.equal(cur.version, 2 + IMPORTED);
  assert.deepEqual(cur.traits, v2.traits);
  assert.deepEqual(cur.lockedTraits, ['doubt']);
  const list = (await app.inject({ method: 'GET', url: `${base('pe-agent')}/versions`, headers: auth('pe-owner') })).json();
  assert.deepEqual(list.versions.map((v) => v.version), IMPORTED ? [3, 2, 1] : [2, 1]);
  assert.equal(list.versions.at(-1).note, 'start');
  if (IMPORTED) assert.equal(list.versions[1].source, 'import');

  const file = readFileSync(join(dir, '.data', 'agents', 'pe-agent', 'PERSONALITY.md'), 'utf-8');
  assert.match(file, /Hand-written notes stay\./);
  assert.match(file, new RegExp(`Personality settings \\(version ${2 + IMPORTED}\\)`));
  assert.match(file, /\| verbosity \| 10 \|/);
  assert.match(file, /\| doubt \| \d+ \(locked\) \|/);
  assert.equal(file.match(/personality-settings:begin/g).length, 1, 'block replaced, not duplicated');

  const audit = db.prepare(`SELECT * FROM audit_logs WHERE action = 'agent_personality.save' AND success = 1 ORDER BY id`).all();
  assert.ok(audit.length >= 2);
  assert.equal(audit.at(-1).user_id, 'pe-owner');
});

test('lock blocks saves and rollbacks; unlock + rollback restores an old version as a new one', async () => {
  const lock = await app.inject({ method: 'POST', url: `${base('pe-agent')}/lock`, headers: auth('pe-owner') });
  assert.equal(lock.statusCode, 200, lock.body);
  assert.equal(lock.json().locked, true);
  assert.equal(lock.json().source, 'lock');
  const locked = lock.json().version;
  assert.equal((await save('pe-agent', { traits: { doubt: 1 } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: `${base('pe-agent')}/rollback`, headers: auth('pe-owner'), payload: { version: 1 } })).statusCode, 409);
  // CORE-01c: drift is proposal-only; a locked personality refuses even the proposal.
  assert.equal(store.applyPersonalityDrift, undefined, 'drift has no direct entry point');
  await assert.rejects(() => store.createPersonalityProposal('pe-agent', { traits: { doubt: 0 }, reason: 'r' }, 'evolution', 'evolution'),
    (e) => e instanceof store.PersonalityProposalError && e.code === 'personality_locked');
  assert.equal((await store.getCurrentPersonality('pe-agent')).version, locked);

  const unlock = await app.inject({ method: 'POST', url: `${base('pe-agent')}/unlock`, headers: auth('pe-owner') });
  assert.equal(unlock.json().locked, false);
  for (const version of [0, -1, 1.5, '1', 999]) {
    const bad = await app.inject({ method: 'POST', url: `${base('pe-agent')}/rollback`, headers: auth('pe-owner'), payload: { version } });
    assert.ok([400, 404].includes(bad.statusCode), `rollback ${version}`);
  }
  const rb = await app.inject({ method: 'POST', url: `${base('pe-agent')}/rollback`, headers: auth('pe-owner'), payload: { version: 1 } });
  assert.equal(rb.statusCode, 200, rb.body);
  assert.equal(rb.json().source, 'rollback');
  assert.equal(rb.json().basedOnVersion, 1);
  assert.equal(rb.json().version, locked + 2);
  assert.deepEqual(rb.json().traits, P.PRESETS['careful-auditor'].traits);
  // History is never rewritten.
  assert.deepEqual(versionsOf('pe-agent'), IMPORTED ? [1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5]);
});

test('slow drift is bounded per step and never moves locked traits (via an approved proposal)', async () => {
  await store.savePersonalityVersion('pe-other', { traits: { ...P.DEFAULT_TRAITS }, lockedTraits: ['caution'] }, 'pe-owner');
  const p = await store.createPersonalityProposal('pe-other', { traits: { doubt: 100, caution: 0, warmth: 48 }, reason: 'test' }, 'evolution', 'evolution');
  const { version: d } = await store.approvePersonalityProposal('pe-other', p.id, 'pe-owner', p.reviewHash);
  assert.equal(d.source, 'evolution');
  assert.equal(d.traits.doubt, 55);   // +5 max
  assert.equal(d.traits.caution, 50); // locked
  assert.equal(d.traits.warmth, 48);  // within the step
  await assert.rejects(() => store.createPersonalityProposal('pe-other', { traits: { doubt: 500 }, reason: 'x' }, 'evolution', 'evolution'), P.PersonalityInputError);
});

test('traitsToBehavior is pure, deterministic and monotonic', () => {
  const t = (over) => ({ ...P.DEFAULT_TRAITS, ...over });
  assert.deepEqual(P.traitsToBehavior(t({}), 'en'), P.traitsToBehavior(t({}), 'en'));
  const lo = P.traitsToBehavior(t({ creativity: 0, verbosity: 0, doubt: 0, thoroughness: 0, persistence: 0 }), 'en');
  const hi = P.traitsToBehavior(t({ creativity: 100, verbosity: 100, doubt: 100, thoroughness: 100, persistence: 100 }), 'en');
  assert.equal(lo.temperature, 0.1);
  assert.equal(hi.temperature, 1);
  assert.equal(lo.maxTokens, 512);
  assert.equal(hi.maxTokens, 4096);
  assert.equal(lo.responseLength, 'brief');
  assert.equal(hi.responseLength, 'detailed');
  assert.ok(hi.verificationChecks > lo.verificationChecks);
  assert.ok(hi.selfReviewPasses > lo.selfReviewPasses);
  assert.ok(hi.retryBudget > lo.retryBudget);
  assert.equal(P.traitsToBehavior(t({ caution: 90, independence: 10 }), 'en').confirmBefore, 'ambiguous');
  assert.equal(P.traitsToBehavior(t({ caution: 10, independence: 90 }), 'en').confirmBefore, 'irreversible');
  assert.equal(P.traitsToBehavior(t({}), 'en').confirmBefore, 'significant');
  assert.match(P.traitsToBehavior(t({}), 'ar-IQ').promptBlock, /Iraqi dialect/);
  assert.match(P.traitsToBehavior(t({}), 'de').promptBlock, /German/);
  assert.throws(() => P.traitsToBehavior({ doubt: 50 }, 'en'), P.PersonalityInputError);
  // Main agent v1 mapping (recorded in BACKLOG).
  const v1 = P.traitsToBehavior(P.MAIN_AGENT_V1.traits, P.MAIN_AGENT_V1.dialect);
  assert.deepEqual(
    { temperature: v1.temperature, maxTokens: v1.maxTokens, responseLength: v1.responseLength, verificationChecks: v1.verificationChecks,
      selfReviewPasses: v1.selfReviewPasses, confirmBefore: v1.confirmBefore, retryBudget: v1.retryBudget, exploration: v1.exploration, tone: v1.tone },
    { temperature: 0.51, maxTokens: 1792, responseLength: 'balanced', verificationChecks: 3, selfReviewPasses: 2,
      confirmBefore: 'significant', retryBudget: 3, exploration: 'adjacent', tone: 'warm' });
});

test('traits change the parameters sent to the model, never the tools', async () => {
  const grantRows = () => db.prepare('SELECT agent_id, tool_name, scopes FROM agent_tool_grants ORDER BY agent_id, tool_name').all();
  const chat = () => quietly(() => app.inject({
    method: 'POST', url: '/api/chat', headers: auth('pe-owner'),
    payload: { agentId: 'pe-agent', stream: false, messages: [{ role: 'user', content: 'hello' }] },
  }));

  assert.equal((await save('pe-agent', { traits: { creativity: 0, verbosity: 0, caution: 100, independence: 0, doubt: 100 }, dialect: 'ar-IQ' })).statusCode, 200);
  const a = await chat();
  assert.equal(a.statusCode, 200, a.body);
  const callA = modelCalls.at(-1);
  // Default grants are created on the agent's first use; snapshot them now.
  const grantsBefore = grantRows();
  assert.ok(grantsBefore.length > 0);

  assert.equal((await save('pe-agent', { traits: { creativity: 100, verbosity: 100, caution: 0, independence: 100, doubt: 0 }, dialect: 'en' })).statusCode, 200);
  const b = await chat();
  assert.equal(b.statusCode, 200, b.body);
  const callB = modelCalls.at(-1);

  assert.equal(callA.options.temperature, 0.1);
  assert.equal(callA.options.num_predict, 512);
  assert.equal(callB.options.temperature, 1);
  assert.equal(callB.options.num_predict, 4096);
  const sysA = callA.messages[0].content;
  const sysB = callB.messages[0].content;
  assert.match(sysA, /Hand-written notes stay\./);
  assert.match(sysA, /Iraqi dialect/);
  assert.match(sysA, /keep answers short/);
  assert.match(sysA, /at least 5 independent sources/);
  assert.match(sysA, /ambiguous .* stop and ask the owner/);
  assert.match(sysB, /answer in English/);
  assert.match(sysB, /detailed answers/);
  assert.match(sysB, /work independently/);
  assert.match(sysA, /never give you extra tools or permissions/);
  // The readable export block is not sent; the database values are.
  assert.doesNotMatch(sysA, /personality-settings:begin/);
  assert.doesNotMatch(sysA, /\| doubt \|/);

  // Same tools offered whatever the personality; grants untouched.
  const names = (call) => (call.tools || []).map((t) => t.function?.name ?? t.name).sort();
  assert.deepEqual(names(callA), names(callB));
  assert.deepEqual(grantRows(), grantsBefore);

  // An explicit request value still wins over the personality.
  await quietly(() => app.inject({
    method: 'POST', url: '/api/chat', headers: auth('pe-owner'),
    payload: { agentId: 'pe-agent', stream: false, temperature: 0.3, maxTokens: 700, messages: [{ role: 'user', content: 'hi' }] },
  }));
  assert.equal(modelCalls.at(-1).options.temperature, 0.3);
  assert.equal(modelCalls.at(-1).options.num_predict, 700);
});

test('personality module has no permission surface', () => {
  const src = readFileSync(join(backendDir, 'src/services/personality-store.ts'), 'utf-8')
    + readFileSync(join(backendDir, 'src/services/personality.ts'), 'utf-8');
  assert.doesNotMatch(src, /agent_tool_grants|setAgentGrants|tool_approvals|approveToolCall/);
});
