// STORE-MAP-01 P9 screens (boards P9c, P9d), backend glue (GIRRU_STORE_P9):
//  - the special-category topics name the same words as specialCategory (no behaviour change);
//  - a waiting memory carries privacy { personalData, sensitive } (kinds and topics only) while P9 is on,
//    and nothing new while it is off; /api/store-switches names p9 only while on;
//  - the agent tools do what the window does with the same owner gates: export and forget one
//    person (the person's drawer open for the run, approval for both), list and decide flagged memories.
// Run: node --import tsx --test test/store-p9-screens.test.mjs
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
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p9-screens-')));
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
const OWNER = 'p9s-owner';
const MEMBER = 'p9s-member';
for (const [u, role] of [[OWNER, 'owner'], [MEMBER, 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(u, `${u}@example.test`, u, role);
}
const PD = await load('src/memory/personal-data.ts');
const { learn } = await load('src/memory/learning.ts');
const { getMemoryStorage } = await load('src/memory/storage.ts');
await getMemoryStorage().initialize();
const D = await load('src/memory/drawers.ts');
const T = await load('src/tools/memory/index.ts');
const { approvalCategory } = await load('src/tools/approvals.ts');
const { DEFAULT_AGENT_TOOLS } = await load('src/tools/grants.ts');

const add = (id, content, kind, key) => db.prepare(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
  VALUES (?, ?, 'fact', ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?)`).run(id, OWNER, content, new Date().toISOString(), kind, key);
const on = async (fn) => { process.env.GIRRU_STORE_P9 = '1'; try { return await fn(); } finally { delete process.env.GIRRU_STORE_P9; } };

test('topics name the same words as specialCategory', () => {
  const cases = [['Lena takes medication for her depression', ['health']], ['Rami votes for the Green party', ['politics']], ['يصلي في المسجد', ['religion']],
    ['Er ist in der Gewerkschaft und schwul', ['sexuality', 'union']], ['Her DNA test came back', ['genetic']], ['The office moved to Linz in May', []], ['ethnic food night', ['origin']]];
  for (const [text, topics] of cases) {
    assert.deepEqual(PD.specialCategoryTopics(text), topics, text);
    assert.equal(PD.specialCategory(text), topics.length > 0, text);
  }
  assert.equal(PD.privacyFlags(['people'], ['Lena takes medication']), null, 'only flagged reasons');
  assert.deepEqual(PD.privacyFlags(['personal-data'], ['Customer contact: anna@example.org, +43 660 1234567']), { personalData: ['email', 'phone'], sensitive: [] });
});

let flagged;
test('a waiting flagged memory carries privacy only while P9 is on; store-switches names p9', async () => {
  await on(async () => {
    const out = await learn({ userId: OWNER, actor: 'agent:nora', agentId: 'nora', candidates: [
      { content: 'Lena takes medication for her depression', type: 'fact', importance: 5, origin: 'agent', drawer: { kind: 'people', key: 'lena' } },
    ] });
    assert.equal(out.saved.length, 0, 'never saved by itself');
    flagged = out.proposed[0];
  });
  assert.ok(flagged?.id);
  const { generateToken } = await load('src/auth/jwt.ts');
  const { buildServer } = await load('src/api/app.ts');
  const app = await buildServer({ logger: false });
  await app.ready();
  const call = (method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(OWNER, 1)}` }, ...(payload ? { payload } : {}) });
  const off = JSON.parse((await call('GET', '/api/memory/proposals?status=pending')).body).proposals.find((p) => p.id === flagged.id);
  assert.equal('privacy' in off, false, 'nothing new while off');
  assert.equal('p9' in JSON.parse((await call('GET', '/api/store-switches')).body), false);
  await on(async () => {
    const list = JSON.parse((await call('GET', '/api/memory/proposals?status=pending')).body).proposals.find((p) => p.id === flagged.id);
    assert.deepEqual(list.privacy, { personalData: [], sensitive: ['health'] });
    const one = JSON.parse((await call('GET', `/api/memory/proposals/${flagged.id}`)).body);
    assert.deepEqual(one.privacy, { personalData: [], sensitive: ['health'] });
    assert.equal(JSON.parse((await call('GET', '/api/store-switches')).body).p9, true);
  });
  await app.close();
});

test('agent tools: one person and the privacy review, with the window\'s owner gates', async () => {
  for (const name of ['memory_person_export', 'memory_person_forget', 'memory_privacy_decide']) assert.ok(approvalCategory({ name }), `${name} needs owner approval`);
  assert.equal(approvalCategory({ name: 'memory_person_forget' }), 'delete');
  assert.equal(approvalCategory({ name: 'memory_privacy_review' }), null);
  for (const name of ['memory_person_export', 'memory_person_forget', 'memory_privacy_review', 'memory_privacy_decide']) assert.ok(DEFAULT_AGENT_TOOLS.includes(name), name);

  add('sam-1', 'Sam prefers calls in the morning.', 'people', 'sam');
  add('sam-2', 'Meeting with Sam about the invoice on Friday.', 'project', 'website');
  add('sam-3', 'Samuel from the bank called.', 'owner', null);
  const withSam = { workspaceDir: dir, userId: OWNER, agentId: 'nora', sessionId: 's1', memoryDrawers: [...D.selectDrawers({ audience: 'owner', project: 'website', people: ['sam', 'lena'] })] };
  const withoutSam = { ...withSam, memoryDrawers: D.selectDrawers({ audience: 'owner', project: 'website' }) };
  const member = { ...withSam, userId: MEMBER };
  const outsider = { ...withSam, toolPolicy: { channel: 'telegram', allowedTools: [] } };
  const taskRun = { ...withSam, userId: 'nora', accessOwnerId: OWNER };

  assert.match((await T.memoryPersonExportTool.execute({ person: 'sam' }, withSam)).error, /not available yet/, 'off: refused');
  await on(async () => {
    for (const bad of [member, outsider, taskRun, withoutSam]) assert.ok((await T.memoryPersonExportTool.execute({ person: 'sam' }, bad)).error);
    const e = await T.memoryPersonExportTool.execute({ person: 'sam' }, withSam);
    assert.ok(!e.error, e.content[0].text);
    assert.deepEqual(e.data.export.drawer.map((m) => m.id), ['sam-1']);
    assert.deepEqual(e.data.export.mentions.map((m) => m.id), ['sam-2'], 'whole word: Samuel is not Sam');
    assert.ok((await T.memoryPersonForgetTool.execute({ person: 'sam', confirm: 'Sam' }, withSam)).error, 'the key confirms');
    assert.ok((await T.memoryPersonForgetTool.execute({ person: 'sam', confirm: 'sam', mention_ids: ['sam-3'] }, withSam)).error, 'only listed mentions');
    assert.ok((await T.memoryPersonForgetTool.execute({ person: 'sam', confirm: 'sam' }, { ...withSam, permissions: { memoryRead: ['owner', 'project', 'people'], memoryWrite: ['project'] } })).error, 'may not write people');
    const f = await T.memoryPersonForgetTool.execute({ person: 'sam', confirm: 'sam', mention_ids: ['sam-2'] }, withSam);
    assert.ok(!f.error, f.content[0].text);
    assert.deepEqual([f.data.drawer, f.data.mentions], [1, 1]);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE id IN ('sam-1','sam-2')").get().n, 0);
    assert.ok(db.prepare("SELECT 1 FROM memories WHERE id = 'sam-3'").get(), 'Samuel stays');

    const r = await T.memoryPrivacyReviewTool.execute({}, withSam);
    const item = r.data.items.find((x) => x.id === flagged.id);
    assert.ok(item, r.content[0].text);
    assert.deepEqual(item.sensitive, ['health']);
    assert.equal((await T.memoryPrivacyReviewTool.execute({}, withoutSam)).data.items.some((x) => x.id === flagged.id), false, 'only open drawers');
    for (const bad of [member, outsider]) assert.ok((await T.memoryPrivacyReviewTool.execute({}, bad)).error);
    assert.ok((await T.memoryPrivacyDecideTool.execute({ proposal_id: flagged.id, decision: 'forget', review_hash: 'wrong' }, withSam)).error, 'the review hash binds it');
    const d = await T.memoryPrivacyDecideTool.execute({ proposal_id: flagged.id, decision: 'forget', review_hash: item.reviewHash }, withSam);
    assert.ok(!d.error, d.content[0].text);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%depression%'").get().n, 0, 'forgotten, never saved');
  });
});
