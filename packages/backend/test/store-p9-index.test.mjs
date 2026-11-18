// STORE-MAP-01 P9 (GIRRU_STORE_P9) D9: indexes and the recall index.
//  - migration 179's expression index is used by the drawer filter (EXPLAIN), with no change to results;
//  - the recall index returns exactly the same memories, scores and order as the full-row path
//    (packed vectors, JSON-only vectors, rows without vectors, the working-layer boost, filters);
//  - an edit, a re-embed, a forget, a delete and a replaced fact are seen by the next search;
//  - forget drops the user's index; a gone row's entry is dropped when its drawer is searched;
//  - the size cap keeps nothing past it and recall still works.
// Run: node --import tsx --test test/store-p9-index.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets, no network, no real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { clearEnv } from './helpers/switches.mjs';
const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p9-index-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.OLLAMA_URL = 'http://127.0.0.1:9';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_P3', 'GIRRU_STORE_P9', 'GIRRU_STORE_PILOT', 'GIRRU_RECALL_INDEX_MB']) clearEnv(k);
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'p9i-owner';
const OTHER = 'p9i-other';
for (const u of [OWNER, OTHER]) db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', 'owner', 'active')`).run(u, `${u}@example.test`, u);

const { getMemoryStorage } = await load('src/memory/storage.ts');
const { hashEmbed, HASH_MODEL, HASH_DIMS } = await load('src/memory/embedding.ts');
const { normalizeMemoryText } = await load('src/memory/text-normalize.ts');
const { packVector } = await load('src/memory/vectors.ts');
const { forgetMemory } = await load('src/memory/forget.ts');
const { forgetRecallIndex, recallIndexStats } = await load('src/memory/recall-index.ts');
const D = await load('src/memory/drawers.ts');
const storage = getMemoryStorage();
await storage.initialize();

const WORDS = ['deploy', 'server', 'invoice', 'customer', 'meeting', 'design', 'database', 'login', 'payment', 'backup',
  'النشر', 'الخادم', 'فاتورة', 'العميل', 'اجتماع', 'تصميم', 'قاعدة', 'الدخول', 'الدفع', 'نسخة'];
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims, embedding_vec,
  memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?, 0, ?, ?)`);
const drawers = [['owner', ''], ['project', 'alpha'], ['project', 'beta'], ['experience', ''], ['people', 'sam']];
for (let i = 0; i < 600; i++) {
  const user = i % 10 === 9 ? OTHER : OWNER;
  const content = Array.from({ length: 4 + Math.floor(rnd() * 12) }, () => pick(WORDS)).join(' ') + ` note ${i}`;
  const vec = hashEmbed(normalizeMemoryText(content));
  const kind = i % 3; // 0: packed + JSON, 1: JSON only, 2 (some): no vector
  const noVec = kind === 2 && i % 2 === 0;
  const [dk, dkey] = drawers[i % drawers.length];
  insert.run(`m-${String(i).padStart(4, '0')}`, user, i % 11 === 0 ? 'skill' : 'fact', content,
    noVec ? null : JSON.stringify(vec), noVec ? null : HASH_MODEL, noVec ? null : HASH_DIMS,
    kind === 0 ? packVector(vec) : null, i % 13 === 0 ? 'working' : 'factual', (i % 10) / 10,
    new Date(Date.UTC(2026, 0, 1, 0, i % 50)).toISOString(), dk, dkey || null);
}

const OPEN = D.selectDrawers({ audience: 'owner', project: 'alpha' });
const QUERIES = ['deploy server', 'invoice customer payment', 'قاعدة الدخول', 'النشر الخادم', 'backup نسخة', 'design meeting', 'nothing here at all', 'note 42'];
const shape = (rs) => rs.map((r) => ({ id: r.memory.id, s: r.similarity, v: r.scoreBreakdown.vectorScore, k: r.scoreBreakdown.keywordScore, c: r.memory.content, d: r.memory.drawer }));
async function both(q) {
  process.env.GIRRU_STORE_P9 = '0';
  const off = shape(await storage.search(q));
  process.env.GIRRU_STORE_P9 = '1';
  const on = shape(await storage.search(q));
  const again = shape(await storage.search(q)); // from the index
  process.env.GIRRU_STORE_P9 = '0';
  return { off, on, again };
}

test('the drawer filter uses the expression index (migration 179)', () => {
  const f = D.drawerSqlFilter([{ kind: 'project', key: 'alpha' }]);
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM memories WHERE user_id = ? AND ${f.sql}`).all(OWNER, ...f.params).map((r) => r.detail).join(' | ');
  assert.match(plan, /idx_memories_drawer_expr/);
});

test('a row without a vector is embedded by a P9 search, as by the old one (16 at most)', async () => {
  const stale = () => db.prepare("SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND embedding IS NULL AND drawer_kind IN ('owner','experience') OR (drawer_kind = 'project' AND drawer_key = 'alpha' AND embedding IS NULL AND user_id = ?)").get(OWNER, OWNER).n;
  const start = stale();
  assert.ok(start > 16);
  process.env.GIRRU_STORE_P9 = '1';
  const hits = await storage.search({ query: 'deploy server', userId: OWNER, drawers: OPEN, limit: 50 });
  assert.equal(stale(), start - 16);
  // A row embedded in this very search is scored with its new vector.
  const fresh = db.prepare("SELECT id FROM memories WHERE user_id = ? AND embedding IS NOT NULL AND embedding_vec IS NULL AND id IN (SELECT id FROM memories WHERE embedding_model = ?) ORDER BY created_at, id").all(OWNER, HASH_MODEL).map((r) => r.id);
  assert.ok(fresh.length > 0);
  assert.ok(hits.some((h) => h.scoreBreakdown.vectorScore > 0));
  // Drain the rest (both users) so both paths below read the same rows.
  for (let k = 0; k < 40; k++) {
    await storage.search({ query: 'x', userId: OWNER, drawers: [...OPEN, { kind: 'project', key: 'beta' }, { kind: 'people', key: 'sam' }], limit: 1 });
    await storage.search({ query: 'x', userId: OTHER, drawers: [...OPEN, { kind: 'project', key: 'beta' }, { kind: 'people', key: 'sam' }], limit: 1 });
  }
  process.env.GIRRU_STORE_P9 = '0';
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NULL').get().n, 0);
});

test('the recall index returns the same memories, scores and order as the full-row path', async () => {
  for (const query of QUERIES) {
    for (const extra of [{}, { limit: 25 }, { type: 'skill' }, { minImportanceScore: 0.5 }, { layer: 'working' }]) {
      const { off, on, again } = await both({ query, userId: OWNER, drawers: OPEN, limit: 10, ...extra });
      assert.deepEqual(on, off, `${query} ${JSON.stringify(extra)}`);
      assert.deepEqual(again, off, `${query} (warm)`);
    }
  }
  const { off, on } = await both({ query: 'deploy', userId: OWNER, drawers: [], limit: 10 });
  assert.deepEqual(on, off);
  assert.equal(on.length, 0);
  // Never another user's memories.
  const other = await both({ query: 'deploy server note', userId: OTHER, drawers: OPEN, limit: 50 });
  assert.deepEqual(other.on, other.off);
  assert.ok(other.on.every((r) => Number(r.id.slice(2)) % 10 === 9));
});

test('an edit, a delete and a replaced fact are seen by the next search', async () => {
  const q = { query: 'zebra unicorn', userId: OWNER, drawers: OPEN, limit: 10 };
  process.env.GIRRU_STORE_P9 = '1';
  assert.equal((await storage.search(q)).length, 0);
  db.prepare("UPDATE memories SET content = 'zebra unicorn deploy', embedding = ?, embedding_vec = NULL WHERE id = 'm-0000'")
    .run(JSON.stringify(hashEmbed(normalizeMemoryText('zebra unicorn deploy'))));
  const first = await storage.search(q);
  assert.deepEqual(first.map((r) => r.memory.id), ['m-0000']);
  db.prepare("UPDATE memories SET status = 'replaced' WHERE id = 'm-0000'").run();
  assert.equal((await storage.search(q)).length, 0);
  db.prepare("UPDATE memories SET status = 'active' WHERE id = 'm-0000'").run();
  assert.equal((await storage.search(q)).length, 1);
  db.prepare("DELETE FROM memories WHERE id = 'm-0000'").run();
  assert.equal((await storage.search(q)).length, 0);
  const off = (process.env.GIRRU_STORE_P9 = '0', shape(await storage.search({ ...q, query: 'deploy server' })));
  process.env.GIRRU_STORE_P9 = '1';
  assert.deepEqual(shape(await storage.search({ ...q, query: 'deploy server' })), off);
  process.env.GIRRU_STORE_P9 = '0';
});

test('forget drops the user index; a gone row leaves its drawer entry list on the next search', async () => {
  process.env.GIRRU_STORE_P9 = '1';
  forgetRecallIndex();
  await storage.search({ query: 'deploy', userId: OWNER, drawers: OPEN, limit: 5 });
  const before = recallIndexStats();
  assert.ok(before.entries > 100);
  db.prepare("DELETE FROM memories WHERE id = 'm-0001'").run(); // project alpha
  await storage.search({ query: 'deploy', userId: OWNER, drawers: OPEN, limit: 5 });
  assert.equal(recallIndexStats().entries, before.entries - 1);
  const live = db.prepare("SELECT id FROM memories WHERE user_id = ? AND drawer_kind = 'owner' LIMIT 1").get(OWNER);
  db.prepare(`INSERT INTO memory_versions (id, memory_id, user_id, drawer_kind, drawer_key, drawer_revision, version, change, type, content, created_by, created_at)
    VALUES ('v-p9', ?, ?, 'owner', '', 1, 1, 'create', 'fact', 'x', ?, ?)`).run(live.id, OWNER, OWNER, new Date().toISOString());
  assert.ok(await forgetMemory(OWNER, live.id, OWNER));
  assert.equal(recallIndexStats().users, 0);
  process.env.GIRRU_STORE_P9 = '0';
});

test('past the size cap nothing more is kept and recall still matches', async () => {
  process.env.GIRRU_STORE_P9 = '1';
  process.env.GIRRU_RECALL_INDEX_MB = '0';
  forgetRecallIndex();
  const on = shape(await storage.search({ query: 'invoice customer', userId: OWNER, drawers: OPEN, limit: 10 }));
  assert.equal(recallIndexStats().entries, 0);
  process.env.GIRRU_STORE_P9 = '0';
  delete process.env.GIRRU_RECALL_INDEX_MB;
  assert.deepEqual(on, shape(await storage.search({ query: 'invoice customer', userId: OWNER, drawers: OPEN, limit: 10 })));
});
