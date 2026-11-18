// B1-core: repository scope matrix. Every repository method x every actor
// kind (owner, admin, user, guest, other user, agent run with drawers,
// channel/outsider agent run, channel service turn, no actor) is allowed or
// denied by the central rules in src/repositories/scope.ts.
//
// "ok" = the scope check let the call through (it resolved, or failed later
// for a non-scope reason such as invalid input or a run in the wrong state).
// A number = it was refused with that ScopeError status (401/403/404).
//
// Run: node --import tsx --test test/repository-scope.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network (fetch refused).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-repo-scope-'));
mkdirSync(join(dir, '.data', 'audit'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
delete process.env.OUTSIDER_AGENT_MEMORY;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };

const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error };
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
await getMemoryStorage().initialize();

const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`)
  .run(id, `${id}@example.test`, id, role);
addUser('rs-owner', 'owner');
addUser('rs-admin', 'admin');
addUser('rs-user', 'user');
addUser('rs-other', 'user');
addUser('rs-guest', 'guest');
db.prepare(`INSERT INTO agents_config (id, name) VALUES ('rs-agent', 'Rs Agent')`).run();
db.prepare(`INSERT INTO agents_config (id, name) VALUES ('rs-agent-2', 'Rs Agent Two')`).run();

const { repositories, withTransaction } = await import(join(backendDir, 'src/repositories/index.ts'));
const { userActor, serviceActor, actorFromToolContext, SYSTEM_ACTOR } = await import(join(backendDir, 'src/repositories/actor.ts'));
const { ScopeError } = await import(join(backendDir, 'src/repositories/scope.ts'));
const { createChannelToolPolicy } = await import(join(backendDir, 'src/tools/channel-policy.ts'));
const { CredentialType } = await import(join(backendDir, 'src/credentials/types.ts'));

console.log = quiet.log;
console.info = quiet.info;
console.warn = quiet.warn;

test.after(() => {
  globalThis.fetch = realFetch;
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

// --- actors -----------------------------------------------------------------

const DRAWERS = [{ kind: 'owner' }, { kind: 'project', key: 'alpha' }];
const ACTORS = {
  owner: userActor({ id: 'rs-owner', role: 'owner' }),
  admin: userActor({ id: 'rs-admin', role: 'admin' }),
  user: userActor({ id: 'rs-user', role: 'user' }),
  guest: userActor({ id: 'rs-guest', role: 'guest' }),
  other: userActor({ id: 'rs-other', role: 'user' }),
  agent: actorFromToolContext({ workspaceDir: dir, userId: 'rs-user', agentId: 'rs-agent', memoryDrawers: DRAWERS }),
  outsider: actorFromToolContext({ workspaceDir: dir, userId: 'rs-user', agentId: 'rs-agent', toolPolicy: createChannelToolPolicy({ channel: 'telegram' }) }),
  service: serviceActor({ channel: 'telegram', userId: 'rs-user' }),
  none: null,
};
const KINDS = Object.keys(ACTORS);

/** 'ok' when the scope check passed, else the ScopeError status. */
async function outcome(fn) {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    if (err instanceof ScopeError) return err.status;
    return 'ok';
  }
}

const silent = async (fn) => {
  const s = { ...console };
  console.log = () => {}; console.info = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, s); }
};

let checks = 0;
/** One matrix row: expected outcome per actor kind (same order as KINDS). */
async function row(name, run, expected) {
  assert.equal(expected.length, KINDS.length, `${name}: one expectation per actor`);
  const got = [];
  for (const kind of KINDS) got.push(await silent(() => outcome(() => run(ACTORS[kind], kind))));
  checks += KINDS.length;
  assert.deepEqual(
    Object.fromEntries(KINDS.map((k, i) => [k, got[i]])),
    Object.fromEntries(KINDS.map((k, i) => [k, expected[i]])),
    `${name}: allowed/denied per actor`,
  );
}

//                     owner  admin  user   guest  other  agent  outsdr service none
const OWNER_ONLY    = ['ok',  403,   403,   403,   403,   403,   403,   403,    401];
const ADMIN_UP      = ['ok',  'ok',  403,   403,   403,   403,   403,   403,    401];
const MEMBERS       = ['ok',  'ok',  'ok',  403,   'ok',  403,   403,   403,    401];
const ANY_ACTOR     = ['ok',  'ok',  'ok',  'ok',  'ok',  'ok',  'ok',  'ok',   401];

// --- seed data ----------------------------------------------------------------

const insertRun = (userId, status = 'completed') => {
  const id = randomUUID();
  db.prepare(`INSERT INTO task_runs (id, task_id, agent_id, user_id, status, max_steps, max_duration_ms) VALUES (?, ?, 'rs-agent', ?, ?, 10, 60000)`)
    .run(id, `task-${id}`, userId, status);
  return id;
};
const RUN_USER = insertRun('rs-user');
const RUN_OTHER = insertRun('rs-other');
const RUN_OWNER = insertRun('rs-owner');

const C = {};
for (const [k, uid, role] of [['admin', 'rs-admin', 'admin'], ['owner', 'rs-owner', 'owner']]) {
  C[k] = await silent(() => repositories.credentials.create(userActor({ id: uid, role }), { name: `cred-${k}`, type: CredentialType.API_KEY, value: `test-${randomBytes(6).toString('hex')}` }));
}
C.user = (await silent(() => repositories.credentials.saveOwnByName(ACTORS.user, { name: 'cred-user', type: CredentialType.API_KEY, value: 'test-user-value' }))).credential;

const mem = (actor, drawer, content) => silent(() => repositories.memory.create(actor, {
  id: randomUUID(), type: 'fact', content, importance: 5, memoryLayer: 'working', importanceScore: 0.5,
  consolidationStatus: 'pending', expiryTimestamp: null, status: 'active', metadata: {}, createdAt: new Date(),
  lastAccessedAt: Date.now(), accessCount: 0, drawer,
}, 'test'));
const M_USER = await mem(ACTORS.user, { kind: 'owner' }, 'user fact in owner drawer');
const M_USER_BETA = await mem(ACTORS.user, { kind: 'project', key: 'beta' }, 'user fact in project beta');
const M_OTHER = await mem(ACTORS.other, { kind: 'owner' }, 'other user fact');

const newMemory = () => ({
  id: randomUUID(), type: 'fact', content: `new ${randomUUID()}`, importance: 5, memoryLayer: 'working', importanceScore: 0.5,
  consolidationStatus: 'pending', expiryTimestamp: null, status: 'active', metadata: {}, createdAt: new Date(),
  lastAccessedAt: Date.now(), accessCount: 0, drawer: { kind: 'owner' },
});

// --- actor construction -------------------------------------------------------

test('actors are built from trusted context only', () => {
  assert.equal(ACTORS.agent.kind, 'agent');
  assert.equal(ACTORS.agent.userId, 'rs-user');
  assert.equal(ACTORS.agent.role, 'user');
  assert.deepEqual(ACTORS.agent.drawers, DRAWERS);
  assert.equal(ACTORS.outsider.channel, 'telegram');
  assert.deepEqual(ACTORS.outsider.drawers, [], 'an outsider turn opens no drawers without OUTSIDER_AGENT_MEMORY');
  assert.ok(Object.isFrozen(ACTORS.owner) && Object.isFrozen(ACTORS.agent), 'actors cannot be changed after creation');
  assert.equal(actorFromToolContext({ workspaceDir: dir }).userId, undefined, 'no run user -> no user (fail closed)');
  assert.equal(actorFromToolContext({ workspaceDir: dir, userId: 'missing-user' }).role, 'none', 'unknown user -> no role');
  assert.equal(userActor({ id: 'x', role: 'superuser' }).role, 'none', 'unknown role -> none');
});

// --- task runs ----------------------------------------------------------------

test('task runs: scope matrix', async () => {
  const T = repositories.taskRuns;
  //                                                         owner admin user guest other agent outsdr service none
  await row('taskRuns.list', (a) => T.list(a),              ['ok', 'ok', 'ok', 403, 'ok', 'ok', 403, 403, 401]);
  await row('taskRuns.get(own run of user)', (a) => T.get(a, RUN_USER),
                                                            ['ok', 404, 'ok', 403, 404, 'ok', 403, 403, 401]);
  await row('taskRuns.detail(user run)', (a) => T.detail(a, RUN_USER),
                                                            ['ok', 404, 'ok', 403, 404, 'ok', 403, 403, 401]);
  await row('taskRuns.steps(user run)', (a) => T.steps(a, RUN_USER),
                                                            ['ok', 404, 'ok', 403, 404, 'ok', 403, 403, 401]);
  // completed run: a permitted cancel fails with a state error (409), not a scope error
  await row('taskRuns.cancel(user run)', (a) => T.cancel(a, RUN_USER),
                                                            ['ok', 404, 'ok', 403, 404, 403, 403, 403, 401]);
  await row('taskRuns.resolveStep', (a) => T.resolveStep(a, RUN_USER, 0, 'done'), OWNER_ONLY);
  await row('taskRuns.review', (a) => T.review(a, RUN_USER, 'accept', 'owner', null), OWNER_ONLY);
  await row('taskRuns.get(other user run)', (a) => T.get(a, RUN_OTHER),
                                                            ['ok', 404, 404, 403, 'ok', 404, 403, 403, 401]);
});

test('task runs: list contents follow the scope; agent runs are never owner-wide', async () => {
  const T = repositories.taskRuns;
  const ids = async (a) => (await T.list(a)).map((r) => r.id).sort();
  assert.deepEqual(await ids(ACTORS.owner), [RUN_USER, RUN_OTHER, RUN_OWNER].sort());
  assert.deepEqual(await ids(ACTORS.user), [RUN_USER]);
  assert.deepEqual(await ids(ACTORS.agent), [RUN_USER]);
  const ownerAgent = actorFromToolContext({ workspaceDir: dir, userId: 'rs-owner', agentId: 'rs-agent', memoryDrawers: DRAWERS });
  assert.deepEqual(await ids(ownerAgent), [RUN_OWNER], "an agent run of the owner sees the owner's runs only");
  await assert.rejects(() => T.get(ownerAgent, RUN_USER), (e) => e instanceof ScopeError && e.status === 404);
  assert.deepEqual(await ids(SYSTEM_ACTOR), [RUN_USER, RUN_OTHER, RUN_OWNER].sort());
  checks += 6;
});

// --- agents -------------------------------------------------------------------

test('agents (grants, personality): scope matrix', async () => {
  const A = repositories.agents;
  const available = [{ name: 'memory_search' }];
  await row('agents.grantView', (a) => A.grantView(a, 'rs-agent', available), OWNER_ONLY);
  await row('agents.setGrants', (a) => A.setGrants(a, 'rs-agent', { grants: 'not-an-array' }, available), OWNER_ONLY);
  //                                                                   owner admin user guest other agent outsdr service none
  await row('agents.currentPersonality(own agent)', (a) => A.currentPersonality(a, 'rs-agent'),
                                                                      ['ok', 403, 403, 403, 403, 'ok', 'ok', 403, 401]);
  await row('agents.currentPersonality(another agent)', (a) => A.currentPersonality(a, 'rs-agent-2'), OWNER_ONLY);
  await row('agents.personalityVersions', (a) => A.personalityVersions(a, 'rs-agent'), OWNER_ONLY);
  await row('agents.savePersonality', (a) => A.savePersonality(a, 'rs-agent', { traits: 'invalid' }), OWNER_ONLY);
  await row('agents.setPersonalityLocked', (a) => A.setPersonalityLocked(a, 'missing-agent', true), OWNER_ONLY);
  await row('agents.rollbackPersonality', (a) => A.rollbackPersonality(a, 'rs-agent', 999), OWNER_ONLY);
  // CORE-01c: drift proposals (invalid input / missing proposal: the scope check passed)
  await row('agents.personalityProposals', (a) => A.personalityProposals(a, 'rs-agent'), OWNER_ONLY);
  await row('agents.personalityProposal', (a) => A.personalityProposal(a, 'rs-agent', 'missing'), OWNER_ONLY);
  await row('agents.createPersonalityProposal', (a) => A.createPersonalityProposal(a, 'rs-agent', { reason: '' }), ADMIN_UP);
  await row('agents.approvePersonalityProposal', (a) => A.approvePersonalityProposal(a, 'rs-agent', 'missing', 'f'.repeat(64)), OWNER_ONLY);
  await row('agents.rejectPersonalityProposal', (a) => A.rejectPersonalityProposal(a, 'rs-agent', 'missing', 'f'.repeat(64)), OWNER_ONLY);
  //                                                                   owner admin user guest other agent outsdr service none
  await row('agents.proposePersonalityDrift(own agent)', (a) => A.proposePersonalityDrift(a, 'rs-agent', { reason: '' }),
                                                                      [403, 403, 403, 403, 403, 'ok', 403, 403, 401]);
  await row('agents.proposePersonalityDrift(another agent)', (a) => A.proposePersonalityDrift(a, 'rs-agent-2', { reason: '' }),
                                                                      [403, 403, 403, 403, 403, 403, 403, 403, 401]);
  await assert.rejects(() => A.approvePersonalityProposal(SYSTEM_ACTOR, 'rs-agent', 'missing', 'f'.repeat(64)), (e) => e instanceof ScopeError && e.status === 403);
});

test('agents (configs, naming): scope matrix', async () => {
  const A = repositories.agents;
  const SMALL = 'small-local-agent';
  await row('agents.listConfigs', (a) => A.listConfigs(a), MEMBERS);
  await row('agents.getConfig', (a) => A.getConfig(a, 'rs-agent'), MEMBERS);
  await row('agents.suggestName', (a) => A.suggestName(a, {}), ADMIN_UP);
  // invalid name: a permitted call fails with an input error, not a scope error
  await row('agents.createConfig(invalid name)', (a) => A.createConfig(a, { name: { bad: true } }), ADMIN_UP);
  await row('agents.updateConfig(missing)', (a) => A.updateConfig(a, 'missing-agent', {}), ADMIN_UP);
  await row('agents.updateConfig(reserved small agent)', (a) => A.updateConfig(a, SMALL, 'not-an-object'), OWNER_ONLY);
  await row('agents.setPrimary(missing)', (a) => A.setPrimary(a, 'missing-agent'), ADMIN_UP);
  await row('agents.setPrimary(reserved small agent, missing row)', (a) => A.setPrimary(a, SMALL).catch((e) => { if (e instanceof ScopeError) throw e; }), OWNER_ONLY);
  await row('agents.duplicateConfig(missing)', (a) => A.duplicateConfig(a, 'missing-agent'), ADMIN_UP);
  await row('agents.deleteConfig(missing)', (a) => A.deleteConfig(a, 'missing-agent'), ADMIN_UP);
  await assert.rejects(() => A.deleteConfig(ACTORS.admin, SMALL), (e) => e instanceof ScopeError && e.status === 403 && e.code === 'reserved_agent');
  // the reserved id is the small local agent's id (kept as a constant to avoid an import cycle)
  assert.match(readFileSync(join(backendDir, 'src/services/small-agent.ts'), 'utf8'), /export const SMALL_AGENT_ID = 'small-local-agent';/);
  assert.equal((await import(join(backendDir, 'src/repositories/agents-config.ts'))).RESERVED_AGENT_ID, SMALL);
  // the owner creates, renames (name reserved for good) and deletes
  const created = await silent(() => A.createConfig(ACTORS.owner, { name: 'Scope Matrix Agent' }));
  assert.equal(created.name, 'Scope Matrix Agent');
  const renamed = await A.updateConfig(ACTORS.admin, created.id, { name: 'Scope Matrix Renamed', expectedVersion: created.version });
  assert.equal(renamed.name, 'Scope Matrix Renamed');
  await assert.rejects(() => A.updateConfig(ACTORS.admin, created.id, { description: 'x', expectedVersion: created.version }), (e) => e.constructor.name === 'AgentConfigConflictError');
  await silent(() => A.deleteConfig(ACTORS.owner, created.id));
  assert.equal(await A.getConfig(ACTORS.user, created.id), null);
  checks += 8;
});

// --- credentials ----------------------------------------------------------------

test('credentials: scope matrix', async () => {
  const R = repositories.credentials;
  await row('credentials.list', (a) => R.list(a), ADMIN_UP);
  await row('credentials.get(admin credential)', (a) => R.get(a, C.admin.id), ADMIN_UP);
  //                                                                   owner admin user guest other agent outsdr service none
  await row('credentials.get(user credential)', (a) => R.get(a, C.user.id), ['ok', 404, 403, 403, 403, 403, 403, 403, 401]);
  await row('credentials.get(owner credential)', (a) => R.get(a, C.owner.id), ['ok', 404, 403, 403, 403, 403, 403, 403, 401]);
  await row('credentials.maskedValue(admin credential)', (a) => R.maskedValue(a, C.admin.id), ADMIN_UP);
  await row('credentials.test(admin credential)', (a) => R.test(a, C.admin.id), ADMIN_UP);
  await row('credentials.create', (a, k) => R.create(a, { name: `new-${k}-${randomUUID()}`, type: CredentialType.API_KEY, value: 'test-v' }), ADMIN_UP);
  await row('credentials.update(admin credential)', (a) => R.update(a, C.admin.id, { description: 'changed' }), ADMIN_UP);
  await row('credentials.delete(missing)', (a) => R.delete(a, 'missing-credential'), [404, 404, 403, 403, 403, 403, 403, 403, 401]);
  await row('credentials.exportBackup', (a) => R.exportBackup(a), ADMIN_UP);
  await row('credentials.importBackup([])', (a) => R.importBackup(a, []), ADMIN_UP);
  await row('credentials.saveOwnByName', (a, k) => R.saveOwnByName(a, { name: `own-${k}`, type: CredentialType.API_KEY, value: 'test-own' }),
                                                                      ['ok', 'ok', 'ok', 403, 'ok', 'ok', 403, 403, 401]);
});

test('credentials: contents follow the scope (owner sees all, admin own, backups never carry others)', async () => {
  const R = repositories.credentials;
  const ownerIds = (await R.list(ACTORS.owner)).map((c) => c.id);
  assert.ok([C.owner.id, C.admin.id, C.user.id].every((id) => ownerIds.includes(id)));
  const adminRows = await R.list(ACTORS.admin);
  assert.ok(adminRows.every((c) => c.userId === 'rs-admin'));
  const ownerBackup = await R.exportBackup(ACTORS.owner);
  assert.ok(ownerBackup.every((c) => !c.userId || c.userId === 'rs-owner'), "the owner's backup never carries another user's ciphertext");
  // An agent run saves only for its own user.
  const saved = await silent(() => R.saveOwnByName(ACTORS.agent, { name: 'agent-saved', type: CredentialType.API_KEY, value: 'test-agent' }));
  assert.equal(saved.credential.userId, 'rs-user');
  // Import with another user's id never overwrites it.
  const before = (await R.get(ACTORS.owner, C.user.id)).encryptedValue;
  await silent(() => R.importBackup(ACTORS.admin, [{ id: C.user.id, name: 'hijack', type: 'api_key', encryptedValue: 'x', iv: 'x', authTag: 'x', userId: 'rs-user' }]));
  assert.equal((await R.get(ACTORS.owner, C.user.id)).encryptedValue, before);
  // The owner touching another user's credential is audited (ids only).
  await R.get(ACTORS.owner, C.user.id, { ip: '127.0.0.1' });
  const audit = db.prepare(`SELECT * FROM audit_logs WHERE action = 'credentials.get.other_user' ORDER BY id DESC LIMIT 1`).get();
  assert.ok(audit && audit.user_id === 'rs-owner' && audit.resource_id === C.user.id);
  assert.ok(!String(audit.metadata).includes('test-user-value'));
  checks += 7;
});

// --- memory -------------------------------------------------------------------

test('memory: scope matrix', async () => {
  const R = repositories.memory;
  //                                                                   owner admin user guest other agent outsdr service none
  await row('memory.list', (a) => R.list(a),                          ['ok', 'ok', 'ok', 403, 'ok', 'ok', 'ok', 403, 401]);
  await row('memory.drawers', (a) => R.drawers(a),                    ['ok', 'ok', 'ok', 403, 'ok', 'ok', 'ok', 403, 401]);
  await row('memory.get(user memory, open drawer)', (a) => R.get(a, M_USER.id),
                                                                      [404, 404, 'ok', 403, 404, 'ok', 403, 403, 401]);
  await row('memory.assertAccess(user memory)', (a) => R.assertAccess(a, M_USER.id),
                                                                      [404, 404, 'ok', 403, 404, 'ok', 403, 403, 401]);
  await row('memory.get(user memory, closed drawer)', (a) => R.get(a, M_USER_BETA.id),
                                                                      [404, 404, 'ok', 403, 404, 403, 403, 403, 401]);
  await row('memory.get(other user memory)', (a) => R.get(a, M_OTHER.id),
                                                                      [404, 404, 404, 403, 'ok', 404, 404, 403, 401]);
  await row('memory.create(owner drawer)', (a) => R.create(a, newMemory(), 'test'),
                                                                      ['ok', 'ok', 'ok', 403, 'ok', 'ok', 403, 403, 401]);
  await row('memory.create(closed project drawer)', (a) => R.create(a, { ...newMemory(), drawer: { kind: 'project', key: 'beta' } }, 'test'),
                                                                      ['ok', 'ok', 'ok', 403, 'ok', 403, 403, 403, 401]);
  await row('memory.update(user memory)', (a) => R.update(a, M_USER.id, { importance: 6 }, 'test'),
                                                                      [404, 404, 'ok', 403, 404, 'ok', 403, 403, 401]);
  await row('memory.versions(user memory)', (a) => R.versions(a, M_USER.id),
                                                                      [404, 404, 'ok', 403, 404, 'ok', 403, 403, 401]);
  await row('memory.versions(closed drawer)', (a) => R.versions(a, M_USER_BETA.id),
                                                                      [404, 404, 'ok', 403, 404, 403, 403, 403, 401]);
  await row('memory.delete(other user memory)', (a) => R.delete(a, M_OTHER.id, 'test'),
                                                                      [404, 404, 404, 403, 'ok', 404, 404, 403, 401]);
  await row('memory.forget(closed drawer)', (a) => R.forget(a, randomUUID()),
                                                                      ['ok', 'ok', 'ok', 403, 'ok', 'ok', 403, 403, 401]);
  await row('memory.tombstones', (a) => R.tombstones(a), MEMBERS);
  await row('memory.proposals', (a) => R.proposals(a), OWNER_ONLY);
  await row('memory.proposal(missing)', (a) => R.proposal(a, 'missing'), [404, 403, 403, 403, 403, 403, 403, 403, 401]);
  await row('memory.approveProposal(missing)', (a) => R.approveProposal(a, 'missing'), OWNER_ONLY);
  await row('memory.rejectProposal(missing)', (a) => R.rejectProposal(a, 'missing'), OWNER_ONLY);
  await row('memory.drawerHistory', (a) => R.drawerHistory(a, { kind: 'owner' }), OWNER_ONLY);
  await row('memory.drawerFile', (a) => R.drawerFile(a, 'rs-agent', { kind: 'owner' }), OWNER_ONLY);
});

test('memory: an agent run reads only open drawers; forget refuses closed drawers and outsiders', async () => {
  const R = repositories.memory;
  const agentIds = (await R.list(ACTORS.agent)).map((m) => m.id);
  assert.ok(agentIds.includes(M_USER.id) && !agentIds.includes(M_USER_BETA.id) && !agentIds.includes(M_OTHER.id));
  assert.deepEqual(await R.list(ACTORS.outsider), [], 'an outsider turn reads no memory');
  await assert.rejects(() => R.forget(ACTORS.agent, M_USER_BETA.id), (e) => e instanceof ScopeError && e.status === 403);
  await assert.rejects(() => R.forget(ACTORS.outsider, M_USER.id), (e) => e instanceof ScopeError && /someone else/.test(e.message));
  assert.equal(await R.forget(ACTORS.agent, M_OTHER.id), null, "another user's memory is simply not found");
  // the owner account has no owner-wide memory view (S0-Q.11)
  assert.ok((await R.list(ACTORS.owner)).every((m) => m.userId === 'rs-owner'));
  checks += 6;
});

test('memory (recall, learning, layers, owner maintenance, import): scope matrix', async () => {
  const R = repositories.memory;
  //                                                                   owner admin user guest other agent outsdr service none
  const OWN_MEMORY                                                  = ['ok', 'ok', 'ok', 403, 'ok', 'ok', 'ok', 403, 401];
  await row('memory.search', (a) => R.search(a, { query: 'fact' }), OWN_MEMORY);
  await row('memory.relevant', (a) => R.relevant(a, 'fact', 5, [{ kind: 'owner' }]), OWN_MEMORY);
  await row('memory.learn(invalid content)', (a) => R.learn(a, { candidates: [{ content: '' }] }), OWN_MEMORY);
  await row('memory.change(missing)', (a) => R.change(a, { memoryId: 'missing', op: 'delete' }), OWN_MEMORY);
  await row('memory.stats', (a) => R.stats(a), OWN_MEMORY);
  await row('memory.reachable', (a) => R.reachable(a), OWN_MEMORY);
  await row('memory.saveDerived(owner drawer)', (a) => R.saveDerived(a, { ...newMemory(), drawer: { kind: 'owner' } }),
                                                                      ['ok', 'ok', 'ok', 403, 'ok', 'ok', 403, 403, 401]);
  await row('memory.saveDerived(closed drawer)', (a) => R.saveDerived(a, { ...newMemory(), drawer: { kind: 'project', key: 'beta' } }),
                                                                      ['ok', 'ok', 'ok', 403, 'ok', 403, 403, 403, 401]);
  await row('memory.summary', (a) => R.summary(a), MEMBERS);
  await row('memory.consolidateDuplicates', (a) => R.consolidateDuplicates(a), MEMBERS);
  await row('memory.extract', (a) => R.extract(a, 'nothing to learn here'), MEMBERS);
  await row('memory.layerStats', (a) => R.layerStats(a), MEMBERS);
  await row('memory.promote(missing)', (a) => R.promote(a, 'missing', 'factual'), MEMBERS);
  await row('memory.promotionCandidates', (a) => R.promotionCandidates(a), MEMBERS);
  await row('memory.setImportanceScore(user memory)', (a) => R.setImportanceScore(a, M_USER.id, 0.5),
                                                                      [404, 404, 'ok', 403, 404, 403, 403, 403, 401]);
  await row('memory.consolidationLog', (a) => R.consolidationLog(a, 5), OWNER_ONLY);
  // owner maintenance (CORE-05/06/07) and the import pipeline (CLI-02)
  const NOTHING = { kind: 'project', key: 'nothing-here' };
  await row('memory.weeklySummary', (a) => R.weeklySummary(a), OWNER_ONLY);
  await row('memory.runWeeklySummary', (a) => R.runWeeklySummary(a), OWNER_ONLY);
  await row('memory.embeddingStatus', (a) => R.embeddingStatus(a), OWNER_ONLY);
  await row('memory.reembed', (a) => R.reembed(a, 1), OWNER_ONLY);
  await row('memory.forgetAll(empty drawer)', (a) => R.forgetAll(a, NOTHING), OWNER_ONLY);
  await row('memory.retention', (a) => R.retention(a), OWNER_ONLY);
  await row('memory.setRetention(invalid)', (a) => R.setRetention(a, { taskTtlDays: 'x' }), OWNER_ONLY);
  await row('memory.runRetention(dry run)', (a) => R.runRetention(a, true), OWNER_ONLY);
  await row('memory.importSettings', (a) => R.importSettings(a), OWNER_ONLY);
  await row('memory.setImportSettings', (a) => R.setImportSettings(a, {}), OWNER_ONLY);
  await row('memory.importPreview(no files)', (a) => R.importPreview(a, { files: [] }), OWNER_ONLY);
  await row('memory.imports', (a) => R.imports(a), OWNER_ONLY);
  await row('memory.importView(missing)', (a) => R.importView(a, 'missing'), OWNER_ONLY);
  await row('memory.reviseImport(missing)', (a) => R.reviseImport(a, 'missing', {}), OWNER_ONLY);
  await row('memory.commitImport(missing)', (a) => R.commitImport(a, 'missing', {}), OWNER_ONLY);
  await row('memory.cancelImport(missing)', (a) => R.cancelImport(a, 'missing'), OWNER_ONLY);
  await row('memory.runConsolidation', (a) => R.runConsolidation(a), OWNER_ONLY);
});

test('memory recall: agent runs read only open drawers, outsiders nothing, accounts only their own', async () => {
  const R = repositories.memory;
  const ids = (results) => results.map((r) => r.memory.id);
  const agentHits = ids(await silent(() => R.search(ACTORS.agent, { query: 'user fact', limit: 20 })));
  assert.ok(!agentHits.includes(M_USER_BETA.id) && !agentHits.includes(M_OTHER.id), 'closed drawer and other user stay hidden');
  const narrowed = ids(await silent(() => R.search(ACTORS.agent, { query: 'user fact', limit: 20, drawers: [{ kind: 'project', key: 'beta' }] })));
  assert.deepEqual(narrowed, [], 'an asked drawer that is not open is dropped');
  assert.deepEqual(await silent(() => R.search(ACTORS.outsider, { query: 'user fact' })), [], 'an outsider turn reads nothing');
  assert.equal(await R.stats(ACTORS.outsider), null);
  const userHits = ids(await silent(() => R.search(ACTORS.user, { query: 'user fact', limit: 20 })));
  assert.ok(!userHits.includes(M_OTHER.id));
  assert.ok((await R.reachable(ACTORS.agent)).every((m) => m.userId === 'rs-user' && m.drawer && !(m.drawer.kind === 'project' && m.drawer.key === 'beta')));
  const refused = await R.change(ACTORS.agent, { memoryId: M_USER_BETA.id, op: 'delete' });
  assert.equal(refused.status, 'refused');
  const otherRefused = await R.change(ACTORS.agent, { memoryId: M_OTHER.id, op: 'delete' });
  assert.equal(otherRefused.status, 'refused', "another user's memory is not found");
  checks += 8;
});

test('memory (quality, sharing, deduplication; B1.7): scope matrix', async () => {
  const R = repositories.memory;
  const OTHER = await mem(ACTORS.other, { kind: 'owner' }, 'other user fact for sharing');
  //                                                                   owner admin user guest other agent outsdr service none
  const OWN_ROW                                                     = [404, 404, 'ok', 403, 404, 403, 403, 403, 401];
  await row('memory.qualityStats', (a) => R.qualityStats(a), MEMBERS);
  await row('memory.lowQuality', (a) => R.lowQuality(a, 5), MEMBERS);
  await row('memory.analyzeQuality(user memory)', (a) => R.analyzeQuality(a, M_USER.id), OWN_ROW);
  await row('memory.analyzeQuality(missing)', (a) => R.analyzeQuality(a, 'missing'), [404, 404, 404, 403, 404, 403, 403, 403, 401]);
  await row('memory.enrich(user memory)', (a) => R.enrich(a, M_USER.id), OWN_ROW);
  await row('memory.batchEnrich', (a) => R.batchEnrich(a, 1), MEMBERS);
  await row('memory.qualityHistory(user memory)', (a) => R.qualityHistory(a, M_USER.id), OWN_ROW);
  await row('memory.relationships(user memory)', (a) => R.relationships(a, M_USER.id), OWN_ROW);
  await row('memory.enrichmentLog(user memory)', (a) => R.enrichmentLog(a, M_USER.id), OWN_ROW);
  await row('memory.qualityDistribution', (a) => R.qualityDistribution(a), MEMBERS);
  // invalid input: a permitted call fails with an input error (400), checked after the 404
  await row('memory.share(user memory, invalid visibility)', (a) => R.share(a, M_USER.id, { visibility: 'everyone' }), OWN_ROW);
  await row('memory.share(other user memory)', (a) => R.share(a, OTHER.id, { visibility: 'everyone' }),
                                                                      [404, 404, 404, 403, 'ok', 403, 403, 403, 401]);
  await row('memory.markCritical(user memory, invalid)', (a) => R.markCritical(a, M_USER.id, { critical: 'yes' }), OWN_ROW);
  await row('memory.shared', (a) => R.shared(a, { limit: 5 }), MEMBERS);
  await row('memory.sharedByAgent', (a) => R.sharedByAgent(a, 'rs-agent', 5), MEMBERS);
  await row('memory.runDeduplication(invalid threshold)', (a) => R.runDeduplication(a, 2), MEMBERS);
  await row('memory.deduplicationStats', (a) => R.deduplicationStats(a), MEMBERS);
  await row('memory.deduplicationCandidates(invalid threshold)', (a) => R.deduplicationCandidates(a, 0.1), MEMBERS);
  await row('memory.sharingAudit', (a) => R.sharingAudit(a, { limit: 5 }), MEMBERS);
  await row('memory.teamIds', (a) => R.teamIds(a), MEMBERS);
});

test('memory sharing (B1.7): strictly per user; team shares need a team the caller belongs to', async () => {
  const R = repositories.memory;
  const { MemoryShareInputError } = await import(join(backendDir, 'src/repositories/memory-shared.ts'));
  const isInput = (msg) => (e) => e instanceof MemoryShareInputError && msg.test(e.message);
  const team = await repositories.identity.createTeam(ACTORS.other, { name: 'Sharing team' });
  const M_OTHER = await mem(ACTORS.other, { kind: 'owner' }, 'other user fact shared to a team');
  // rs-user is not in rs-other's team: refused, nothing changes
  await assert.rejects(() => R.share(ACTORS.user, M_USER.id, { visibility: 'team', teamId: team.id }), isInput(/team you belong to/));
  await assert.rejects(() => R.share(ACTORS.user, M_USER.id, { visibility: 'team' }), isInput(/team you belong to/));
  await assert.rejects(() => R.share(ACTORS.user, M_USER.id, { visibility: 'public', reason: 'x'.repeat(1001) }), isInput(/Invalid reason/));
  assert.equal(db.prepare('SELECT visibility FROM memories WHERE id = ?').get(M_USER.id).visibility ?? 'private', 'private');
  // the other user shares to their own team; rs-user (not a member) does not see it, the owner neither
  const shared = await R.share(ACTORS.other, M_OTHER.id, { visibility: 'team', teamId: team.id, reason: 'for the team' });
  assert.deepEqual(shared, { memoryId: M_OTHER.id, visibility: 'team', teamId: team.id });
  const ids = async (a) => (await R.shared(a, { limit: 50 })).map((m) => m.id);
  assert.ok((await ids(ACTORS.other)).includes(M_OTHER.id), 'own team share visible');
  assert.ok(!(await ids(ACTORS.user)).includes(M_OTHER.id), 'not visible outside the team');
  assert.ok(!(await ids(ACTORS.owner)).includes(M_OTHER.id), 'no owner-wide view');
  assert.ok(!(await ids(ACTORS.admin)).includes(M_OTHER.id));
  // the audit log shows only own memories' rows
  assert.ok((await R.sharingAudit(ACTORS.other, { limit: 50 })).some((r) => r.memory_id === M_OTHER.id));
  assert.deepEqual(await R.sharingAudit(ACTORS.owner, { memoryId: M_OTHER.id, limit: 50 }), []);
  assert.deepEqual(await R.sharingAudit(ACTORS.user, { memoryId: M_OTHER.id, limit: 50 }), []);
  // after rs-user joins, the team share becomes visible to them
  db.prepare(`INSERT INTO team_members (id, team_id, user_id, role) VALUES (?, ?, 'rs-user', 'user')`).run(randomUUID(), team.id);
  assert.ok((await R.teamIds(ACTORS.user)).includes(team.id));
  assert.ok((await ids(ACTORS.user)).includes(M_OTHER.id), 'visible to a team member');
  // a share by someone else never changes the row
  await assert.rejects(() => R.markCritical(ACTORS.user, M_OTHER.id, { critical: true }), (e) => e instanceof ScopeError && e.status === 404);
  assert.equal(db.prepare('SELECT is_team_critical FROM memories WHERE id = ?').get(M_OTHER.id).is_team_critical ?? 0, 0);
  // back to private (no team id kept)
  assert.deepEqual(await R.share(ACTORS.other, M_OTHER.id, { visibility: 'private' }), { memoryId: M_OTHER.id, visibility: 'private', teamId: null });
  assert.equal(db.prepare('SELECT team_id FROM memories WHERE id = ?').get(M_OTHER.id).team_id, null);
  // quality reads never cross users
  assert.ok((await R.lowQuality(ACTORS.user, 100)).every((m) => m.user_id === undefined || m.user_id === 'rs-user'));
  checks += 19;
});

// --- audit --------------------------------------------------------------------

test('audit: scope matrix', async () => {
  const R = repositories.audit;
  await row('audit.record', (a, k) => R.record(a, { event_type: 'data.read', event_category: 'data_access', action: `scope-test.${k}`, success: true }), ANY_ACTOR);
  await row('audit.status', (a) => R.status(a), ADMIN_UP);
  await row('audit.stats', (a) => R.stats(a), ADMIN_UP);
  await row('audit.query', (a) => R.query(a, { limit: 5 }), ADMIN_UP);
  await row('audit.recent', (a) => R.recent(a, 5), ADMIN_UP);
  await row('audit.get', (a) => R.get(a, 'missing'), ADMIN_UP);
  await row('audit.exportJson', (a) => R.exportJson(a, {}), ADMIN_UP);
  await row('audit.config', (a) => R.config(a), ADMIN_UP);
  await row('audit.updateConfig', (a) => R.updateConfig(a, {}), OWNER_ONLY);
  await row('audit.cleanup', (a) => R.cleanup(a), OWNER_ONLY);
  // record defaults user_id to the actor's user
  const r = db.prepare(`SELECT user_id FROM audit_logs WHERE action = 'scope-test.agent'`).get();
  assert.equal(r.user_id, 'rs-user');
  // B1.6: a config change records the real actor (no longer 'api/admin')
  const { getAuditLogger } = await import(join(backendDir, 'src/audit/index.ts'));
  const logger = getAuditLogger();
  const original = logger.logConfigChange;
  let seen;
  logger.logConfigChange = function (actor, ...rest) { seen = actor; return original.call(this, actor, ...rest); };
  try {
    await R.updateConfig(ACTORS.owner, {}, { ip: '127.0.0.1' });
  } finally {
    logger.logConfigChange = original;
  }
  assert.deepEqual(seen, { type: 'user', id: 'rs-owner', ip: '127.0.0.1' });
  checks += 2;
});

test('audit (B1.7): encryption key rotation records the real actor, never api/admin', async () => {
  const { getAuditLogger } = await import(join(backendDir, 'src/audit/index.ts'));
  const { getKeyManager } = await import(join(backendDir, 'src/encryption/index.ts'));
  const { encryptionRoutes } = await import(join(backendDir, 'src/api/routes/encryption.ts'));
  const { requestAuditActor } = await import(join(backendDir, 'src/repositories/audit.ts'));
  const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
  const { default: Fastify } = await import('fastify');
  const km = getKeyManager();
  const originalRotate = km.rotateKeys;
  km.rotateKeys = async () => ({ id: 'test-key', algorithm: 'aes-256-gcm', createdAt: new Date(), expiresAt: null });
  const logger = getAuditLogger();
  const original = logger.logConfigChange;
  const seen = [];
  logger.logConfigChange = function (actor, ...rest) { seen.push(actor); return original.call(this, actor, ...rest); };
  const app = Fastify();
  await app.register(encryptionRoutes);
  await app.ready();
  try {
    const res = await silent(() => app.inject({ method: 'POST', url: '/api/encryption/keys/rotate', headers: { authorization: `Bearer ${generateToken('rs-owner', 1)}` } }));
    assert.equal(res.statusCode, 200, res.body);
  } finally {
    km.rotateKeys = originalRotate;
    logger.logConfigChange = original;
    await app.close();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'user');
  assert.equal(seen[0].id, 'rs-owner');
  // the other actor kinds map to who really acted; no actor is never an admin
  assert.deepEqual(requestAuditActor(ACTORS.admin), { type: 'user', id: 'rs-admin' });
  assert.equal(requestAuditActor(ACTORS.agent).type, 'agent');
  assert.equal(requestAuditActor(ACTORS.service).id, 'service:telegram');
  assert.deepEqual(requestAuditActor(null, { ip: '127.0.0.1' }), { type: 'api', id: 'anonymous', ip: '127.0.0.1' });
  checks += 8;
});

// --- identity -----------------------------------------------------------------

test('identity: scope matrix', async () => {
  const R = repositories.identity;
  //                                                         owner admin user guest other agent outsdr service none
  await row('identity.self', (a) => R.self(a),              ['ok', 'ok', 'ok', 'ok', 'ok', 403, 403, 403, 401]);
  await row('identity.profile', (a) => R.profile(a),        ['ok', 'ok', 'ok', 'ok', 'ok', 403, 403, 403, 401]);
  await row('identity.updateProfile(no change)', (a) => R.updateProfile(a, { fullName: null, email: null, username: null, bio: null, company: null, location: null, website: null, timezone: null }), MEMBERS);
  await row('identity.get(user)', (a) => R.get(a, 'rs-user'), ['ok', 'ok', 'ok', 404, 404, 403, 403, 403, 401]);
  await row('identity.list', (a) => R.list(a), ADMIN_UP);
  await row('identity.countByRole', (a) => R.countByRole(a), MEMBERS);
  const me = await R.self(ACTORS.user);
  assert.equal(me.id, 'rs-user');
  assert.equal(me.password_hash, undefined, 'password hashes never leave the repository');
  checks += 2;
});

test('identity (accounts, sessions, teams): scope matrix', async () => {
  const R = repositories.identity;
  const strong = () => ({ valid: true });
  //                                                                   owner admin user guest other agent outsdr service none
  const SELF                                                        = ['ok', 'ok', 'ok', 'ok', 'ok', 403, 403, 403, 401];
  await row('identity.creatableRoles', (a) => R.creatableRoles(a), ADMIN_UP);
  await row('identity.createAccount(missing fields)', (a) => R.createAccount(a, {}, strong), ADMIN_UP);
  await row('identity.endSessions', (a) => R.endSessions(a), SELF);
  await row('identity.changePassword(wrong current)', (a) => R.changePassword(a, 'wrong', 'Another-Strong-Pass-1!'), SELF);
  // teams: rs-user owns team T
  const T = (await R.createTeam(ACTORS.user, { name: 'Scope team' })).id;
  const ONLY_TEAM_OWNER                                             = [403, 403, 'ok', 403, 403, 403, 403, 403, 401];
  await row('identity.teams', (a) => R.teams(a), MEMBERS);
  await row('identity.createTeam(no name)', (a) => R.createTeam(a, { name: ' ' }), MEMBERS);
  await row('identity.team(T)', (a) => R.team(a, T), ONLY_TEAM_OWNER);
  await row('identity.updateTeam(T)', (a) => R.updateTeam(a, T, {}), ONLY_TEAM_OWNER);
  await row('identity.members(T)', (a) => R.members(a, T), ONLY_TEAM_OWNER);
  await row('identity.teamInvitations(T)', (a) => R.teamInvitations(a, T), ONLY_TEAM_OWNER);
  await row('identity.invite(T, invalid role)', (a) => R.invite(a, T, { email: 'x@example.test', role: 'owner' }), MEMBERS);
  await row('identity.invite(T)', (a, k) => R.invite(a, T, { email: `invitee-${k}@example.test`, role: 'user' }), ONLY_TEAM_OWNER);
  await row('identity.myInvitations', (a) => R.myInvitations(a), MEMBERS);
  await row('identity.acceptInvitation(missing)', (a) => R.acceptInvitation(a, 'missing'), [404, 404, 404, 403, 404, 403, 403, 403, 401]);
  await row('identity.cancelInvitation(missing)', (a) => R.cancelInvitation(a, 'missing'), [404, 404, 404, 403, 404, 403, 403, 403, 401]);
  await row('identity.removeMember(T, not a member)', (a) => R.removeMember(a, T, 'rs-other'), [403, 403, 404, 403, 403, 403, 403, 403, 401]);
  await row('identity.setMemberRole(T, not a member)', (a) => R.setMemberRole(a, T, 'rs-other', 'user'), [403, 403, 404, 403, 403, 403, 403, 403, 401]);
  await row('identity.deleteTeam(missing)', (a) => R.deleteTeam(a, 'missing-team'), [404, 404, 404, 403, 404, 403, 403, 403, 401]);
});

test('identity: accounts sign in, teams invite/accept/remove with the actor as the acting user', async () => {
  const R = repositories.identity;
  const strong = () => ({ valid: true });
  // admins cannot create admins; owners can; nobody creates an owner
  await assert.rejects(() => R.createAccount(ACTORS.admin, { email: 'a2@example.test', username: 'a2', password: 'P', role: 'admin' }, strong), (e) => e.status === 403);
  await assert.rejects(() => R.createAccount(ACTORS.owner, { email: 'o2@example.test', username: 'o2', password: 'P', role: 'owner' }, strong), (e) => e.status === 403);
  const created = await R.createAccount(ACTORS.owner, { email: 'new-user@example.test', username: 'new-user', password: 'Strong-Test-Pass-1!' }, strong);
  assert.equal(created.role, 'user');
  assert.equal(created.password_hash, undefined, 'no password hash leaves the repository');
  assert.equal((await R.signIn('nobody@example.test', 'x')).status, 'unknown');
  assert.equal((await R.signIn('new-user@example.test', 'wrong')).status, 'bad_password');
  const ok = await R.signIn('new-user@example.test', 'Strong-Test-Pass-1!');
  assert.equal(ok.status, 'ok');
  assert.ok(ok.token && ok.user.password_hash === undefined);
  // team flow: rs-user invites rs-other, rs-other accepts with the token
  const team = await R.createTeam(ACTORS.user, { name: 'Flow team', description: ' d ' });
  const { invitation, mail } = await R.invite(ACTORS.user, team.id, { email: 'rs-other@example.test', role: 'user' });
  assert.equal(mail.to, 'rs-other@example.test');
  assert.ok((await R.myInvitations(ACTORS.other)).some((i) => i.id === invitation.id));
  await R.acceptInvitation(ACTORS.other, invitation.token);
  const members = await R.members(ACTORS.other, team.id);
  assert.deepEqual(members.map((m) => m.user_id).sort(), ['rs-other', 'rs-user']);
  assert.ok('name' in members[0] && 'avatar' in members[0], 'member rows keep their name/avatar fields');
  await assert.rejects(() => R.updateTeam(ACTORS.other, team.id, { name: 'x' }), (e) => e instanceof ScopeError && e.status === 403);
  await assert.rejects(() => R.removeMember(ACTORS.other, team.id, 'rs-user'), (e) => e instanceof ScopeError && e.status === 403);
  await R.removeMember(ACTORS.user, team.id, 'rs-other');
  await assert.rejects(() => R.team(ACTORS.other, team.id), (e) => e instanceof ScopeError && e.status === 403);
  await assert.rejects(() => R.deleteTeam(ACTORS.other, team.id), (e) => e instanceof ScopeError && e.status === 403);
  await R.deleteTeam(ACTORS.user, team.id);
  checks += 16;
});

// --- transactions ----------------------------------------------------------------

test('withTransaction: one actor, commit or roll back, synchronous on SQLite', async () => {
  await assert.rejects(() => withTransaction(null, () => 1), (e) => e instanceof ScopeError && e.status === 401);
  const id = randomUUID();
  await assert.rejects(() => withTransaction(ACTORS.owner, () => {
    db.prepare(`INSERT INTO task_runs (id, task_id, agent_id, user_id, status, max_steps, max_duration_ms) VALUES (?, ?, 'rs-agent', 'rs-owner', 'completed', 1, 1)`).run(id, `t-${id}`);
    throw new Error('boom');
  }), /boom/);
  assert.equal(db.prepare('SELECT 1 FROM task_runs WHERE id = ?').get(id), undefined, 'rolled back');
  assert.equal(await withTransaction(ACTORS.owner, (a) => a.userId), 'rs-owner');
  await assert.rejects(() => withTransaction(ACTORS.owner, async () => 1), /synchronous/);
  checks += 4;
});

// --- static checks ------------------------------------------------------------

test('routes: no user id from body/query in the moved routes; SYSTEM_ACTOR never in routes', () => {
  const routesDir = join(backendDir, 'src/api/routes');
  const moved = ['task-runs.ts', 'agent-grants.ts', 'agent-personality.ts', 'credentials.ts', 'audit.ts', 'memory-files.ts', 'profile.ts',
    'agents-config.ts', 'memory.ts', 'memory-learning.ts', 'memory-import.ts',
    'auth.ts', 'gateway.ts',
    'memory-quality.ts', 'memory-sharing.ts', 'memory-access.ts'];
  for (const f of moved) {
    const src = readFileSync(join(routesDir, f), 'utf8');
    assert.doesNotMatch(src, /(body|query)\)?(\s+as\s+[^;]*?)?\??\.userId\b/, `${f} reads a user id from the request`);
    // B1.6: nor destructures one out of the body/query
    assert.doesNotMatch(src, /\{[^}\n]*\buserId\b[^}\n]*\}\s*=\s*\(?\s*(request|req)\.(body|query)\b/, `${f} destructures a user id from the request`);
  }
  for (const f of readdirSync(routesDir)) {
    const src = readFileSync(join(routesDir, f), 'utf8');
    assert.doesNotMatch(src, /SYSTEM_ACTOR/, `${f} must not use SYSTEM_ACTOR`);
    // B1.7: no audit entry names a made-up 'api/admin' actor
    assert.doesNotMatch(src, /type:\s*'api',\s*id:\s*[^}]*'admin'/, `${f} logs the literal api/admin actor`);
  }
  // B1.7: the memory side routes reach memory only through the repository
  for (const f of ['memory-quality.ts', 'memory-sharing.ts', 'memory-access.ts']) {
    const src = readFileSync(join(routesDir, f), 'utf8');
    assert.doesNotMatch(src, /getDatabase|getMemoryStorage|authenticateActiveUser|MemoryQualityScorer|MemoryEnrichmentService|memory-deduplication/, `${f} must use the memory repository`);
  }
  assert.match(readFileSync(join(routesDir, 'memory-access.ts'), 'utf8'), /actorOrReply\(reply, actorOf\(request\), requireMember\)/);
  // B1.6: the memory tools reach memory only through the repository (no own
  // storage/database access, no model-supplied user id).
  const toolsDir = join(backendDir, 'src/tools/memory');
  const memoryTools = ['search.ts', 'save.ts', 'edit.ts', 'forget.ts', 'memory-reflect.tool.ts', 'memory-stats.tool.ts'];
  for (const f of memoryTools) {
    const src = readFileSync(join(toolsDir, f), 'utf8');
    assert.doesNotMatch(src, /getMemoryStorage|getDatabase|(?<!\.)\bagentChange\(|(?<!\.)\blearn\(/, `${f} must use the memory repository`);
    assert.doesNotMatch(src, /params\??\.userId\b/, `${f} reads a user id from the model`);
    assert.match(src, /repositories\.memory\./, `${f} uses the memory repository`);
  }
  checks += moved.length * 2 + 1 + memoryTools.length * 3 + 4;
});

test('matrix size', () => {
  // 9 actor kinds x every repository method row above, plus content checks.
  assert.ok(checks >= 500, `matrix has ${checks} checks`);
  quiet.log(`# repository scope matrix: ${checks} checks`);
});
