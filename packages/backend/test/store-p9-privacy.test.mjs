// STORE-MAP-01 P9 (GIRRU_STORE_P9) PRIV2, PRIV3, PRIV7, PRIV8.
//  - PRIV2: a place that stays on this computer (People by default) never reaches a model that is not:
//    the drawer filter, the pinned-fact filter, the coding-app context, the bridge's search; locality
//    only from trusted config (Ollama on loopback, LM Studio); off = nothing changes;
//  - PRIV3: personal data (e-mail, phone, bank account, card, address, id number) is detected, kinds
//    only, and flags imported and channel text for review;
//  - PRIV7: special categories (health, religion, politics, sexuality, origin, union, genetic) are
//    never saved automatically, even where a scope rule would save the rest;
//  - PRIV8: the owner can NOT read a member's private memory through any memory route.
// Run: node --import tsx --test test/store-p9-privacy.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets, no network, no real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p9-privacy-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_P3', 'GIRRU_STORE_P9', 'GIRRU_STORE_PILOT']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'p9v-owner';
const MEMBER = 'p9v-member';
for (const [u, role] of [[OWNER, 'owner'], [MEMBER, 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(u, `${u}@example.test`, u, role);
}
const S = await load('src/memory/stays-local.ts');
const PS = await load('src/memory/place-settings.ts');
const PD = await load('src/memory/personal-data.ts');
const { classifyLearning, learn } = await load('src/memory/learning.ts');
const { getMemoryStorage } = await load('src/memory/storage.ts');
await getMemoryStorage().initialize();

const add = (id, user, content, kind, key) => db.prepare(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
  VALUES (?, ?, 'fact', ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?)`).run(id, user, content, new Date().toISOString(), kind, key);

test('PRIV2: locality comes from trusted config only', () => {
  assert.equal(S.providerIsLocal('ollama'), true); // OLLAMA_URL is loopback here
  assert.equal(S.providerIsLocal('lmstudio'), true);
  for (const p of ['claude', 'openai', 'gemini', 'codex', '', null, undefined, 'local', 'Ollama']) assert.equal(S.providerIsLocal(p), false, String(p));
  // Ollama's cloud models run on Ollama's servers.
  assert.equal(S.providerIsLocal('ollama', 'qwen3:4b'), true);
  for (const m of ['gpt-oss:120b-cloud', 'deepseek-v3.1:671b-cloud', 'kimi:cloud', 'qwen3-coder:480b-CLOUD']) assert.equal(S.providerIsLocal('ollama', m), false, m);
});

test('PRIV2: People stays local by default; a place switched on is withheld from a model that is not local', async () => {
  const drawers = [{ kind: 'owner' }, { kind: 'experience' }, { kind: 'project', key: 'alpha' }, { kind: 'people', key: 'sam' }];
  let r = await S.cloudSafeDrawers(OWNER, drawers);
  assert.deepEqual(r.withheld, [{ kind: 'people', key: 'sam' }]);
  assert.equal(r.drawers.length, 3);
  await PS.setPlaceSetting(OWNER, 'project:alpha', true);
  await PS.setPlaceSetting(OWNER, 'company', true);
  r = await S.cloudSafeDrawers(OWNER, drawers);
  assert.deepEqual(r.drawers, [{ kind: 'owner' }, { kind: 'experience' }]);
  assert.deepEqual(await S.cloudSafePinnedAllow(OWNER, 'alpha', { company: true, project: true, department: true }), { company: false, project: false, department: false });
  assert.deepEqual(await S.cloudSafePinnedAllow(OWNER, 'beta', { company: true, project: true }), { company: false, project: true });
  await PS.setPlaceSetting(OWNER, 'people', false); // the owner may let People leave
  assert.equal((await S.cloudSafeDrawers(OWNER, [{ kind: 'people', key: 'sam' }])).withheld.length, 0);
  await PS.setPlaceSetting(OWNER, 'people', true);
  await PS.setPlaceSetting(OWNER, 'company', false);
});

test('PRIV2: the coding-app context and the bridge leave out a project that stays local', async () => {
  const { createProject } = await load('src/repositories/chat-conversations.ts');
  const { resolveAgentContext } = await load('src/services/agent-context/resolve.ts');
  const brief = await load('src/memory/bridge/brief.ts');
  db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('a-p9', 'Sara', 'ollama', 'qwen-test', 1)`).run();
  const p = await createProject(OWNER, { name: 'Gamma' });
  add('g-1', OWNER, 'Gamma ships monthly.', 'project', p.slug);
  delete process.env.GIRRU_STORE_P9;
  assert.equal((await brief.bridgeDrawers(OWNER, p)).length, 1);
  assert.equal((await brief.approvedMemories(OWNER, p)).length, 1);
  process.env.GIRRU_STORE_P9 = '1';
  assert.equal((await brief.approvedMemories(OWNER, p)).length, 1, 'not local yet');
  await PS.setPlaceSetting(OWNER, `project:${p.slug}`, true);
  assert.deepEqual(await brief.bridgeDrawers(OWNER, p), []);
  assert.deepEqual(await brief.approvedMemories(OWNER, p), []);
  assert.deepEqual(await brief.topicIndex(OWNER, p), [], 'no topics either');
  const coding = await resolveAgentContext({ agentId: 'a-p9', entry: 'coding_app', ownerId: OWNER, projectId: p.id });
  assert.ok(!coding.drawers.some((d) => d.kind === 'project'));
  const local = await resolveAgentContext({ agentId: 'a-p9', entry: 'task', ownerId: OWNER, projectId: p.id });
  assert.ok(local.drawers.some((d) => d.kind === 'project'), 'a local model still reads it');
  delete process.env.GIRRU_STORE_P9;
  assert.ok((await resolveAgentContext({ agentId: 'a-p9', entry: 'coding_app', ownerId: OWNER, projectId: p.id })).drawers.some((d) => d.kind === 'project'), 'off: as before');
});

test('PRIV3: personal data kinds, never values', () => {
  const cases = [
    ['Write to sara.k@example.com tomorrow', ['email']],
    ['Call him on +49 170 1234567', ['phone']],
    ['اتصل على ٠٧٧٠١٢٣٤٥٦٧', ['phone']],
    ['IBAN DE89 3704 0044 0532 0130 00', ['bank-account']],
    ['Card 4111 1111 1111 1111 expires soon', ['card']],
    ['She lives at 221 Baker Street', ['address']],
    ['Wohnt in der Hauptstraße 12', ['address']],
    ['Passport number X1234567 renews in May', ['id-number']],
    ['We shipped 1.2.3 on 2026-11-03 at 10:30', []],
    ['The build took 12345 ms', []],
  ];
  for (const [text, kinds] of cases) assert.deepEqual(PD.personalDataKinds(text).sort(), [...kinds].sort(), text);
  // Bounded work on hostile text (no catastrophic backtracking).
  const t0 = performance.now();
  for (const evil of ['1'.repeat(50_000) + 'x', '1 '.repeat(40_000), ('9 Aa '.repeat(20_000)) + '!', 'a@'.repeat(30_000)]) { PD.personalDataKinds(evil); PD.specialCategory(evil); }
  assert.ok(performance.now() - t0 < 1500, `took ${Math.round(performance.now() - t0)} ms`);
});

test('PRIV3/PRIV7: the classifier flags them with P9 on only', () => {
  const special = { content: 'Sam goes to the mosque on Fridays', type: 'fact', drawer: { kind: 'owner' }, origin: 'agent' };
  const health = { content: 'Lena takes medication for her depression', type: 'fact', drawer: { kind: 'experience' }, origin: 'agent' };
  const imported = { content: 'Customer contact: anna@example.org', type: 'fact', drawer: { kind: 'owner' }, origin: 'owner', imported: true };
  const channel = { content: 'My number is 0170 9876543', type: 'fact', drawer: { kind: 'owner' }, origin: 'outsider' };
  assert.ok(!classifyLearning(special).reasons.includes('special-category'));
  process.env.GIRRU_STORE_P9 = '1';
  assert.ok(classifyLearning(special).reasons.includes('special-category'));
  assert.ok(classifyLearning(health).reasons.includes('special-category'));
  assert.ok(classifyLearning(imported).reasons.includes('personal-data'));
  assert.ok(classifyLearning(channel).reasons.includes('personal-data'));
  assert.ok(!classifyLearning({ ...imported, imported: false, origin: 'agent' }).reasons.includes('personal-data'), 'only imported and channel text');
  delete process.env.GIRRU_STORE_P9;
});

test('PRIV7: a special category is never saved automatically, even when a scope rule saves the rest', async () => {
  const { setScopeRules } = await load('src/memory/scopes/rules.ts');
  await setScopeRules?.(OWNER, 'experience', { routine: 'save', important: 'save' }, OWNER).catch(() => undefined);
  process.env.GIRRU_STORE_P9 = '1';
  const out = await learn({ userId: OWNER, actor: 'agent:a-p9', agentId: 'a-p9', candidates: [
    { content: 'The CI runs on Mondays', type: 'fact', importance: 5, origin: 'agent', drawer: { kind: 'experience' } },
    { content: 'Omar was in hospital after surgery', type: 'fact', importance: 5, origin: 'agent', drawer: { kind: 'experience' } },
  ] });
  assert.equal(out.saved.length, 1);
  assert.equal(out.saved[0].content, 'The CI runs on Mondays');
  assert.equal(out.proposed.length, 1);
  assert.ok(out.classified.some((c) => c.reasons.includes('special-category')));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%hospital%'").get().n, 0);
  delete process.env.GIRRU_STORE_P9;
});

test('PRIV8: the owner can NOT read a member\'s private memory through any memory route', async () => {
  add('mem-private', MEMBER, 'My private salary note: 4200', 'owner', null);
  add('mem-private-p', MEMBER, 'Private people note about Rami', 'people', 'rami');
  const { generateToken } = await load('src/auth/jwt.ts');
  const { buildServer } = await load('src/api/app.ts');
  const app = await buildServer({ logger: false });
  await app.ready();
  const call = (user, method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(user, 1)}` }, ...(payload ? { payload } : {}) });
  process.env.GIRRU_STORE_P9 = '1';
  const reads = [
    ['GET', '/api/memory'], ['GET', '/api/memory/page'], ['GET', '/api/memory/drawers'],
    ['POST', '/api/memory/search', { query: 'private salary note', limit: 50 }],
    ['GET', '/api/memory/relevant?query=salary'], ['GET', '/api/memory/summary'],
    ['GET', '/api/memory/mem-private/versions'],
    ['GET', '/api/memory/scopes/tree'], ['GET', '/api/memory/scopes/memories?scope=owner'],
    ['GET', '/api/memory/scopes/memories/mem-private'], ['GET', '/api/memory/scopes/search?q=rami'],
    ['GET', '/api/memory/people/rami/export'],
  ];
  const statuses = [];
  for (const [method, url, body] of reads) {
    const r = await call(OWNER, method, url, body);
    assert.doesNotMatch(r.body, /salary note|Private people note|mem-private/, `${method} ${url} (${r.statusCode})`);
    statuses.push(r.statusCode);
  }
  // Most of them answer the owner (an empty answer, not a refusal).
  assert.ok(statuses.filter((s) => s === 200).length >= 8, statuses.join(','));
  const f = await call(OWNER, 'POST', '/api/memory/mem-private/forget');
  assert.equal(f.statusCode, 404, 'nor forget it');
  assert.ok(db.prepare("SELECT 1 FROM memories WHERE id = 'mem-private'").get());
  // The member reads their own.
  const own = await call(MEMBER, 'POST', '/api/memory/search', { query: 'private salary note', limit: 5 });
  assert.match(own.body, /salary note/);
  delete process.env.GIRRU_STORE_P9;
  await app.close();
});
