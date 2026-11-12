// MEM-SPEED-01: the memory search playground (internal; docs/internal/memory-search-playground.md).
// A local page to generate test memories of a chosen size, search them with the app's own
// MemoryStorage.search, see where the time goes, run the benchmark and keep every result
// in docs/internal/memory-search-results.json (the page shows the difference to the last run).
//
// Run from packages/backend:
//   node --max-old-space-size=32768 --import tsx scripts/memory-baseline/playground.mjs [--port 41890]
// then open http://127.0.0.1:41890
//
// Safety: like every memory-baseline script it works in a new throwaway data folder (env.mjs:
// own database, HOME and test-only secrets, loopback network only, the app ports refused), so
// the owner's real memory is never read or written. It listens on 127.0.0.1 only and answers
// only requests whose Host is that address. The folder is deleted when it stops (Ctrl+C).
import { backendDir, moduleUrl, addUser, argValue, cleanup, ollamaHas, openDb, percentile, quietly } from './env.mjs';
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rng, syntheticMemories } from './corpus.mjs';
import { appendResult, readResults, searchSettings, machineInfo, gitInfo } from './results.mjs';

const PORT = Number(argValue('port', '41890'));
const SEM_MODEL = 'qwen3-embedding:0.6b';
const OWNER = 'pg-owner';
const OTHER = 'pg-other';
process.env.GIRRU_STORE_P9 = '1';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
const ollama = await ollamaHas(SEM_MODEL);
process.env.MEMORY_EMBEDDINGS = ollama ? 'ollama' : 'hash';

const { db, closeDatabase } = await openDb();
addUser(db, OWNER, 'owner');
addUser(db, OTHER, 'owner');
const { getMemoryStorage } = await import(moduleUrl(backendDir, 'src/memory/storage.ts'));
const E = await import(moduleUrl(backendDir, 'src/memory/embedding.ts'));
const { normalizeMemoryText } = await import(moduleUrl(backendDir, 'src/memory/text-normalize.ts'));
const { packVector } = await import(moduleUrl(backendDir, 'src/memory/vectors.ts'));
const D = await import(moduleUrl(backendDir, 'src/memory/drawers.ts'));
const { forgetRecallIndex } = await import(moduleUrl(backendDir, 'src/memory/recall-index.ts'));
const { recallStoreStats } = await import(moduleUrl(backendDir, 'src/memory/recall-store.ts'));
const storage = getMemoryStorage();
await quietly(() => storage.initialize());
const emb = E.getEmbeddingService();

const SET = JSON.parse(readFileSync(join(backendDir, 'scripts/memory-baseline/recall-set-p0.json'), 'utf-8'));
const PAGE = join(backendDir, '..', '..', 'docs', 'internal', 'memory-search-playground.html');
const DRAWER_PRESETS = {
  'owner + project alpha': D.selectDrawers({ audience: 'owner', project: 'alpha' }),
  'owner only': [{ kind: 'owner' }],
  'project alpha only': [{ kind: 'project', key: 'alpha' }],
};
const MODES = {
  auto: {}, // the defaults: exact under 50k, HNSW from 20k per drawer
  exact: { GIRRU_RECALL_EXACT_MAX: '1000000000', GIRRU_RECALL_ANN_MIN: '1000000000' },
  int8: { GIRRU_RECALL_EXACT_MAX: '0', GIRRU_RECALL_ANN_MIN: '1000000000' },
  hnsw: { GIRRU_RECALL_ANN_MIN: '0' },
  'old P9 scan': { GIRRU_RECALL_STORE: '0' }, // before MEM-SPEED-01: reads every row of the open drawers
};

// Test-set targets: query text -> expected memory id (hit) or 'none' (no_answer).
const expected = new Map();
for (const h of SET.hit) for (const q of h.queries) expected.set(q.q, h.id);
for (const n of SET.no_answer) expected.set(n.q, 'none');
for (const l of SET.leak) expected.set(l.q, `leak:${l.id}`);
for (const s of SET.stale) expected.set(s.q, `${s.id}-new`);
const suggestions = [
  ...SET.hit.flatMap((h) => h.queries.map((q) => ({ q: q.q, lang: q.lang, kind: 'hit', target: h.id }))),
  ...SET.no_answer.map((n) => ({ q: n.q, lang: n.lang, kind: 'no answer', target: null })),
  ...SET.leak.map((l) => ({ q: l.q, lang: l.lang, kind: 'leak check', target: null })),
  ...SET.stale.map((s) => ({ q: s.q, lang: s.lang, kind: 'current fact', target: `${s.id}-new` })),
];

const state = { size: 0, vectors: null, jsonStub: false, seeding: null, seedMs: null, error: null, mode: 'auto', lastSearch: null };

function setMode(mode) {
  if (!MODES[mode]) throw new Error(`unknown mode ${mode}`);
  for (const k of ['GIRRU_RECALL_EXACT_MAX', 'GIRRU_RECALL_ANN_MIN', 'GIRRU_RECALL_STORE']) delete process.env[k];
  Object.assign(process.env, MODES[mode]);
  process.env.GIRRU_STORE_P9 = '1';
  if (mode !== state.mode) forgetRecallIndex(); // the next search builds the index for this mode (cold)
  state.mode = mode;
}

const parseDrawer = (s) => { const [kind, key] = s.split(':'); return key ? { kind, key } : { kind }; };
async function save(id, content, drawer, user = OWNER, createdAt = '2026-06-01T09:00:00Z') {
  await quietly(() => storage.save({
    id, userId: user, type: 'fact', content, drawer: parseDrawer(drawer), memoryLayer: 'factual', importanceScore: 0.5,
    status: 'active', metadata: {}, createdAt: new Date(createdAt), accessCount: 0, expiryTimestamp: null,
  }));
}

const yieldNow = () => new Promise((r) => setImmediate(r));

async function seed({ size, vectors, jsonStub }) {
  if (state.seeding) throw new Error('already generating');
  size = Math.max(0, Math.min(10_000_000, Math.floor(Number(size) || 0)));
  if (!['random', 'real', 'hash'].includes(vectors)) throw new Error('vectors: random | real | hash');
  if (vectors === 'real' && !ollama) throw new Error(`${SEM_MODEL} is not available on the local Ollama`);
  if (vectors === 'real' && size > 50_000) throw new Error('real vectors: at most 50,000 (the local model embeds about 100-300 a second)');
  if (vectors === 'random' && !ollama) throw new Error('random semantic vectors need the local model for the query; use hash');
  state.seeding = { done: 0, total: size, phase: 'clearing' };
  state.error = null;
  const t0 = Date.now();
  try {
    forgetRecallIndex();
    db.exec('DELETE FROM memories');
    forgetRecallIndex();
    state.seeding.phase = 'test set (real model)';
    for (const h of SET.hit) await save(h.id, h.content, h.drawer);
    for (const l of SET.leak) await save(l.id, l.content, l.drawer, l.user === 'other-user' ? OTHER : OWNER);
    for (const s of SET.stale) { await save(`${s.id}-old`, s.old.content, s.drawer, OWNER, s.old.createdAt); await save(`${s.id}-new`, s.new.content, s.drawer, OWNER, s.new.createdAt); }
    state.seeding.phase = 'distractors';
    const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims,
      memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key, embedding_vec)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?, ?)`);
    const r = rng(99);
    const randomVec = () => {
      const v = new Float32Array(1024); let n = 0;
      for (let i = 0; i < 1024; i++) { v[i] = r() - 0.5; n += v[i] * v[i]; }
      n = Math.sqrt(n); for (let i = 0; i < 1024; i++) v[i] /= n;
      return v;
    };
    const BATCH = vectors === 'real' ? 64 : 5000;
    let batch = [];
    let i = 0;
    const flush = async () => {
      const rows = batch; batch = [];
      let vecs;
      if (vectors === 'real') {
        vecs = (await quietly(() => emb.embedManyDetailed(rows.map((m) => m.content)))).map((e) => [JSON.stringify(e.vector), e.model, e.dims, packVector(e.vector)]);
      } else if (vectors === 'hash') {
        vecs = rows.map((m) => { const v = E.hashEmbed(normalizeMemoryText(m.content)); return [JSON.stringify(v), E.HASH_MODEL, E.HASH_DIMS, packVector(v)]; });
      } else {
        vecs = rows.map(() => { const v = randomVec(); return [jsonStub ? '[0]' : JSON.stringify(Array.from(v, (x) => +x.toFixed(9))), `ollama:${SEM_MODEL}`, 1024, Buffer.from(v.buffer)]; });
      }
      db.transaction(() => { rows.forEach((m, j) => insert.run(m.id, OWNER, m.type, m.content, vecs[j][0], vecs[j][1], vecs[j][2], m.createdAt, m.drawerKind, m.drawerKey, vecs[j][3])); });
      state.seeding.done += rows.length;
      await yieldNow();
    };
    for (const m of syntheticMemories(size, 23)) {
      batch.push({ ...m, id: `d-${i++}` });
      if (batch.length >= BATCH) await flush();
    }
    if (batch.length) await flush();
    state.seeding.phase = 'checkpoint';
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    forgetRecallIndex();
    Object.assign(state, { size, vectors, jsonStub: vectors === 'random' && !!jsonStub, seedMs: Date.now() - t0 });
  } catch (e) {
    state.error = String(e?.message || e);
  } finally {
    state.seeding = null;
  }
}

function dataInfo() {
  const drawers = db.prepare(`SELECT COALESCE(drawer_kind, 'owner') AS k, COALESCE(drawer_key, '') AS key, COUNT(*) AS n FROM memories WHERE user_id = ? GROUP BY 1, 2 ORDER BY n DESC LIMIT 12`).all(OWNER);
  let dbMB = null;
  try { dbMB = +(statSync(process.env.DATABASE_PATH).size / 1e6).toFixed(1); } catch { /* not yet */ }
  return { rows: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, drawers, dbMB };
}

async function search({ query, limit = 5, drawers = 'owner + project alpha', mode = 'auto' }) {
  if (state.seeding) throw new Error('still generating data');
  query = String(query || '').slice(0, 500);
  if (!query.trim()) throw new Error('empty query');
  limit = Math.max(1, Math.min(50, Number(limit) || 5));
  const open = DRAWER_PRESETS[drawers];
  if (!open) throw new Error('unknown drawers');
  setMode(mode);
  const extra = {};
  const before = recallStoreStats();
  const tE = performance.now();
  await quietly(() => emb.embedQuery(query)); // cached afterwards: search() below gets it from the cache
  const embedMs = performance.now() - tE;
  const t0 = performance.now();
  const results = await quietly(() => storage.search({ query, userId: OWNER, drawers: open, limit: 50, ...extra }));
  const searchMs = performance.now() - t0;
  const after = recallStoreStats();
  const target = expected.get(query) ?? null;
  const rank = target && !target.startsWith('leak:') && target !== 'none' ? results.findIndex((r) => r.memory.id === target) + 1 : null;
  const leaked = target?.startsWith('leak:') ? results.slice(0, limit).some((r) => r.memory.id === target.slice(5)) : null;
  const out = {
    query, mode, drawers, limit,
    embedMs: +embedMs.toFixed(1), searchMs: +searchMs.toFixed(1), totalMs: +(embedMs + searchMs).toFixed(1),
    cold: after.entries !== before.entries || before.users === 0,
    target, rank, leaked, noAnswerReturned: target === 'none' ? Math.min(limit, results.length) : null,
    hits: results.slice(0, limit).map((r) => ({
      id: r.memory.id, drawer: r.memory.drawer ? `${r.memory.drawer.kind}${r.memory.drawer.key ? `:${r.memory.drawer.key}` : ''}` : '',
      layer: r.memory.memoryLayer, score: +r.similarity.toFixed(4), vector: +(r.scoreBreakdown?.vectorScore ?? 0).toFixed(4),
      keyword: +(r.scoreBreakdown?.keywordScore ?? 0).toFixed(4), content: String(r.memory.content).slice(0, 240),
      test: r.memory.id.startsWith('d-') ? null : r.memory.id,
    })),
    index: after,
    rssMB: Math.round(process.memoryUsage().rss / 1e6),
  };
  state.lastSearch = { query, totalMs: out.totalMs };
  return out;
}

async function bench({ mode = 'auto', drawers = 'owner + project alpha', label = '', record = true, n = 20 }) {
  if (state.seeding) throw new Error('still generating data');
  if (!state.size && !dataInfo().rows) throw new Error('generate data first');
  setMode(mode);
  forgetRecallIndex();
  const qs = SET.hit.flatMap((h) => h.queries.map((q) => q.q)).slice(0, Math.max(1, Math.min(72, n)));
  const tc = performance.now();
  await search({ query: 'warm up', mode, drawers });
  const coldMs = +(performance.now() - tc).toFixed(1);
  const times = [], embeds = [];
  let hit5 = 0, rr = 0, peak = 0;
  for (const q of qs) {
    E.clearEmbeddingCache?.(); // measure the embedding every time, as a fresh question would
    const r = await search({ query: q, mode, drawers, limit: 5 });
    times.push(r.totalMs); embeds.push(r.embedMs);
    if (r.rank && r.rank <= 5) hit5++;
    if (r.rank) rr += 1 / r.rank;
    peak = Math.max(peak, r.rssMB);
  }
  const stats = recallStoreStats();
  const run = {
    source: 'playground', label: label || `playground ${mode}`, size: state.size, vectors: state.vectors, jsonStub: state.jsonStub,
    openedRows: null, queries: qs.length, mode, drawersPreset: drawers,
    searchMs: { p50: +percentile(times, 50).toFixed(1), p95: +percentile(times, 95).toFixed(1), max: +Math.max(...times).toFixed(1) },
    queryEmbedMs: { p50: +percentile(embeds, 50).toFixed(1), p95: +percentile(embeds, 95).toFixed(1) },
    coldMs, peakRssMB: peak, indexMB: Math.round(stats.bytes / 1e6), drawers: stats.drawers, dbMB: dataInfo().dbMB,
    quality: { hitAt5: +(hit5 / qs.length).toFixed(3), mrr: +(rr / qs.length).toFixed(3) }, settings: { ...searchSettings(), mode },
  };
  return record ? appendResult(backendDir, run) : run;
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const host = String(req.headers.host || '');
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return json(res, 403, { error: 'loopback only' });
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(readFileSync(PAGE));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      return json(res, 200, {
        ...state, data: state.seeding ? null : dataInfo(), ollama, embeddingModel: ollama ? `ollama:${SEM_MODEL}` : E.HASH_MODEL,
        index: recallStoreStats(), rssMB: Math.round(process.memoryUsage().rss / 1e6), heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
        machine: machineInfo(), git: gitInfo(backendDir), modes: Object.keys(MODES), drawerPresets: Object.keys(DRAWER_PRESETS),
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/suggestions') return json(res, 200, suggestions);
    if (req.method === 'GET' && url.pathname === '/api/results') return json(res, 200, readResults(backendDir));
    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'json only' });
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 100_000) return json(res, 413, { error: 'too large' }); }
      const input = body ? JSON.parse(body) : {};
      if (url.pathname === '/api/seed') { seed(input); return json(res, 202, { started: true }); }
      if (url.pathname === '/api/search') return json(res, 200, await search(input));
      if (url.pathname === '/api/bench') return json(res, 200, await bench(input));
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 400, { error: String(e?.message || e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Memory search playground: http://127.0.0.1:${PORT}  (throwaway data; Ctrl+C stops and deletes it)`);
  console.log(`Embedding: ${ollama ? `ollama:${SEM_MODEL}` : 'hash fallback (Ollama model not found)'}`);
});
const stop = () => { server.close(); try { closeDatabase(); } catch { /* closed */ } cleanup(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
