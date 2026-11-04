// STORE-MAP-01 P0 baseline: recall quality (A1, M5).
// The P0 recall set (recall-set-p0.json) is hidden among synthetic
// distractor memories and searched with the app's own ranking
// (MemoryStorage.search, the core of chat recall and the memory_search tool),
// as an owner chat with project 'alpha' open.
// Reports hit@5, rank and MRR per language, no-answer behaviour, leaks and
// stale facts.
// Run from packages/backend:
//   node --import tsx scripts/memory-baseline/recall.mjs --mode hash|ollama [--distractors 5000] [--out file.json] [--p9b]
// P9b: --p9b searches with the reply recall of the quality engine instead
// (memory/quality/recall.ts: intent, re-rank, "no reliable memory" = empty).
import { backendDir, addUser, argValue, cleanup, ollamaHas, openDb, quietly } from './env.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticMemories } from './corpus.mjs';

const mode = argValue('mode', 'hash');
const distractors = Number(argValue('distractors', '5000'));
const out = argValue('out', null);
const p9b = process.argv.includes('--p9b');
if (p9b) process.env.GIRRU_STORE_P9B = '1';
if (mode === 'ollama' && !(await ollamaHas('qwen3-embedding:0.6b'))) {
  console.error('qwen3-embedding:0.6b is not available on the local Ollama; nothing measured');
  process.exit(2);
}
process.env.MEMORY_EMBEDDINGS = mode;
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';

const SET = JSON.parse(readFileSync(join(backendDir, 'scripts/memory-baseline/recall-set-p0.json'), 'utf-8'));
const OWNER = 'p0-owner';
const OTHER = 'other-user';

const { db, closeDatabase } = await openDb();
addUser(db, OWNER, 'owner');
addUser(db, OTHER, 'user');
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const { getEmbeddingService } = await import(join(backendDir, 'src/memory/embedding.ts'));
const D = await import(join(backendDir, 'src/memory/drawers.ts'));
const storage = getMemoryStorage();
await quietly(() => storage.initialize());
const emb = getEmbeddingService();

const parseDrawer = (s) => {
  const [kind, key] = s.split(':');
  return key ? { kind, key } : { kind };
};

// 1. Distractors: bulk rows with the app's own vectors (no markdown copies).
const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims,
  memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?)`);
const t0 = Date.now();
const rows = [...syntheticMemories(distractors, 11)];
const BATCH = mode === 'ollama' ? 64 : 1000;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const vecs = await quietly(() => emb.embedManyDetailed(chunk.map((r) => r.content)));
  if (mode === 'ollama' && vecs.some((v) => v.model === 'hash-v2')) throw new Error('Ollama fell back to the hash model during seeding');
  db.transaction(() => {
    chunk.forEach((r, j) => insert.run(`d-${i + j}`, OWNER, r.type, r.content, JSON.stringify(vecs[j].vector), vecs[j].model,
      vecs[j].dims, r.createdAt, r.drawerKind, r.drawerKey));
  });
}
const seedMs = Date.now() - t0;

// 2. The test memories through the app's normal save path.
async function save(id, content, drawer, user = OWNER, createdAt = '2026-06-01T09:00:00Z') {
  await quietly(() => storage.save({
    id, userId: user, type: 'fact', content, drawer: parseDrawer(drawer), memoryLayer: 'factual',
    importanceScore: 0.5, status: 'active', metadata: {}, createdAt: new Date(createdAt), accessCount: 0, expiryTimestamp: null,
  }));
}
for (const h of SET.hit) await save(h.id, h.content, h.drawer);
for (const l of SET.leak) await save(l.id, l.content, l.drawer, l.user === 'other-user' ? OTHER : OWNER);
for (const s of SET.stale) {
  await save(`${s.id}-old`, s.old.content, s.drawer, OWNER, s.old.createdAt);
  await save(`${s.id}-new`, s.new.content, s.drawer, OWNER, s.new.createdAt);
}

const OPEN = D.selectDrawers({ audience: 'owner', project: 'alpha' });
const timings = [];
const bests = [];
const engine = p9b ? await import(join(backendDir, 'src/memory/quality/recall.ts')) : null;
async function search(q, limit = 50) {
  const t = performance.now();
  let res;
  if (engine) {
    const r = await quietly(() => engine.qualityRecall({ userId: OWNER, drawers: OPEN, query: q, limit }));
    bests.push({ q, best: +r.best.toFixed(3), reliable: r.reliable, intent: r.intent, fellBack: r.fellBack, rerankMs: r.rerankMs });
    res = r.items.map((x) => ({ memory: x.memory, similarity: x.score }));
  } else {
    res = await quietly(() => storage.search({ query: q, userId: OWNER, drawers: OPEN, limit }));
  }
  timings.push(performance.now() - t);
  return res;
}

// 3. Hits: rank of the target (1-based; 0 = not in the top 50).
const hits = [];
for (const h of SET.hit) {
  for (const q of h.queries) {
    const res = await search(q.q);
    const rank = res.findIndex((r) => r.memory.id === h.id) + 1;
    hits.push({ id: h.id, memLang: h.lang, qLang: q.lang, cross: h.lang !== q.lang, rank, top: res[0]?.memory.id });
  }
}
function summarize(list) {
  const n = list.length;
  const at5 = list.filter((x) => x.rank > 0 && x.rank <= 5).length;
  const at1 = list.filter((x) => x.rank === 1).length;
  const mrr = list.reduce((s, x) => s + (x.rank > 0 ? 1 / x.rank : 0), 0) / (n || 1);
  const found = list.filter((x) => x.rank > 0).map((x) => x.rank).sort((a, b) => a - b);
  return { n, hitAt1: +(at1 / n).toFixed(3), hitAt5: +(at5 / n).toFixed(3), mrr: +mrr.toFixed(3), medianRank: found.length ? found[Math.floor(found.length / 2)] : null, missedTop50: n - found.length };
}
const byQueryLang = {};
for (const lang of ['en', 'ar', 'iq']) byQueryLang[lang] = summarize(hits.filter((x) => x.qLang === lang && !x.cross));
const sameLang = summarize(hits.filter((x) => !x.cross));
const crossLang = summarize(hits.filter((x) => x.cross));

// 4. No-answer: a pass is an empty result (the app has no "not in memory" signal).
const noAnswer = [];
for (const n of SET.no_answer) {
  const res = await search(n.q, 5);
  noAnswer.push({ id: n.id, lang: n.lang, returned: res.length, topScore: +(res[0]?.similarity ?? 0).toFixed(3) });
}

// 5. Leaks: the memory must never appear for this context.
const leaks = [];
for (const l of SET.leak) {
  const res = await search(l.q, 50);
  const rank = res.findIndex((r) => r.memory.id === l.id) + 1;
  leaks.push({ id: l.id, drawer: l.user ? `${l.user}/${l.drawer}` : l.drawer, leaked: rank > 0, rank });
}

// 6. Stale: the current fact must rank above the old one.
const stale = [];
for (const s of SET.stale) {
  const res = await search(s.q, 50);
  const rOld = res.findIndex((r) => r.memory.id === `${s.id}-old`) + 1;
  const rNew = res.findIndex((r) => r.memory.id === `${s.id}-new`) + 1;
  stale.push({ id: s.id, lang: s.lang, rankNew: rNew, rankOld: rOld, currentWins: rNew > 0 && (rOld === 0 || rNew < rOld), oldInTop5: rOld > 0 && rOld <= 5 });
}

// 7. Coding-app path (M5): it gets the fixed memory pack, no recall by query
// (chat.ts subscription branch). How many hit targets are in that pack?
let codingAppPack = null;
try {
  const { contextPack } = await import(join(backendDir, 'src/memory/context/pack.ts'));
  const pack = (await quietly(() => contextPack({ userId: OWNER, drawers: OPEN, persona: '', scopeFacts: null, handoff: null }))).text;
  const inPack = SET.hit.filter((h) => pack.includes(h.content.slice(0, 40))).length;
  codingAppPack = { chars: pack.length, targetsInPack: inPack, targets: SET.hit.length };
} catch (err) { codingAppPack = { error: String(err?.message ?? err) }; }

const sorted = [...timings].sort((a, b) => a - b);
const report = {
  set: SET.version, mode, engine: p9b ? 'p9b quality recall' : 'storage.search', embeddingModel: emb.targetModel(), distractors, seedMs,
  context: 'owner chat, drawers owner + experience + project:alpha',
  hits: { sameLanguage: sameLang, crossLanguage: crossLang, byQueryLanguage: byQueryLang, misses: hits.filter((x) => !(x.rank > 0 && x.rank <= 5)), ranks: hits.map((x) => `${x.id}:${x.qLang}:${x.rank}`) },
  noAnswer: { n: noAnswer.length, correctEmpty: noAnswer.filter((x) => x.returned === 0).length, rows: noAnswer },
  leaks: { n: leaks.length, leaked: leaks.filter((x) => x.leaked).length, rows: leaks },
  stale: { n: stale.length, currentWins: stale.filter((x) => x.currentWins).length, oldStillInTop5: stale.filter((x) => x.oldInTop5).length, rows: stale },
  codingAppPack,
  ...(p9b ? { p9b: { fellBack: bests.filter((b) => b.fellBack).length, rerankMsMax: Math.max(...bests.map((b) => b.rerankMs)), bests } } : {}),
  searchMs: { queries: sorted.length, p50: +sorted[Math.floor(sorted.length * 0.5)].toFixed(1), p95: +sorted[Math.ceil(sorted.length * 0.95) - 1].toFixed(1) },
};
console.log(JSON.stringify(report, null, 2));
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
closeDatabase();
cleanup();
