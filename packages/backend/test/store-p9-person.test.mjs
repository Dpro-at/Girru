// STORE-MAP-01 P9 (GIRRU_STORE_P9) PRIV5, PRIV6: one person's data.
//  - export: the person's drawer (current and replaced), memories that mention them (graph link or
//    their name as a whole word, in English and Arabic), their graph entities, handoff lines naming
//    them; an agent's own notes only as ids; another user's memory never;
//  - forget the person in one action: the drawer with its history, the picked mentions (only ids the
//    export listed), the graph entities; a 'person' ledger line; the confirm word is required;
//  - retention (PRIV5): a replaced fact about a person is forgotten after PEOPLE_REPLACED_DAYS, a
//    current fact never; only while P9 is on, inside a retention run (dry run changes nothing);
//  - routes: off = 404; owner only; the export carries no other user's data.
// Run: node --import tsx --test test/store-p9-person.test.mjs
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
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p9-person-')));
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
const OWNER = 'p9p-owner';
const OTHER = 'p9p-other';
const MEMBER = 'p9p-member';
for (const [u, role] of [[OWNER, 'owner'], [OTHER, 'owner'], [MEMBER, 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(u, `${u}@example.test`, u, role);
}
const P = await load('src/memory/person.ts');
const L = await load('src/memory/forget-ledger.ts');
const { runRetention, setRetentionConfig } = await load('src/memory/retention.ts');
const { getMemoryStorage } = await load('src/memory/storage.ts');
await getMemoryStorage().initialize();

const day = 86_400_000;
const add = (id, user, content, kind, key, extra = {}) => db.prepare(`INSERT INTO memories (id, user_id, type, content, memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key, valid_to)
  VALUES (?, ?, 'fact', ?, 'factual', ?, '{}', 0.5, ?, 0, ?, ?, ?)`).run(id, user, content, extra.status ?? 'active', extra.at ?? new Date().toISOString(), kind, key, extra.validTo ?? null);
const version = (id, user, kind, key, content) => db.prepare(`INSERT INTO memory_versions (id, memory_id, user_id, drawer_kind, drawer_key, drawer_revision, version, change, type, content, created_by, created_at)
  VALUES (?, ?, ?, ?, ?, 1, 1, 'create', 'fact', ?, ?, ?)`).run(`v-${id}`, id, user, kind, key ?? '', content, user, new Date().toISOString());

add('sam-1', OWNER, 'Sam prefers calls in the morning.', 'people', 'sam');
version('sam-1', OWNER, 'people', 'sam', 'Sam prefers calls in the morning.');
add('sam-old', OWNER, 'Sam lives in Graz.', 'people', 'sam', { status: 'replaced', validTo: new Date(Date.now() - 400 * day).toISOString(), at: new Date(Date.now() - 800 * day).toISOString() });
add('sam-recent-old', OWNER, 'Sam works at Acme.', 'people', 'sam', { status: 'replaced', validTo: new Date(Date.now() - 10 * day).toISOString() });
add('m-name', OWNER, 'Meeting with Sam about the invoice on Friday.', 'project', 'alpha');
add('m-arabic', OWNER, 'اتصل سام بخصوص الفاتورة', 'owner', null);
add('m-graph', OWNER, 'He asked for the new design.', 'owner', null);
add('m-samuel', OWNER, 'Samuel from the bank called.', 'owner', null); // not Sam: whole words only
add('m-agent', OWNER, 'Note: Sam is slow to answer.', 'agent', 'a-1');
add('o-sam', OTHER, 'Sam is my brother.', 'people', 'sam');
add('o-name', OTHER, 'Sam called me.', 'owner', null);
db.prepare(`INSERT INTO memory_graph_entities (id, user_id, kind, name, norm_name, aliases) VALUES ('e-sam', ?, 'person', 'Sam', 'sam', '["سام"]')`).run(OWNER);
db.prepare(`INSERT INTO memory_graph_entities (id, user_id, kind, name, norm_name, aliases) VALUES ('e-acme', ?, 'project', 'Acme', 'acme', '[]')`).run(OWNER);
db.prepare(`INSERT INTO memory_graph_mentions (memory_id, entity_id, user_id) VALUES ('m-graph', 'e-sam', ?)`).run(OWNER);
db.prepare(`INSERT INTO memory_graph_links (id, user_id, src_id, type, dst_id) VALUES ('l-1', ?, 'e-sam', 'works_on', 'e-acme')`).run(OWNER);
db.prepare(`INSERT INTO agent_handoffs (id, owner_id, agent_id, scope_kind, scope_id, version, done, remaining, next_steps, open_questions, source)
  VALUES ('h-1', ?, 'a-1', 'task', 't-1', 1, '["Called Sam back"]', '[]', '["Send the deck"]', '[]', 'agent')`).run(OWNER);

test('export: everything about one person, and nothing of another user', async () => {
  const e = await P.exportPerson(OWNER, 'sam');
  assert.deepEqual(e.drawer.map((m) => m.id).sort(), ['sam-1', 'sam-old', 'sam-recent-old']);
  assert.deepEqual(e.mentions.map((m) => [m.id, m.why]).sort(), [['m-arabic', 'name'], ['m-graph', 'graph'], ['m-name', 'name']]);
  assert.deepEqual(e.agentNotes, { count: 1, ids: ['m-agent'] });
  assert.ok(!JSON.stringify(e).includes('slow to answer'), 'an agent note is never copied out');
  assert.deepEqual(e.graph.map((g) => [g.id, g.links]), [['e-sam', 1]]);
  assert.deepEqual(e.handoffs.map((h) => [h.id, h.lines]), [['h-1', ['Called Sam back']]]);
  assert.ok(!JSON.stringify(e).includes('brother') && !JSON.stringify(e).includes('o-name'));
  await assert.rejects(P.exportPerson(OWNER, '../etc'), (err) => err.status === 400);
});

test('retention (PRIV5): an old replaced fact about a person goes, a current one stays', async () => {
  const stale = await P.stalePeopleFacts(OWNER);
  assert.deepEqual(stale.map((s) => s.id), ['sam-old']);
  await setRetentionConfig(OWNER, { enabled: true }, OWNER);
  // Off: retention does not touch people drawers (as before).
  let r = await runRetention(OWNER, { dryRun: true });
  assert.equal(r.people, undefined);
  process.env.GIRRU_STORE_P9 = '1';
  r = await runRetention(OWNER, { dryRun: true });
  assert.equal(r.people.forgotten, 1);
  assert.ok(db.prepare("SELECT 1 FROM memories WHERE id = 'sam-old'").get(), 'a dry run changes nothing');
  r = await runRetention(OWNER, {});
  assert.equal(r.people.forgotten, 1);
  assert.equal(db.prepare("SELECT 1 FROM memories WHERE id = 'sam-old'").get(), undefined);
  assert.ok(db.prepare("SELECT 1 FROM memories WHERE id = 'sam-1'").get());
  assert.ok(db.prepare("SELECT 1 FROM memories WHERE id = 'sam-recent-old'").get());
  delete process.env.GIRRU_STORE_P9;
});

test('forget the person in one action', async () => {
  process.env.GIRRU_STORE_P9 = '1';
  await assert.rejects(P.forgetPerson(OWNER, 'sam', OWNER, { confirm: 'yes' }), /confirm/);
  await assert.rejects(P.forgetPerson(OWNER, 'sam', OWNER, { confirm: 'sam', mentionIds: ['m-samuel'] }), /do not mention/);
  await assert.rejects(P.forgetPerson(OWNER, 'sam', OWNER, { confirm: 'sam', mentionIds: ['o-name'] }), /do not mention/);
  const r = await P.forgetPerson(OWNER, 'sam', OWNER, { confirm: 'sam', mentionIds: ['m-name', 'm-graph'] });
  assert.deepEqual(r, { drawer: 2, mentions: 2, graph: 1 });
  const left = db.prepare('SELECT id FROM memories WHERE user_id = ? ORDER BY id').all(OWNER).map((x) => x.id);
  assert.deepEqual(left, ['m-agent', 'm-arabic', 'm-samuel'], 'the unpicked mention and other memories stay');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_versions WHERE memory_id = 'sam-1' AND content IS NOT NULL").get().n, 0, 'history text gone');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_graph_entities WHERE id = 'e-sam'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_graph_links WHERE id = 'l-1'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_graph_mentions WHERE entity_id = 'e-sam'").get().n, 0);
  assert.ok(db.prepare("SELECT 1 FROM agent_handoffs WHERE id = 'h-1'").get(), 'handoffs are work records: kept');
  assert.ok(L.readLedger().some((l) => l.kind === 'person' && l.memoryId === 'sam' && l.userId === OWNER));
  assert.ok(db.prepare("SELECT 1 FROM memories WHERE id = 'o-sam'").get(), 'another user keeps their Sam');
  delete process.env.GIRRU_STORE_P9;
});

test('routes: off = 404, owner only, export and forget', async () => {
  const { generateToken } = await load('src/auth/jwt.ts');
  const { buildServer } = await load('src/api/app.ts');
  const app = await buildServer({ logger: false });
  await app.ready();
  const call = (user, method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(user, 1)}` }, ...(payload ? { payload } : {}) });
  add('ali-1', OWNER, 'Ali likes tea.', 'people', 'ali');
  add('m-ali', OWNER, 'Ali joins the Monday call.', 'owner', null);
  const off = await call(OWNER, 'GET', '/api/memory/people/ali/export');
  assert.equal(off.statusCode, 404, off.body.slice(0, 200));
  process.env.GIRRU_STORE_P9 = '1';
  const call2 = call;
  assert.equal((await call2(MEMBER, 'GET', '/api/memory/people/ali/export')).statusCode, 403);
  const ex = await call2(OWNER, 'GET', '/api/memory/people/ali/export');
  assert.equal(ex.statusCode, 200, ex.body);
  assert.match(ex.headers['content-disposition'] || '', /attachment; filename="person-ali-/);
  assert.deepEqual(ex.json().mentions.map((m) => m.id), ['m-ali']);
  assert.equal((await call2(OWNER, 'GET', '/api/memory/people/..%2Fetc/export')).statusCode, 400);
  assert.equal((await call2(OWNER, 'POST', '/api/memory/people/ali/forget', { confirm: 'nope' })).statusCode, 400);
  const f = await call2(OWNER, 'POST', '/api/memory/people/ali/forget', { confirm: 'ali', mentionIds: ['m-ali'] });
  assert.equal(f.statusCode, 200, f.body);
  assert.deepEqual(f.json(), { drawer: 1, mentions: 1, graph: 0 });
  delete process.env.GIRRU_STORE_P9;
  await app.close();
});
