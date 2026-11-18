// STORE-MAP-01 P0 baseline: recall latency at scale (DB2-7).
// Seeds `--size` synthetic memories for one owner (realistic text, languages
// and drawer split from corpus.mjs) and times MemoryStorage.search for an
// owner chat with project 'alpha' open.
//   --vectors hash      the offline hash-v2 vectors (256 dims), as stored today
//   --vectors semantic  1024-dim vectors shaped like qwen3-embedding output
//                       (JSON text, 9 decimals), tagged with that model; the
//                       query is embedded by the local Ollama model.
// Run from packages/backend (one size per process, so memory is measured alone):
//   node --max-old-space-size=12288 --import tsx scripts/memory-baseline/latency.mjs --size 100000 --vectors hash [--queries 20] [--out f.json]
// P9: --packed also stores the packed Float32 copy (P3, embedding_vec) as a save does
// today; GIRRU_STORE_P9=1 measures the recall index (coldMs = the first search, which
// builds it).
// --record "label" appends the run to docs/internal/memory-search-results.json.
// P9b: --p9b times the reply recall of the quality engine instead (intent,
// fetch of 24 candidates, local re-rank within 300 ms; memory/quality/recall.ts).
import { backendDir, moduleUrl, addUser, argValue, cleanup, ollamaHas, openDb, percentile, quietly } from './env.mjs';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rng, syntheticMemories } from './corpus.mjs';

const size = Number(argValue('size', '10000'));
const vectors = argValue('vectors', 'hash');
const nQueries = Number(argValue('queries', '20'));
const out = argValue('out', null);
const packedVectors = process.argv.includes('--packed');
// --json-stub (with --packed, semantic): the vector is stored only in the packed column (what
// recall reads when it is there) and the JSON column holds '[0]', so 10M rows fit on disk
// (~5 GB per million instead of ~18). The search path is the same: packed wins (row-memory.ts).
const jsonStub = process.argv.includes('--json-stub');
if (jsonStub && !(packedVectors && vectors === 'semantic')) throw new Error('--json-stub needs --packed --vectors semantic');
const SEM_MODEL = 'qwen3-embedding:0.6b';
if (vectors === 'semantic' && !(await ollamaHas(SEM_MODEL))) {
  console.error(`${SEM_MODEL} is not available on the local Ollama; nothing measured`);
  process.exit(2);
}
process.env.MEMORY_EMBEDDINGS = vectors === 'semantic' ? 'ollama' : 'hash';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';

const OWNER = 'p0-owner';
const { db, closeDatabase } = await openDb();
addUser(db, OWNER, 'owner');
const { getMemoryStorage } = await import(moduleUrl(backendDir, 'src/memory/storage.ts'));
const { hashEmbed, HASH_MODEL, HASH_DIMS } = await import(moduleUrl(backendDir, 'src/memory/embedding.ts'));
const { normalizeMemoryText } = await import(moduleUrl(backendDir, 'src/memory/text-normalize.ts'));
const { packVector } = await import(moduleUrl(backendDir, 'src/memory/vectors.ts'));
const D = await import(moduleUrl(backendDir, 'src/memory/drawers.ts'));
const storage = getMemoryStorage();
await quietly(() => storage.initialize());

const r = rng(99);
function semanticPacked() {
  const v = new Float32Array(1024);
  let n = 0;
  for (let i = 0; i < 1024; i++) { v[i] = r() - 0.5; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  for (let i = 0; i < 1024; i++) v[i] /= n;
  return Buffer.from(v.buffer);
}
function semanticVector() {
  const v = new Array(1024);
  let n = 0;
  for (let i = 0; i < 1024; i++) { v[i] = r() - 0.5; n += v[i] * v[i]; }
  n = Math.sqrt(n);
  return `[${v.map((x) => (x / n).toFixed(9)).join(',')}]`;
}

const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims,
  memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key, embedding_vec)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?, ?)`);
const t0 = Date.now();
const drawerCount = {};
let chars = 0;
let batch = [];
let i = 0;
const flush = () => { const rows = batch; batch = []; db.transaction(() => { for (const row of rows) insert.run(...row); }); };
for (const m of syntheticMemories(size, 23)) {
  const stubVec = jsonStub ? semanticPacked() : null;
  const emb = stubVec ? ['[0]', `ollama:${SEM_MODEL}`, 1024]
    : vectors === 'semantic'
    ? [semanticVector(), `ollama:${SEM_MODEL}`, 1024]
    : [JSON.stringify(hashEmbed(normalizeMemoryText(m.content))), HASH_MODEL, HASH_DIMS];
  const vec = stubVec ?? (packedVectors ? packVector(JSON.parse(emb[0])) : null);
  batch.push([`m-${i++}`, OWNER, m.type, m.content, ...emb, m.createdAt, m.drawerKind, m.drawerKey, vec]);
  drawerCount[m.drawerKind] = (drawerCount[m.drawerKind] || 0) + 1;
  chars += m.content.length;
  if (batch.length >= 5000) flush();
}
if (batch.length) flush();
const seedMs = Date.now() - t0;
db.exec?.('PRAGMA wal_checkpoint(TRUNCATE)');
const dbBytes = statSync(process.env.DATABASE_PATH).size;

const OPEN = D.selectDrawers({ audience: 'owner', project: 'alpha' });
const opened = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND (drawer_kind IN ('owner','experience') OR (drawer_kind = 'project' AND drawer_key = 'alpha'))`).get(OWNER).n;

const SET = JSON.parse(readFileSync(join(backendDir, 'scripts/memory-baseline/recall-set-p0.json'), 'utf-8'));
const queries = SET.hit.flatMap((h) => h.queries.map((q) => q.q)).slice(0, nQueries);
const p9b = process.argv.includes('--p9b');
if (p9b) process.env.GIRRU_STORE_P9B = '1';
const engine = p9b ? await import(moduleUrl(backendDir, 'src/memory/quality/recall.ts')) : null;
let fellBack = 0;
const recallOnce = async (q) => {
  if (!engine) return storage.search({ query: q, userId: OWNER, drawers: OPEN, limit: 5 });
  const r = await engine.qualityRecall({ userId: OWNER, drawers: OPEN, query: q, limit: 6 });
  if (r.fellBack) fellBack++;
  return r;
};

// One warm-up query (module load, query embedding model load), not counted.
const tCold = performance.now();
await quietly(() => recallOnce('warm up'));
const coldMs = +(performance.now() - tCold).toFixed(1);
const times = [];
let peakRss = process.memoryUsage().rss;
for (const q of queries) {
  const t = performance.now();
  await quietly(() => recallOnce(q));
  times.push(performance.now() - t);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}
// Query embedding alone (semantic only): the part of the time that is not the scan.
let embedMs = null;
if (vectors === 'semantic') {
  const { getEmbeddingService, clearEmbeddingCache } = await import(moduleUrl(backendDir, 'src/memory/embedding.ts'));
  clearEmbeddingCache();
  const e = [];
  for (const q of queries.slice(0, 10)) { const t = performance.now(); await quietly(() => getEmbeddingService().embedQuery(`${q} ?`)); e.push(performance.now() - t); }
  embedMs = { p50: +percentile(e, 50).toFixed(1), p95: +percentile(e, 95).toFixed(1) };
}

const { recallStoreStats } = await import(moduleUrl(backendDir, 'src/memory/recall-store.ts'));
const store = recallStoreStats();
const report = {
  size, vectors, packed: packedVectors, jsonStub, p9: process.env.GIRRU_STORE_P9 === '1', coldMs, openedRows: opened, drawerSplit: drawerCount, avgChars: Math.round(chars / size), seedMs,
  dbMB: +(dbBytes / 1e6).toFixed(1), engine: p9b ? 'p9b quality recall' : 'storage.search', ...(p9b ? { fellBack } : {}), queries: times.length,
  searchMs: { p50: +percentile(times, 50).toFixed(1), p95: +percentile(times, 95).toFixed(1), max: +Math.max(...times).toFixed(1) },
  queryEmbedMs: embedMs, peakRssMB: Math.round(peakRss / 1e6),
  ...(process.argv.includes('--per-query') ? { perQuery: queries.map((q, i) => [q, +times[i].toFixed(1)]) } : {}),
  index: { entries: store.entries, MB: Math.round(store.bytes / 1e6), drawers: store.drawers,
    exactMax: process.env.GIRRU_RECALL_EXACT_MAX ?? 'default', annMin: process.env.GIRRU_RECALL_ANN_MIN ?? 'default' },
};
console.log(JSON.stringify(report));
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
// --record "label": append to docs/internal/memory-search-results.json (the playground shows it).
const label = argValue('record', null);
if (label) {
  const { appendResult, searchSettings } = await import('./results.mjs');
  appendResult(backendDir, {
    source: 'latency.mjs', label, size, vectors, jsonStub, openedRows: opened, queries: times.length,
    searchMs: report.searchMs, queryEmbedMs: report.queryEmbedMs, coldMs, peakRssMB: report.peakRssMB,
    indexMB: report.index.MB, drawers: report.index.drawers, dbMB: report.dbMB, settings: searchSettings(),
  });
}
closeDatabase();
cleanup();
