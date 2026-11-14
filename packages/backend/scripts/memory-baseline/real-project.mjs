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
const vectors = argValue('vectors', 'semantic');
const SEM_MODEL = 'qwen3-embedding:0.6b';
if (!existsSync(join(repo, 'docs'))) { console.error(`no docs folder in ${repo}`); process.exit(2); }
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
