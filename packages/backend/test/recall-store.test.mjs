// MEM-SPEED-01: the recall store kept in step by id (recall-store.ts).
//  - the top-k heap gives the same hits and order as a full sort (ties by created_at, id);
//  - int8 (+ Float32 re-score) and HNSW (+ re-score) give the same top results as Float32;
//  - the drawer modes really switch (exact / i8 / ann);
//  - an edit, a delete and a replaced fact leave the HNSW index; forget drops the store.
// Run: node --import tsx --test test/recall-store.test.mjs
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
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-recall-store-')));
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
process.env.GIRRU_RECALL_ANN_THREADS = '1'; // the same HNSW graph on every run
for (const k of ['GIRRU_STORE_P9', 'GIRRU_RECALL_INDEX_MB', 'GIRRU_RECALL_EXACT_MAX', 'GIRRU_RECALL_ANN_MIN', 'GIRRU_RECALL_RESCORE']) clearEnv(k);
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const OWNER = 'rs-owner';
const OTHER = 'rs-other';
for (const u of [OWNER, OTHER]) db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', 'owner', 'active')`).run(u, `${u}@example.test`, u);
const S = await load('src/memory/recall-store.ts');
const { forgetRecallIndex } = await load('src/memory/recall-index.ts');
const { packVector } = await load('src/memory/vectors.ts');

// A "semantic" test model: 64-dim unit vectors around a few topics, so neighbours are real.
const MODEL = 'test-semantic';
const DIMS = 64;
let seed = 11; // mulberry32: a short-period LCG repeated vectors (exact ties)
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const TOPICS = Array.from({ length: 12 }, () => unit(Array.from({ length: DIMS }, () => rnd() - 0.5)));
const WORDS = ['deploy', 'server', 'invoice', 'customer', 'meeting', 'design', 'database', 'login', 'payment', 'backup'];
const near = (base, noise) => unit(base.map((x) => x + (rnd() - 0.5) * noise));
const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims, embedding_vec,
  memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
  VALUES (?, ?, 'fact', ?, ?, ?, ?, ?, ?, 'active', '{}', 0.5, ?, 0, ?, ?)`);
const vecs = new Map();
const N = 3000;
for (let i = 0; i < N; i++) {
  const v = near(TOPICS[i % TOPICS.length], 1.2);
  const id = `r-${String(i).padStart(5, '0')}`;
  vecs.set(id, v);
  const content = Array.from({ length: 3 + Math.floor(rnd() * 8) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ') + ` item ${i}`;
  const [kind, key] = i % 3 === 0 ? ['project', 'alpha'] : ['owner', null];
  insert.run(id, i % 20 === 19 ? OTHER : OWNER, content, JSON.stringify(v), MODEL, DIMS, packVector(v),
    i % 17 === 0 ? 'working' : 'factual', new Date(Date.UTC(2026, 0, 1, 0, i % 90)).toISOString(), kind, key);
}
const OPEN = [{ kind: 'owner' }, { kind: 'project', key: 'alpha' }];
const QUERIES = Array.from({ length: 30 }, (_, i) => {
  const target = `r-${String((i * 97) % N).padStart(5, '0')}`;
  return { text: i % 2 ? `${WORDS[i % WORDS.length]} item` : 'nothing in common', vector: near(vecs.get(target), 0.15) };
});

async function run(env, query, limit = 5, extra = {}) {
  for (const k of ['GIRRU_RECALL_EXACT_MAX', 'GIRRU_RECALL_ANN_MIN']) delete process.env[k];
  Object.assign(process.env, env);
  forgetRecallIndex();
  const open = await S.openStore(OWNER, OPEN);
  assert.ok(open, 'the store serves the search');
  const hits = S.searchStore(OWNER, open, { userId: OWNER, query: query.text, drawers: OPEN, limit, ...extra },
    { vector: query.vector, model: MODEL, dims: DIMS, semantic: true });
  return { hits, stats: S.recallStoreStats() };
}

test('the top-k heap gives the same hits and order as a full sort (ties by created_at, id)', () => {
  const n = 2000;
  const u = { created: [], ids: [] };
  const sims = [];
  for (let i = 0; i < n; i++) {
    u.created.push(new Date(Date.UTC(2026, 0, 1, 0, Math.floor(rnd() * 40))).toISOString());
    u.ids.push(`x-${Math.floor(rnd() * 1e6)}-${i}`);
    sims.push(Math.round(rnd() * 50) / 50); // many equal scores
  }
  const order = (a, b) => (sims[b] - sims[a]) || (u.created[a] < u.created[b] ? -1 : u.created[a] > u.created[b] ? 1 : 0) || (u.ids[a] < u.ids[b] ? -1 : 1);
  const full = [...Array(n).keys()].sort(order);
  for (const k of [1, 5, 10, 50, 300, 2500]) {
    const top = new S.TopK(k, u);
    for (let i = 0; i < n; i++) top.push(i, sims[i], i);
    assert.deepEqual(top.sorted().map((h) => h.slot), full.slice(0, k), `k=${k}`);
    assert.ok(top.sorted().every((h) => h.value === h.slot), 'the payload travels with its slot');
  }
});

test('int8 and HNSW (each re-scored with Float32) give the same top results as Float32', async () => {
  let same = 0;
  for (const q of QUERIES) {
    const exact = await run({}, q);
    assert.equal(exact.stats.drawers.exact, 2);
    const i8 = await run({ GIRRU_RECALL_EXACT_MAX: '0', GIRRU_RECALL_ANN_MIN: '1000000' }, q);
    assert.equal(i8.stats.drawers.i8, 2);
    const ann = await run({ GIRRU_RECALL_ANN_MIN: '0' }, q);
    assert.equal(ann.stats.drawers.ann, 2, 'usearch loads on this platform');
    // Re-scored hits carry the exact Float32 score: same ids, same numbers, same order.
    assert.deepEqual(i8.hits, exact.hits, 'int8');
    if (JSON.stringify(ann.hits) === JSON.stringify(exact.hits)) same++;
    assert.deepEqual(ann.hits.slice(0, 1), exact.hits.slice(0, 1), 'HNSW top hit');
  }
  // HNSW is approximate: the same top 5 for nearly every query (the top hit for all of them).
  assert.ok(same >= QUERIES.length - 1, `HNSW top 5 identical in ${same} of ${QUERIES.length}`);
});

test('filters (type, layer, importance) stay exact in every mode', async () => {
  for (const extra of [{ layer: 'working' }, { minImportance: 0.5 }, { type: 'skill' }]) {
    const exact = await run({}, QUERIES[3], 10, extra);
    const ann = await run({ GIRRU_RECALL_ANN_MIN: '0' }, QUERIES[3], 10, extra);
    assert.deepEqual(ann.hits.map((h) => h.id), exact.hits.map((h) => h.id), JSON.stringify(extra));
  }
});

test('an edit, a delete and a replaced fact leave the HNSW index; another owner is never read; forget drops it', async () => {
  const q = QUERIES[0];
  const env = { GIRRU_RECALL_ANN_MIN: '0' };
  const first = await run(env, q);
  const top = first.hits[0].id;
  // Keep the store between searches from here on.
  const again = async () => {
    const open = await S.openStore(OWNER, OPEN);
    return S.searchStore(OWNER, open, { userId: OWNER, query: q.text, drawers: OPEN, limit: 5 }, { vector: q.vector, model: MODEL, dims: DIMS, semantic: true });
  };
  assert.equal((await again())[0].id, top);
  const before = S.recallStoreStats().entries;
  db.prepare("UPDATE memories SET status = 'replaced' WHERE id = ?").run(top);
  assert.ok(!(await again()).some((h) => h.id === top), 'a replaced fact is gone');
  db.prepare("UPDATE memories SET status = 'active' WHERE id = ?").run(top);
  assert.equal((await again())[0].id, top, 'and back');
  db.prepare('DELETE FROM memories WHERE id = ?').run(top);
  assert.ok(!(await again()).some((h) => h.id === top), 'a deleted memory is gone');
  assert.equal(S.recallStoreStats().entries, before - 1);
  // An edit moves the memory to its new vector.
  const other = first.hits[1].id;
  const far = unit(TOPICS[5].map((x) => -x));
  db.prepare('UPDATE memories SET embedding = ?, embedding_vec = ? WHERE id = ?').run(JSON.stringify(far), packVector(far), other);
  assert.ok(!(await again()).some((h) => h.id === other), 'an edited vector is re-indexed');
  // Never another owner's rows: their memories are not in this store.
  for (const h of await again()) assert.equal(db.prepare('SELECT user_id FROM memories WHERE id = ?').get(h.id).user_id, OWNER);
  forgetRecallIndex(OWNER);
  assert.equal(S.recallStoreStats().users, 0);
});

test('a write by another connection drops the store (data_version)', async () => {
  const { default: Database } = await import('better-sqlite3');
  await run({}, QUERIES[1]);
  assert.equal(S.recallStoreStats().users, 1);
  const second = new Database(process.env.DATABASE_PATH);
  second.prepare("UPDATE memories SET content = content || ' zebraquartz' WHERE id = 'r-00001'").run();
  second.close();
  const open = await S.openStore(OWNER, OPEN);
  assert.ok(open);
  // Rebuilt from the database: the word the other connection added is found.
  const hits = S.searchStore(OWNER, open, { userId: OWNER, query: 'zebraquartz', drawers: OPEN, limit: 5 }, { vector: QUERIES[1].vector, model: MODEL, dims: DIMS, semantic: true });
  assert.ok(hits.some((h) => h.id === 'r-00001' && h.lexical > 0));
});
