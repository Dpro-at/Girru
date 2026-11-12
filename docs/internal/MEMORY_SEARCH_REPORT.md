# Girru memory and search: design, plan and measured results

Report for review by another engineer or agent. Written 12 November 2026 from the code on branch
`girru/memory-search-speed-97063e` (pushed, not merged; base `main` 9105007f) and from runs on two
machines. Every number below was measured; nothing is estimated unless it says so.

**What we want from the reviewer:** a second opinion on the search design (section 3), the
open questions (section 8) and the next-step plan (section 9). In particular: is in-process
HNSW (usearch) plus an exact re-score the right approach for 1M to 10M memories on a desktop app,
and how should the index start fast without breaking the privacy rule that nothing of the
index is stored on disk?

---

## 1. What Girru's memory is

Girru is a local-first agent OS (desktop app; backend in Node.js/TypeScript, Fastify). Memory is
per owner, local, and shared by Girru's own agents and by outside coding apps (Claude Code, Codex,
Gemini CLI, Antigravity, Cursor, GitHub Copilot CLI).

| Part | What it is |
|---|---|
| Store | SQLite (`memories` table) is canonical; PostgreSQL is supported with the same SQL steps. Every memory: id, owner, type, content, layer (factual / working / …), importance, status (active / replaced), drawer, vector (JSON text plus a packed Float32 copy), embedding model, created_at |
| Drawers | Scopes: `owner`, `experience`, `project:<slug>`, `people:<name>`, `task:<id>`, `agent:<id>`. A turn opens only the drawers its audience may see (owner chat: owner + experience + the current project) |
| Versions | Every change is a new version (`memory_versions`); drawers can be exported as Markdown (`### m:<id>` blocks), re-exported every minute; an edited file returns only as a reviewed proposal |
| Embeddings | Local model `qwen3-embedding:0.6b` (1024 dims) through Ollama on 127.0.0.1; installed by the app in the background. Offline fallback: `hash-v2` (256 dims) |
| Documents | A separate document index (KNOW-INDEX-01) over project folders and agents' knowledge folders: `.md`, `.txt`, `.pdf` (own PDF reader), chunked by heading or page, secrets redacted, embedded with the same model, cited by file and page |

### 1.1 Write path (how memory is organised)

1. **Learn** (chat extraction, an agent's `memory_save` / edit / delete):
   - write-quality checks: one fact per memory (clear multi-fact texts are split), duplicates by
     meaning of words, not only exact copies;
   - classification: *routine* saved automatically (versioned), *important* (owner identity,
     preferences, people, relationships) becomes a proposal the owner approves, *duplicate* dropped;
   - contradiction check (negation / opposite words, English, German, Arabic): a contradicting
     fact becomes a conflict proposal; an approved change marks the old fact `replaced`.
2. **Background jobs** (local only, owner-scoped): weekly "what I learned" summary; repeated
   lessons in the experience drawer proposed as a rule or a skill; a read-only memory doctor at
   night; trash expiry; optional retention for task memories.
3. **Memory bridge to coding apps** (every minute):
   - Girru writes ONE section between its markers in `AGENTS.md`, plus pointers in `CLAUDE.md`,
     `GEMINI.md` and `.cursor/rules/girru.mdc`, and `.girru/{rules,tasks,brief}.md` (preview, hash
     check, never over text outside its markers, secrets refused);
   - back-flow reads what the apps wrote in their own memory files (`CLAUDE.md`,
     `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`, Claude's auto memory,
     `AGENTS.md`, `AGENTS.override.md`, `GEMINI.md`, `.agents/**`) and turns new chunks into
     review proposals;
   - MCP server `dpro-memory`: `project_brief`, `pinned_facts`, `latest_handoff`,
     `memory_search`, `project_design`; writes only as proposals (`memory_propose`, `handoff_write`).
4. **Handoffs**: versioned "done / left / next" notes per agent and conversation or task; the
   newest one is in the brief and returned by `latest_handoff`.

### 1.2 What a search covers today

| Source | Girru chat and Girru agents | Coding apps through MCP `memory_search` |
|---|---|---|
| Memories (incl. approved back-flow) | yes | yes |
| Project documents (`.md`, `.txt`, `.pdf`, incl. root `AGENTS.md` / `CLAUDE.md` / `GEMINI.md`) | yes (document index) | **no** |
| Hidden folders (`.claude/`, `.cursor/`, `.agents/`, `.girru/`) | **no** (the scanner skips hidden entries) | no |
| Handoffs | newest one in the context, not as a search result | `latest_handoff`, not in `memory_search` |
| Word, Excel, PowerPoint, CSV | **no** (planned: MR8, text only, own code) | no |

---

## 2. The problem we solved

`MemoryStorage.search` (used by chat recall, Girru's `memory_search` tool and the MCP
`memory_search`) scanned every memory of the open drawers on every search: it read the light
columns of every row from SQLite, kept vectors in a RAM cache capped at 256 MB, scored all rows
(BM25 + cosine) and sorted them all. Cost grew linearly; 1M had never been measured.

---

## 3. The new search (MEM-SPEED-01)

Scoring did **not** change: `score = 0.75 · vector + 0.25 · lexical²` for the semantic model
(`0.40 · vector + 0.60 · lexical` for the hash fallback, where a vector counts only with a word in
common), `vector = clamp((cos − 0.30) / 0.55)`, minimum score 0.08, +0.05 for working-layer
memories. Owner, drawer, archived, replaced and agent-notes filters are unchanged.

Pipeline for one search:

1. **Embed the query** with the local model (17 ms on the Mac, 55-60 ms on the Windows PC).
2. **Open the store** for the owner (`recall-store.ts`): per drawer, the memories the search needs,
   loaded on first use in pages of 5,000 from the drawer expression index.
   - **Kept in step by id**: TEMP triggers on `memories` (connection only, never in the database
     file) call a JS function with the owner and id of every inserted, updated or deleted row;
     the next search re-reads only those rows by primary key. A write by another database
     connection is detected with `PRAGMA data_version` and drops every store (rebuilt on demand).
3. **Words: BM25** through an inverted index (term → slots + counts), so only memories that share a
   word are touched; same numbers as before (same term order and arithmetic).
4. **Meaning**, per drawer size:
   - under 20,000 memories: exact cosine over full vectors in RAM (query norm once);
   - 20,000 and more: an in-process **HNSW index (usearch, int8, cosine)**; take the 200 nearest;
   - (without usearch, or when switched: int8 vectors in RAM, scanned, from 50,000.)
5. **Candidates for the approximate drawers**: the 200 nearest by vector + the 200 best by words +
   every working-layer memory (boosted, few).
6. **Exact re-score**: the candidates' full vectors are read by primary key and scored with the
   unchanged formula; memories without a comparable vector are scored exactly by words.
7. **Top-k heap** (ties in the old order: created_at, id); full rows are loaded for the results only.

Switches: `GIRRU_RECALL_STORE=0` (old path; comparison and escape hatch),
`GIRRU_RECALL_ANN_MIN` (20,000), `GIRRU_RECALL_EXACT_MAX` (50,000), `GIRRU_RECALL_RESCORE` (200),
`GIRRU_RECALL_INDEX_MB` (default a quarter of RAM; past it, the old path), `GIRRU_RECALL_ANN_THREADS`.

Privacy (rule S7, unchanged): the index lives in process memory only. Forget / delete / replace /
archive remove a memory from the store and the HNSW index; forget drops the owner's store; a
store is dropped after 30 minutes without a search.

---

## 4. Results

Benchmark: `scripts/memory-baseline/latency.mjs --vectors semantic --packed`, one owner, owner chat
with project `alpha` open (about 46.5% of all memories in the open drawers), 20 queries of the
recall set in English, Arabic, Iraqi dialect and German. Memories have random 1024-dim vectors
tagged as the real model; **each query is embedded by the real local model**, and the time
**includes** that embedding. `--json-stub` keeps the vector only in the packed column (what search
reads), so 10M fits on disk; at 1M it measured within noise of full rows.
All runs: `docs/internal/memory-search-results.json`.

### 4.1 Windows PC: Intel i9-14900F (24 cores / 32 threads), 64 GB RAM, Windows 11

Before (P9 index, full scan, 256 MB cap):

| Memories | p50 | p95 | First search | Peak RAM |
|---|---|---|---|---|
| 10k | 120 ms | 124 ms | 2.3 s | 452 MB |
| 100k | 807 ms | 825 ms | 3.1 s | 743 MB |
| 1M | **32.6 s** | 33.8 s | 36.9 s | 4.1 GB |

After:

| Memories | In open drawers | p50 | p95 | First search (builds index) | Peak RAM | Index |
|---|---|---|---|---|---|---|
| 10k | 4.7k | **85 ms** | 118 ms | 0.4 s | 436 MB | exact |
| 100k | 46.7k | **95 ms** | 114 ms | 4.6 s | 613 MB | 1 HNSW + 2 exact |
| 1M | 465k | **90 ms** | 105 ms | 69 s | 1.3 GB | 2 HNSW + 1 exact |
| 3M | 1.4M | **109 ms** | 127 ms | 3.9 min | 3.1 GB | 3 HNSW |
| 10M | 4.65M | **266 ms** | 575 ms | **26.9 min** | 9.1 GB | 3 HNSW, 7.7 GB |

Steps on the way: store kept in step by id + inverted BM25 + heap (100k: 807 → 105 ms); int8
(100k RAM 666 → 508 MB); HNSW (1M: 32.6 s → 135 ms); stable hot loops (V8 de-optimised closures
every few searches: +120 ms spikes) and HNSW from 20k (100k p95 223 → 110 ms).

### 4.2 Mac Mini: Apple M6, 32 GB RAM (same branch, 05905476)

| Memories | p50 | p95 | Query embedding | First search | Peak RAM | Index |
|---|---|---|---|---|---|---|
| 100k | **34 ms** | 47 ms | 17 ms | 2.6 s | 561 MB | 124 MB |
| 1M | **36 ms** | 49 ms | 17 ms | 50 s | 1.5 GB | 765 MB, 3 HNSW drawers |

3M and 10M were not run on the Mac (about 20 GB free disk). The old path was not measured on the
Mac at 1M; the "before" figure is from Windows. Documented earlier Mac numbers (older code):
10k 44 ms, 100k 280 ms.

### 4.3 Quality (unchanged)

- `recall.mjs --mode ollama` (5,000 distractors, real model): hit@5 same language 0.958,
  cross-language 0.714; MRR 0.958 / 0.641; leaks 0; stale facts unchanged — identical for the old
  path, exact, int8 and HNSW.
- `store-p9-index.test.mjs` (same memories, scores and order as the full-row path): 6/6 in every
  mode. `recall-store.test.mjs` (heap = full sort; int8 = Float32 hits; HNSW same top hit for every
  query, same top 5 for all but at most one; filters exact; replace / delete / edit leave the HNSW
  index; owner scoping; forget; other connection's writes): 5/5. `multilingual-recall.test.mjs`
  7/7 incl. Ollama recall@3 thresholds. Mac: 18/18 of these three files.
- Known HNSW limit: usearch's parallel insert leaves roughly 1% of points hard to reach on fully
  random vectors; the re-score of 200 by vector + 200 by words kept the measured recall unchanged.

---

## 5. Libraries and components

| Component | Source | Licence | Note |
|---|---|---|---|
| **usearch 2.26.5** | npm (Unum Cloud), new | Apache-2.0 (bundles NumKong: Apache-2.0 / BSD-3) | HNSW, int8, cosine; prebuilt for Windows x64, macOS arm64/x64, Linux x64/arm64 (no compile at install). Approved by the owner (D-SEARCH-LIBS). Loaders `bindings`, `node-addon-api`, `node-gyp-build`: MIT |
| better-sqlite3 | existing | MIT | database driver |
| Ollama + `qwen3-embedding:0.6b` | local app and model on 127.0.0.1 | — | query and memory embeddings; no cloud call |
| BM25, Arabic/Iraqi/German/English normalisation, hybrid scoring | own code | — | `hybrid.ts`, `text-normalize.ts` |
| Store kept in step by id, int8, re-score, heap | own code | — | `recall-store.ts` |
| PDF text reader, chunker, secret redaction | own code | — | no packages |

No paid API, no network service; Girru's rule is own code and no new packages unless the owner
approves (search-speed libraries are approved, licence-checked, no AGPL/GPL shipped).

---

## 6. Tools for measuring

- `scripts/memory-baseline/latency.mjs` (`--size`, `--json-stub`, `--per-query`, `--record "label"`).
- `scripts/memory-baseline/recall.mjs` (quality on the recall set).
- **Playground** `scripts/memory-baseline/playground.mjs` + `docs/internal/memory-search-playground.html`:
  generate 1k-10M test memories (throwaway folder), search with suggestions, see time split, cold /
  warm, index, RAM, expected rank, leaks; compare modes; benchmark saved to the results log with
  the change against the previous run.

---

## 7. Gaps found

1. **Cold start**: the first search after a start builds the index in RAM: 1 min at 1M, 4 min at
   3M, 27 min at 10M (Windows). During the build that search waits.
2. **10M tail latency**: p50 266 ms, p95 575 ms (3M: 109 / 127). The extra time is the BM25 walk of
   long posting lists (common words over millions of memories) and the re-score reads from a 50 GB
   database not in the OS cache.
3. **Coverage**: MCP `memory_search` does not search project documents; hidden agent folders
   (`.claude/rules`, `.cursor/rules`, `.agents/rules`) are not in the document index; Cursor and
   Copilot rule files are not read by back-flow; handoffs are not search results; Word / Excel /
   PowerPoint not read yet.
4. **PostgreSQL and the encrypted store** still use the old path (the change capture is SQLite only).
5. **Windows test debt (not search)**: POSIX file-mode assertions, an Open-in-Code path check, a
   prompt-prefix cache test, temp-folder cleanup while the database is open (EPERM).

---

## 8. Open questions (owner decides; reviewer opinion welcome)

1. **Persist the index?** An encrypted on-disk HNSW index (deleted by forget, keyed by the owner's
   key) would start in seconds instead of minutes at 1M+. It changes privacy rule S7 (today: RAM
   only). Alternatives: build in the background and serve the old path meanwhile; build only the
   drawers a turn opens; lower RAM use with Matryoshka truncation (1024 → 256 dims) for the first
   pass.
2. **Which number for the ad?** Measured: "1M memories in 0.036 s on a Mac M6" (query embedding
   included) and "0.09 s on an i9 PC, was 32.6 s". 10M: 0.27 s median, 9 GB RAM, 27 min first build.
3. **Under 150 ms at 10M?** Candidates: per-drawer document frequencies kept up to date (no full
   posting walk for idf), skip or cap very common words (WAND / MaxScore), keep full vectors of
   likely candidates in RAM or read them from a memory-mapped file, raise HNSW connectivity.
4. **Coverage**: include project documents and handoffs in MCP `memory_search`; index agents' rule
   folders; read Cursor / Copilot rules in back-flow.

---

## 9. Plan (proposed order)

| # | Step | Why | Status |
|---|---|---|---|
| 1 | Store kept in step by id, inverted BM25, heap, int8, HNSW, re-score | speed at 1M+ with the same results | **done, measured on Windows and Mac** |
| 2 | Playground + results log | every change shows its difference | **done** |
| 3 | Merge the branch after review | ship it | waiting for the owner |
| 4 | Cold start: background build + old path meanwhile, or an encrypted saved index | 10M first search 27 min | needs the owner's decision (S7) |
| 5 | 10M tail: incremental df, posting caps, faster re-score reads | p95 575 → < 150 ms | proposed |
| 6 | Coverage: documents + handoffs in MCP search, agent rule folders, Cursor / Copilot back-flow | coding apps see all project knowledge | proposed (touches bridge files; coordinate with the Mac session's MR work) |
| 7 | Word / Excel / PowerPoint / CSV text reading (MR8) | more document types | in progress on the Mac session |
| 8 | PostgreSQL change capture (triggers + LISTEN or a change table) | same speed on the server option | proposed |
| 9 | Run 3M / 10M on the Mac after freeing disk | ad numbers for the main machine | waiting for disk space |
