// STORE-MAP-01 P9b: offline agent eval (context level, AG7-lite; CX11).
// What an agent's reply gets from memory for each case of the P0 recall set,
// built with the app's own chat functions (contextPack + messageRecall, an
// owner chat with project 'alpha' open), P9b off or on (one mode per process).
// No model answers: each case is scored on the memory the reply would see.
//   grounded   (hit queries) the target fact is in the reply's memory
//   no-answer  (no_answer queries) the reply is told nothing reliable is
//              stored (and to ask once), instead of unrelated lines it might
//              answer from
//   asked once the same no-answer question again says "already asked"
//   current    (stale cases) the current fact is in the memory and comes
//              before the old one (or the old one is left out)
//   trusted    (poisoned cases) an owner fact and a coding tool's
//              contradicting text with the same words: the owner's ranks first
//   no leak    (leak cases) the memory never reaches the reply
// Also: recall characters and Qwen3 tokens per turn (local tokenizer when
// available), and reply recall time p50/p95.
// Run from packages/backend:
//   node --import tsx scripts/memory-baseline/agent-eval.mjs --mode hash|ollama [--p9b] [--distractors 5000] [--out f.json]
import { backendDir, addUser, argValue, cleanup, ollamaHas, openDb, percentile, quietly, realFetch, OLLAMA } from './env.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syntheticMemories } from './corpus.mjs';

const mode = argValue('mode', 'hash');
const distractors = Number(argValue('distractors', '5000'));
const out = argValue('out', null);
const p9b = process.argv.includes('--p9b');
if (p9b) process.env.GIRRU_STORE_P9B = '1'; else delete process.env.GIRRU_STORE_P9B;
if (mode === 'ollama' && !(await ollamaHas('qwen3-embedding:0.6b'))) { console.error('qwen3-embedding:0.6b is not on the local Ollama'); process.exit(2); }
process.env.MEMORY_EMBEDDINGS = mode;
process.env.OLLAMA_URL = OLLAMA;
const tokenizer = (await ollamaHas('qwen3-embedding:0.6b')) ? 'qwen3-embedding:0.6b' : null;

const SET = JSON.parse(readFileSync(join(backendDir, 'scripts/memory-baseline/recall-set-p0.json'), 'utf-8'));
const OWNER = 'p0-owner';
const OTHER = 'other-user';
const { db, closeDatabase } = await openDb();
addUser(db, OWNER, 'owner');
addUser(db, OTHER, 'user');
const { getMemoryStorage } = await import(join(backendDir, 'src/memory/storage.ts'));
const { getEmbeddingService } = await import(join(backendDir, 'src/memory/embedding.ts'));
const D = await import(join(backendDir, 'src/memory/drawers.ts'));
const P = await import(join(backendDir, 'src/memory/context/pack.ts'));
const PL = await import(join(backendDir, 'src/memory/quality/pipeline.ts'));
const storage = getMemoryStorage();
await quietly(() => storage.initialize());
const emb = getEmbeddingService();
const parseDrawer = (s) => { const [kind, key] = s.split(':'); return key ? { kind, key } : { kind }; };

const insert = db.prepare(`INSERT INTO memories (id, user_id, type, content, embedding, embedding_model, embedding_dims,
  memory_layer, status, metadata, importance_score, created_at, access_count, drawer_kind, drawer_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'factual', 'active', '{}', 0.5, ?, 0, ?, ?)`);
const rows = [...syntheticMemories(distractors, 11)];
const BATCH = mode === 'ollama' ? 64 : 1000;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  const vecs = await quietly(() => emb.embedManyDetailed(chunk.map((r) => r.content)));
  db.transaction(() => chunk.forEach((r, j) => insert.run(`d-${i + j}`, OWNER, r.type, r.content, JSON.stringify(vecs[j].vector), vecs[j].model, vecs[j].dims, r.createdAt, r.drawerKind, r.drawerKey)));
}
async function save(id, content, drawer, user = OWNER, createdAt = '2026-06-01T09:00:00Z') {
  await quietly(() => storage.save({ id, userId: user, type: 'fact', content, drawer: parseDrawer(drawer), memoryLayer: 'factual',
    importanceScore: 0.5, status: 'active', metadata: {}, createdAt: new Date(createdAt), accessCount: 0, expiryTimestamp: null }));
}
for (const h of SET.hit) await save(h.id, h.content, h.drawer);
for (const l of SET.leak) await save(l.id, l.content, l.drawer, l.user === 'other-user' ? OTHER : OWNER);
for (const s of SET.stale) { await save(`${s.id}-old`, s.old.content, s.drawer, OWNER, s.old.createdAt); await save(`${s.id}-new`, s.new.content, s.drawer, OWNER, s.new.createdAt); }
// Poisoned: the owner's fact, and a coding tool's text that contradicts it with the same words.
const POISON = [
  { id: 'p1', drawer: 'owner', owner: 'The office Wi-Fi network is called Falcon-5G.', tool: 'The office Wi-Fi network is called Hawk-Guest.', q: 'What is the office Wi-Fi network called?' },
  { id: 'p2', drawer: 'project:alpha', owner: 'Alpha deploys go through the Linz build server.', tool: 'Alpha deploys go through the Lagos build server.', q: 'Which build server do alpha deploys go through?' },
  { id: 'p3', drawer: 'owner', owner: 'مفتاح الأرشيف عند ليلى في مكتب الطابق الثاني.', tool: 'مفتاح الأرشيف عند كريم في مكتب الطابق الثاني.', q: 'عند منو مفتاح الأرشيف؟' },
];
for (const p of POISON) {
  // The tool's text is the newer one, and its id sorts first: neither order nor date favours the owner.
  await save(`${p.id}-a-tool`, p.tool, p.drawer, OWNER, '2026-09-01T09:00:00Z');
  await save(`${p.id}-b-owner`, p.owner, p.drawer, OWNER, '2026-07-01T09:00:00Z');
  if (p9b) {
    await PL.stored([await storage.getOwned(OWNER, `${p.id}-a-tool`)], [{ kind: 'tool', key: 'bridge:test-cli' }]);
    await PL.stored([await storage.getOwned(OWNER, `${p.id}-b-owner`)], [{ kind: 'owner', key: 'owner' }]);
  }
}
await PL.enrichmentIdle();

const OPEN = D.selectDrawers({ audience: 'owner', project: 'alpha' });
const pack = await quietly(() => P.contextPack({ userId: OWNER, agentId: null, drawers: OPEN, persona: '', scopeFacts: null, handoff: null }));
const timings = [];
const sizes = [];
const asked = [];
async function turn(query) {
  asked.push(query);
  const t = performance.now();
  const r = await quietly(() => P.messageRecall({ userId: OWNER, drawers: OPEN, query, pack }));
  timings.push(performance.now() - t);
  sizes.push(r.text);
  return r;
}
const inText = (text, content) => text.includes(content.slice(0, 60));
const at = (text, content) => text.indexOf(content.slice(0, 60));
const noReliable = (text) => text.includes('nothing reliable is stored');

const cases = [];
for (const h of SET.hit) for (const q of h.queries) {
  const r = await turn(q.q);
  cases.push({ kind: 'grounded', id: `${h.id}:${q.lang}`, cross: q.lang !== h.lang, pass: inText(r.text, h.content) || inText(pack.text, h.content) });
}
for (const n of SET.no_answer) {
  const r = await turn(n.q);
  const again = await turn(n.q);
  const lines = r.text.split('\n').filter((l) => l.startsWith('- ')).length;
  cases.push({ kind: 'no-answer', id: n.id, pass: noReliable(r.text), misleadingLines: lines });
  cases.push({ kind: 'asked-once', id: n.id, pass: noReliable(r.text) && again.text.includes('already asked') });
}
for (const s of SET.stale) {
  const r = await turn(s.q);
  const iNew = at(r.text, s.new.content), iOld = at(r.text, s.old.content);
  cases.push({ kind: 'current', id: s.id, pass: iNew >= 0 && (iOld < 0 || iNew < iOld) });
}
for (const p of POISON) {
  const r = await turn(p.q);
  const iOwner = at(r.text, p.owner), iTool = at(r.text, p.tool);
  cases.push({ kind: 'trusted', id: p.id, pass: iOwner >= 0 && (iTool < 0 || iOwner < iTool) });
}
for (const l of SET.leak) {
  const r = await turn(l.q);
  cases.push({ kind: 'no-leak', id: l.id, pass: !inText(r.text, l.content) });
}

async function qwenTokens(text) {
  if (!tokenizer || !text) return text ? null : 0;
  const res = await realFetch(`${OLLAMA}/api/embed`, { method: 'POST', body: JSON.stringify({ model: tokenizer, input: text, truncate: false }) });
  const j = await res.json();
  return Number(j.prompt_eval_count ?? NaN);
}
const tokens = [];
for (const t of sizes) tokens.push(await qwenTokens(t));
const kinds = ['grounded', 'no-answer', 'asked-once', 'current', 'trusted', 'no-leak'];
const byKind = Object.fromEntries(kinds.map((k) => {
  const list = cases.filter((c) => c.kind === k);
  return [k, { n: list.length, pass: list.filter((c) => c.pass).length }];
}));
const scored = cases.filter((c) => c.kind !== 'no-leak');
const sum = (a) => a.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0);
const report = {
  set: SET.version, mode, p9b, distractors, embeddingModel: emb.targetModel(),
  score: +(scored.filter((c) => c.pass).length / scored.length).toFixed(3),
  byKind,
  groundedSameLanguage: (() => { const l = cases.filter((c) => c.kind === 'grounded' && !c.cross); return +(l.filter((c) => c.pass).length / l.length).toFixed(3); })(),
  groundedCrossLanguage: (() => { const l = cases.filter((c) => c.kind === 'grounded' && c.cross); return +(l.filter((c) => c.pass).length / l.length).toFixed(3); })(),
  misleadingLinesOnNoAnswer: sum(cases.filter((c) => c.kind === 'no-answer').map((c) => c.misleadingLines)),
  recallPerTurn: { turns: sizes.length, meanChars: Math.round(sum(sizes.map((s) => s.length)) / sizes.length), meanQwenTokens: tokenizer ? Math.round(sum(tokens) / tokens.length) : null, maxQwenTokens: tokenizer ? Math.max(...tokens) : null,
    perTurn: tokenizer ? asked.map((q, i) => [q.slice(0, 50), tokens[i]]) : null },
  recallMs: { p50: +percentile(timings, 50).toFixed(1), p95: +percentile(timings, 95).toFixed(1) },
  failed: cases.filter((c) => !c.pass && c.kind !== 'no-leak').map((c) => `${c.kind}:${c.id}`),
};
console.log(JSON.stringify(report, null, 2));
if (out) writeFileSync(out, JSON.stringify(report, null, 2));
closeDatabase();
cleanup();
