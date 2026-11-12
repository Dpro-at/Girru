// MEM-ACC-01: does Girru recall the exact memory for what the owner is talking about?
// The simulated world (accuracy-world.mjs: 10 projects x 10 facts, 15 people, ~1,040 questions
// with known answer ids) is hidden among `--distractors` generated memories, all embedded by the
// real local model (qwen3-embedding:0.6b). Each question is asked from an owner chat with its
// project open (the drawers a chat opens), through two paths:
//   search   MemoryStorage.search (the raw hybrid recall, limit 10)
//   chat     qualityRecall (GIRRU_STORE_P9B: what a chat reply recalls, limit 6, "no reliable memory")
// and scored: Recall@5, Hit@1, Precision@5, wrong-project top hit, temporal (an older fact never
// outranks the current one), no-answer (nothing returned), leaks (a fact of a closed drawer),
// multi-hop (both facts in the top 5), latency. Per kind of question and overall.
//
// Run from packages/backend (local Ollama with qwen3-embedding:0.6b required):
//   node --max-old-space-size=16384 --import tsx scripts/memory-baseline/accuracy.mjs --distractors 100000 \
//     --cache <folder outside the repo> [--out report.json] [--rows rows.json] [--record "label"]
// The distractor embeddings are cached in --cache (generated text only, no private data), so a
// second run does not embed them again.
import { backendDir, moduleUrl, addUser, argValue, cleanup, ollamaHas, openDb, percentile, quietly } from './env.mjs';
import { existsSync, mkdirSync, openSync, readSync, writeSync, closeSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticMemories } from './corpus.mjs';
import { buildWorld, DISTRACTOR_PROJECT_MAP } from './accuracy-world.mjs';

const SEM_MODEL = 'qwen3-embedding:0.6b';
const DIMS = 1024;
const nDistractors = Number(argValue('distractors', '100000'));
const cacheDir = argValue('cache', null);
const out = argValue('out', null);
const rowsOut = argValue('rows', null);
const label = argValue('record', null);
const limitQ = Number(argValue('questions', '0')) || Infinity;
if (!(await ollamaHas(SEM_MODEL))) { console.error(`${SEM_MODEL} is not available on the local Ollama; nothing measured`); process.exit(2); }
if (!cacheDir) { console.error('--cache <folder> is required (distractor embeddings, outside the repo)'); process.exit(2); }
process.env.MEMORY_EMBEDDINGS = 'ollama';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
process.env.GIRRU_STORE_P9 = '1';
process.env.GIRRU_STORE_P9B = '1';

const OWNER = 'acc-owner';
const { db, closeDatabase } = await openDb();
addUser(db, OWNER, 'owner');
const { getMemoryStorage } = await import(moduleUrl(backendDir, 'src/memory/storage.ts'));
const { getEmbeddingService } = await import(moduleUrl(backendDir, 'src/memory/embedding.ts'));
const { packVector } = await import(moduleUrl(backendDir, 'src/memory/vectors.ts'));
const D = await import(moduleUrl(backendDir, 'src/memory/drawers.ts'));
const { qualityRecall } = await import(moduleUrl(backendDir, 'src/memory/quality/recall.ts'));
const storage = getMemoryStorage();
await quietly(() => storage.initialize());
const emb = getEmbeddingService();
const MODEL_ID = `ollama:${SEM_MODEL}`;

async function embedBatch(texts) {
  const r = await quietly(() => emb.embedManyDetailed(texts));
  if (r.some((e) => e.model !== MODEL_ID || e.dims !== DIMS)) throw new Error('the local model fell back to the hash model while embedding');
  return r.map((e) => Float32Array.from(e.vector));
}

const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims,
  memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key, embedding_vec)
  VALUES (?, ?, ?, ?, '[0]', ?, ?, 'factual', ?, '{}', 0.5, ?, 0, ?, ?, ?)`);
const t0 = Date.now();

// 1. Distractors (cached embeddings: <cache>/distractors-<seed>.f32, appended as they are made).
mkdirSync(cacheDir, { recursive: true });
const cacheFile = join(cacheDir, `distractors-23-${SEM_MODEL.replace(/[^a-z0-9.]/gi, '_')}.f32`);
const rowBytes = DIMS * 4;
let cached = existsSync(cacheFile) ? Math.floor(statSync(cacheFile).size / rowBytes) : 0;
const fdR = cached ? openSync(cacheFile, 'r') : null;
const fdW = openSync(cacheFile, 'a');
let embeddedNow = 0;
const BATCH = 128;
let batch = [];
let i = 0;
const drawerOf = (m) => (m.drawerKind === 'project' ? ['project', DISTRACTOR_PROJECT_MAP[m.drawerKey] || m.drawerKey] : [m.drawerKind, m.drawerKey]);
const flush = async () => {
  const rows = batch; batch = [];
  const start = rows[0].n;
  const vecs = new Array(rows.length);
  const have = Math.max(0, Math.min(rows.length, cached - start));
  if (have > 0) {
    const buf = Buffer.alloc(have * rowBytes);
    readSync(fdR, buf, 0, buf.length, start * rowBytes);
    for (let k = 0; k < have; k++) vecs[k] = new Float32Array(buf.buffer.slice(buf.byteOffset + k * rowBytes, buf.byteOffset + (k + 1) * rowBytes));
  }
  if (have < rows.length) {
    const fresh = await embedBatch(rows.slice(have).map((m) => m.content));
    fresh.forEach((v, k) => { vecs[have + k] = v; writeSync(fdW, Buffer.from(v.buffer)); });
    cached += fresh.length; embeddedNow += fresh.length;
  }
  db.transaction(() => {
    rows.forEach((m, k) => {
      const [dk, dkey] = drawerOf(m);
      insert.run(`d-${m.n}`, OWNER, m.type, m.content, MODEL_ID, DIMS, 'active', m.createdAt, dk, dkey, Buffer.from(vecs[k].buffer));
    });
  });
  if (embeddedNow && embeddedNow % 5120 < BATCH) process.stderr.write(`  embedded ${cached.toLocaleString()} / ${nDistractors.toLocaleString()} (${((Date.now() - t0) / 60000).toFixed(1)} min)\n`);
};
for (const m of syntheticMemories(nDistractors, 23)) {
  batch.push({ ...m, n: i++ });
  if (batch.length >= BATCH) await flush();
}
if (batch.length) await flush();
if (fdR !== null) closeSync(fdR);
closeSync(fdW);
const distractorMs = Date.now() - t0;

// 2. The world's facts, embedded by the same model; replaced facts keep status 'replaced' (as Girru marks them).
const world = buildWorld();
const factVecs = [];
for (let k = 0; k < world.facts.length; k += 64) factVecs.push(...await embedBatch(world.facts.slice(k, k + 64).map((f) => f.content)));
db.transaction(() => {
  world.facts.forEach((f, k) => {
    const [dk, dkey] = f.drawer.includes(':') ? f.drawer.split(':') : [f.drawer, null];
    insert.run(f.id, OWNER, 'fact', f.content, MODEL_ID, DIMS, f.status, f.createdAt, dk, dkey, Buffer.from(factVecs[k].buffer));
  });
});
db.exec?.('PRAGMA wal_checkpoint(TRUNCATE)');
const factById = new Map(world.facts.map((f) => [f.id, f]));

// 3. Ask.
const questions = world.questions.slice(0, limitQ);
const rows = [];
const warmDrawers = D.selectDrawers({ audience: 'owner', project: 'falcon' });
const tCold = performance.now();
await quietly(() => storage.search({ query: 'warm up', userId: OWNER, drawers: warmDrawers, limit: 5 }));
const coldMs = +(performance.now() - tCold).toFixed(1);
for (const q of questions) {
  const drawers = D.selectDrawers({ audience: 'owner', project: q.project });
  const open = new Set(drawers.map((d) => `${d.kind}:${d.key || ''}`));
  const tE = performance.now();
  await quietly(() => emb.embedQuery(q.q));
  const embedMs = performance.now() - tE; // the two paths below take the cached vector
  const tS = performance.now();
  const raw = await quietly(() => storage.search({ query: q.q, userId: OWNER, drawers, limit: 10 }));
  const searchMs = performance.now() - tS;
  const tC = performance.now();
  const chat = await quietly(() => qualityRecall({ userId: OWNER, drawers, query: q.q, limit: 6, ask: false }));
  const chatMs = performance.now() - tC;
  rows.push({ q, embedMs, search: { ids: raw.map((r) => r.memory.id), ms: searchMs }, chat: { ids: chat.items.map((it) => it.memory.id), reliable: chat.reliable, ms: chatMs, fellBack: chat.fellBack } });
}

// 4. Score.
const leaksOf = (ids, q) => ids.filter((id) => {
  const f = factById.get(id);
  if (!f) return false;
  const [k, key] = f.drawer.includes(':') ? f.drawer.split(':') : [f.drawer, ''];
  return !new Set(D.selectDrawers({ audience: 'owner', project: q.project }).map((d) => `${d.kind}:${d.key || ''}`)).has(`${k}:${key}`);
}).length;
function score(path) {
  const groups = new Map();
  const g = (k) => { if (!groups.has(k)) groups.set(k, { n: 0, answerable: 0, r5: 0, h1: 0, p5sum: 0, p5n: 0, wrongProject: 0, temporalN: 0, temporalOk: 0, noAnsN: 0, noAnsOk: 0, hopN: 0, hopBoth: 0, leaks: 0, ms: [] }); return groups.get(k); };
  for (const row of rows) {
    const q = row.q, ids = row[path].ids, top5 = ids.slice(0, 5);
    for (const k of ['all', q.kind, ...(q.crossLanguage ? ['cross-language'] : []), ...(q.temporal ? ['temporal'] : [])]) {
      const s = g(k);
      s.n++; s.ms.push(row[path].ms + row.embedMs); s.leaks += leaksOf(ids, q);
      if (q.target) {
        s.answerable++;
        if (top5.includes(q.target)) s.r5++;
        if (ids[0] === q.target) s.h1++;
        if (top5.length) { s.p5sum += top5.filter((id) => q.relevant.includes(id)).length / top5.length; s.p5n++; s.p5max = (s.p5max || 0) + Math.min(5, q.relevant.length) / 5; }
        const top = factById.get(ids[0]);
        if (top && top.project && q.kind !== 'person' && top.project !== q.project) s.wrongProject++;
        if (q.stale.length) {
          s.temporalN++;
          const ti = ids.indexOf(q.target);
          const staleAbove = q.stale.some((st) => { const si = ids.indexOf(st); return si >= 0 && (ti < 0 || si < ti); });
          if (ti >= 0 && ti < 5 && !staleAbove) s.temporalOk++;
        }
        if (q.hops) { s.hopN++; if (q.hops.every((h) => top5.includes(h))) s.hopBoth++; }
      } else {
        s.noAnsN++;
        if (path === 'chat' ? ids.length === 0 : !ids.some((id) => factById.has(id))) s.noAnsOk++;
      }
    }
  }
  const pct = (a, b) => (b ? +(a / b).toFixed(3) : null);
  return Object.fromEntries([...groups].map(([k, s]) => [k, {
    questions: s.n, recallAt5: pct(s.r5, s.answerable), hitAt1: pct(s.h1, s.answerable), precisionAt5: pct(s.p5sum, s.p5n), precisionAt5Ceiling: pct(s.p5max || 0, s.p5n),
    wrongProjectTop: pct(s.wrongProject, s.answerable), temporal: pct(s.temporalOk, s.temporalN), noAnswer: pct(s.noAnsOk, s.noAnsN),
    multiHopBoth: pct(s.hopBoth, s.hopN), leaks: s.leaks,
    ms: { p50: +percentile(s.ms, 50).toFixed(1), p95: +percentile(s.ms, 95).toFixed(1) },
  }]));
}
const embeds = rows.map((r) => r.embedMs);
const report = {
  test: 'MEM-ACC-01', distractors: nDistractors, worldFacts: world.facts.length, questions: rows.length,
  embeddedNow, distractorSeconds: Math.round(distractorMs / 1000), coldMs,
  queryEmbedMs: { p50: +percentile(embeds, 50).toFixed(1), p95: +percentile(embeds, 95).toFixed(1) },
  search: score('search'), chat: score('chat'),
  note: 'ms = query embedding + that path. search: MemoryStorage.search (limit 10). chat: qualityRecall P9B (limit 6; empty = "no reliable memory"). no-answer for search = no world fact returned.',
};
const brief = (s) => `R@5 ${s.recallAt5} · H@1 ${s.hitAt1} · P@5 ${s.precisionAt5}/${s.precisionAt5Ceiling} · wrong-project ${s.wrongProjectTop} · temporal ${s.temporal} · no-answer ${s.noAnswer} · hops ${s.multiHopBoth} · leaks ${s.leaks} · p50 ${s.ms.p50} ms`;
for (const path of ['search', 'chat']) {
  console.log(`\n== ${path}`);
  for (const [k, s] of Object.entries(report[path])) console.log(`${k.padEnd(15)} n=${String(s.questions).padStart(4)}  ${brief(s)}`);
}
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
if (rowsOut) writeFileSync(rowsOut, JSON.stringify(rows.map((r) => ({ id: r.q.id, kind: r.q.kind, lang: r.q.lang, q: r.q.q, target: r.q.target, search: r.search.ids.slice(0, 5), chat: r.chat.ids, reliable: r.chat.reliable })), null, 1));
if (label) {
  const { appendResult, searchSettings } = await import('./results.mjs');
  const c = report.chat.all, s = report.search.all;
  appendResult(backendDir, {
    source: 'accuracy.mjs', kind: 'accuracy', label, size: nDistractors + world.facts.length, vectors: 'real', queries: rows.length,
    searchMs: c.ms, queryEmbedMs: report.queryEmbedMs, coldMs,
    quality: { hitAt5: c.recallAt5, hitAt1: c.hitAt1, precisionAt5: c.precisionAt5, searchRecallAt5: s.recallAt5, noAnswer: c.noAnswer, temporal: c.temporal, wrongProjectTop: c.wrongProjectTop, leaks: c.leaks },
    byKind: Object.fromEntries(Object.entries(report.chat).map(([k, v]) => [k, { recallAt5: v.recallAt5, hitAt1: v.hitAt1, noAnswer: v.noAnswer }])),
    settings: { ...searchSettings(), p9b: true },
  });
}
closeDatabase();
cleanup();
