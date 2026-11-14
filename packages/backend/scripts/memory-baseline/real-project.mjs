// Girru reading a REAL project: this repository's own documents, and real questions about them.
//
// Every accuracy number so far comes from a generated world of ten invented projects. That measures
// the search, not the thing the owner actually does: point Girru at a repository and ask about it.
// This indexes the repository's own `docs/` and asks questions whose answers are written there, so a
// miss is a real miss — the text exists and was not found.
//
// The questions are kept outside the answers: each names the file its answer lives in and a phrase
// that must appear in the retrieved text. Nothing is generated and nothing is seeded.
//
// Run from packages/backend (needs the local qwen3-embedding:0.6b for meaning-based search; with
// --vectors hash it runs with no model at all and only words are compared):
//   node --max-old-space-size=8192 --import tsx scripts/memory-baseline/real-project.mjs [--repo <path>] [--vectors hash]
import { backendDir, moduleUrl, addUser, argValue, cleanup, ollamaHas, openDb, percentile, quietly } from './env.mjs';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(argValue('repo', join(backendDir, '..', '..')));
/**
 * --known-item N: instead of the hand-written questions, ask N real headings from the project's own
 * documents and check the piece of text under each heading comes back. Nobody writes the questions,
 * so it works on ANY project and cannot be tuned by choosing questions that happen to pass. It
 * measures something narrower — can the index find the passage a topic names — but it measures it
 * honestly, and it is the check to run on a project whose documents nobody here has read.
 */
const knownItem = Number(argValue('known-item', '0')) || 0;
const vectors = argValue('vectors', 'semantic');
const SEM_MODEL = 'qwen3-embedding:0.6b';
// A `docs/` folder is the common case but not a requirement: the index reads the whole project.
if (!existsSync(repo)) { console.error(`no folder at ${repo}`); process.exit(2); }
if (vectors === 'semantic' && !(await ollamaHas(SEM_MODEL))) {
  console.error(`${SEM_MODEL} is not on the local Ollama; run with --vectors hash for the word-only check`);
  process.exit(2);
}
process.env.MEMORY_EMBEDDINGS = vectors === 'semantic' ? 'ollama' : 'hash';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
process.env.GIRRU_DOC_INDEX = '1';

/**
 * Real questions, the file each answer is written in, and a phrase that must come back. Taken from
 * this repository's own documents — no generated text anywhere.
 */
const QUESTIONS = [
  { q: 'how fast is recall with a million memories', file: 'FEATURES.md', want: ['1 million', '90 ms'] },
  { q: 'where does Girru keep its main database', file: 'docs/architecture/storage-map.md', want: ['agent-player.db', 'SQLite'] },
  { q: 'which coding tools can read Girru memory', file: 'docs/architecture/storage-map.md', want: ['Claude Code', 'Codex'] },
  { q: 'what happens when two tools edit the same memory', file: 'docs/architecture/storage-map.md', want: ['refused', 'version'] },
  { q: 'why does another program writing no longer slow down searches', file: 'docs/architecture/storage-map.md', want: ['change log'] },
  { q: 'what file types does document memory read', file: 'docs/architecture/storage-map.md', want: ['.pdf', '.md'] },
  { q: 'which library is used for the vector index and under what licence', file: 'THIRD_PARTY_LICENSES.md', want: ['usearch', 'Apache'] },
  { q: 'how are handoff notes grouped when you read them', file: 'FEATURES.md', want: ['Earlier this week'] },
  { q: 'what does a sync do when I asked Girru to leave a folder alone', file: 'FEATURES.md', want: ['untouched'] },
  { q: 'does the recall index get written to disk', file: 'docs/architecture/storage-map.md', want: ['never goes to disk'] },
];

const OWNER = 'real-owner';
const { db } = await openDb();
addUser(db, OWNER, 'owner');
const { createProject } = await import(moduleUrl(backendDir, 'src/repositories/chat-conversations.ts'));
const { setDocSource, indexSource, ensureProjectSources } = await import(moduleUrl(backendDir, 'src/memory/docs/indexer.ts'));
const { docScopes, docRecall, citeOf } = await import(moduleUrl(backendDir, 'src/memory/docs/recall.ts'));
const D = await import(moduleUrl(backendDir, 'src/memory/drawers.ts'));

const project = await quietly(() => createProject(OWNER, { name: 'Girru itself', folder: repo }));
console.log(`project        ${repo}`);

const t0 = Date.now();
const sources = await quietly(() => ensureProjectSources(OWNER));
for (const id of sources) await quietly(() => setDocSource(OWNER, 'project', project.id, true)).catch(() => null);
let files = 0, chunks = 0;
for (const id of sources) {
  const r = await quietly(() => indexSource(id)).catch((e) => ({ error: String(e?.message ?? e) }));
  if (r?.error) { console.log(`index failed   ${r.error.slice(0, 200)}`); continue; }
  files += r.files ?? r.indexed ?? 0;
  chunks += r.chunks ?? 0;
}
const indexMs = Date.now() - t0;
const counted = db.prepare('SELECT COUNT(*) AS f FROM doc_index_files').get().f;
const countedChunks = db.prepare('SELECT COUNT(*) AS c FROM doc_index_chunks').get().c;
console.log(`indexed        ${counted} files · ${countedChunks} pieces of text in ${(indexMs / 1000).toFixed(1)}s (${vectors} vectors)`);
if (countedChunks === 0) { console.error('nothing was indexed; stopping'); try { cleanup(); } catch { /* ignore */ } process.exit(2); }

const drawers = D.selectDrawers({ audience: 'owner', project: project.id });
const scopes = await quietly(() => docScopes({ userId: OWNER, drawers }));

if (knownItem > 0) {
  // Headings long enough to name a topic, spread across the whole set rather than one folder.
  const rows = db.prepare(`SELECT c.id, c.heading, f.rel_path FROM doc_index_chunks c
      JOIN doc_index_files f ON f.id = c.file_id
     WHERE c.heading IS NOT NULL AND LENGTH(c.heading) BETWEEN 12 AND 120
     ORDER BY c.id`).all();
  const step = Math.max(1, Math.floor(rows.length / knownItem));
  const picked = rows.filter((_, i) => i % step === 0).slice(0, knownItem);
  // Many documents repeat a heading ("Rules", "Notes"), so another passage under the SAME heading is
  // not a wrong answer: it is the topic that was asked for. Counted both ways, strictly and fairly.
  const sameHeading = new Map();
  for (const r of rows) {
    const k = String(r.heading).trim();
    const list = sameHeading.get(k);
    if (list) list.push(r.id); else sameHeading.set(k, [r.id]);
  }
  const kms = [];
  let top1 = 0, top4 = 0, fair1 = 0, fair4 = 0, ambiguous = 0;
  for (const row of picked) {
    // The heading alone is the question, as someone asking about that topic would put it.
    const query = String(row.heading).replace(/[›#]/g, ' ').replace(/\s+/g, ' ').trim();
    const t = performance.now();
    const r = await quietly(() => docRecall({ userId: OWNER, query, scopes, limit: 4 }));
    kms.push(performance.now() - t);
    const ids = r.items.map((h) => h.chunkId ?? h.id);
    const family = sameHeading.get(String(row.heading).trim()) ?? [row.id];
    if (family.length > 1) ambiguous++;
    if (ids[0] === row.id) top1++;
    if (ids.includes(row.id)) top4++;
    if (family.includes(ids[0])) fair1++;
    if (ids.some((i) => family.includes(i))) fair4++;
  }
  console.log(`
known-item check, ${picked.length} real headings from this project's own documents`);
  const pc = (n) => `${n} (${((n / picked.length) * 100).toFixed(0)}%)`;
  console.log(`  that exact passage came back first               ${pc(top1)}`);
  console.log(`  that exact passage was in the best four          ${pc(top4)}`);
  console.log(`  a passage under the SAME heading came first      ${pc(fair1)}`);
  console.log(`  a passage under the SAME heading was in the four ${pc(fair4)}`);
  console.log(`  headings this project repeats elsewhere          ${pc(ambiguous)}`);
  console.log(`  recall p50 ${percentile(kms, 50).toFixed(0)} ms · p95 ${percentile(kms, 95).toFixed(0)} ms`);
  try { cleanup(); } catch { /* ignore */ }
  process.exit(0);
}
const ms = [];
let found = 0, right = 0;
for (const t of QUESTIONS) {
  const start = performance.now();
  const r = await quietly(() => docRecall({ userId: OWNER, query: t.q, scopes, limit: 4 }));
  ms.push(performance.now() - start);
  const text = r.items.map((h) => h.text ?? h.content ?? '').join('\n');
  const cites = r.items.map((h) => citeOf(h));
  const hitFile = r.items.some((h) => (h.file ?? '').replace(/\\/g, '/').endsWith(t.file.replace(/^.*\//, '')));
  const hasAnswer = t.want.every((w) => text.toLowerCase().includes(w.toLowerCase()));
  if (hitFile) found++;
  if (hasAnswer) right++;
  const mark = hasAnswer ? 'ok  ' : hitFile ? 'file' : 'MISS';
  console.log(`${mark}  ${t.q}`);
  if (!hasAnswer) console.log(`      wanted ${JSON.stringify(t.want)} · got ${cites.slice(0, 3).join(' | ') || 'nothing'}`);
}
console.log(`\nanswers in the retrieved text  ${right} of ${QUESTIONS.length}`);
console.log(`right file retrieved           ${found} of ${QUESTIONS.length}`);
console.log(`recall p50 ${percentile(ms, 50).toFixed(0)} ms · p95 ${percentile(ms, 95).toFixed(0)} ms`);
// Windows keeps the database file open a moment after the last connection closes.
try { cleanup(); } catch { /* the throwaway folder is left for the OS to clear */ }
process.exit(right === QUESTIONS.length ? 0 : 1);
