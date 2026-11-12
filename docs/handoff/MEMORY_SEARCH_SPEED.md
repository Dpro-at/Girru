# Task: make memory search fast at 1 million memories

Added 12 November 2026 on the main computer, for the next agent. Report back
in the "Result" section at the end of this file.

- **Branch:** create `memory/search-speed` from `main`. Commit there only.
- **Do not** push to `main`, merge, tag or release.
- **Do not** change what recall returns for the existing test sets (see "Must
  not change" below) unless the owner approves a measured trade-off.

## Why

The ad and the docs may only state numbers we measured. Today we have
**10,000 memories in 44 ms** and **100,000 in 0.28 s**. **1,000,000 has never
been measured.** The owner wants search to stay fast at 1M, and the measured
number for the ad.

## How search works today (read before you change anything)

Entry points that all end in the same search:

- MCP bridge tools `memory_search` and the `recall` verb:
  `src/memory/bridge/mcp-server.ts`, handled in `src/memory/bridge/service.ts`
  (`case 'memory_search'`, `verb === 'recall'`) → `getMemoryStorage().search(...)`.
- Chat recall inside Girru uses the same `MemoryStorage.search`.

`src/memory/storage.ts` → `search()` builds the SQL filter (owner, open
drawers of the project, not archived, not replaced, not agent notes), embeds
the query (`qwen3-embedding:0.6b`, 1024 dims, via Ollama; hash fallback 256
dims), then with `GIRRU_STORE_P9` on calls `searchIndexed()`:

1. Reads **light columns of every matching row** (`LIGHT_COLUMNS`).
2. `recall-index.ts` `entriesFor()` keeps per memory, in process RAM only: the
   vector (Float32Array / Float64Array for JSON-only rows), its squared norm, and
   BM25 term counts. Cap `GIRRU_RECALL_INDEX_MB` (default **256 MB**). Entries
   past the cap are scored but not kept, so they are read again on every search.
3. Scores **every entry**: BM25 (`hybrid.ts` `bm25FromCounts`) plus cosine
   (`entryCosine`). Score = 0.75 · vector + 0.25 · lexical² (semantic).
4. Sorts all scores and loads full rows for the top `limit` only.

There is **no approximate nearest-neighbour index**. Cost grows linearly with
the number of memories in the open drawers.

### Problems at 1M

| Problem | Effect |
|---|---|
| 1M × 1024 × 4 bytes ≈ **4 GB** of vectors | The 256 MB cap holds only ~50–60k memories, the rest is re-read from SQLite on every search. |
| Full scan of 1M cosines + BM25 over every entry | Estimated 2–3 s per search even when everything is in RAM. |
| `entryCosine` recomputes the query norm for every entry | ~2× the needed multiplications in the hottest loop. |
| Light-column read of every row on every search | SQL work grows with drawer size. |
| Full sort of all scored rows | Only the top `limit` (≤ 20) is needed. |

## What to do, in this order (measure after each step)

Benchmark command (from `packages/backend`, one size per process):

```bash
GIRRU_STORE_P9=1 node --max-old-space-size=12288 --import tsx scripts/memory-baseline/latency.mjs --size 100000 --vectors semantic --packed --queries 20 --out p-100k.json
```

Run it at 10k, 100k and 1M **before** any change, and record the numbers in
the Result section. If the local Ollama has no `qwen3-embedding:0.6b`, say so
and measure with `--vectors hash` as well as a semantic run with fake vectors
(add a flag if needed; never pull models or enable paid APIs without asking
the owner).

1. **Cheap wins, no behaviour change**
   - Compute the query norm once per search, not per entry.
   - Keep a top-k heap of size `limit` instead of sorting every scored row.
   - Store index vectors pre-normalised (unit length), so cosine is one dot product.
   - BM25: only touch entries that contain a query term (an inverted
     term → entries map in the index), instead of looping every entry.
2. **Smaller vectors in RAM**
   - Keep the in-RAM index as **int8 (scalar quantised)** vectors: 4× smaller,
     so 1M fits in ~1 GB. Re-score the top ~100 with the full Float32 vector
     from SQLite so the final order is the same.
   - Measure **Matryoshka truncation** of qwen3-embedding (1024 → 512 / 256)
     for the first pass only. Adopt only if recall on the test sets does not drop.
   - Raise or auto-size `GIRRU_RECALL_INDEX_MB` once entries are int8.
3. **ANN index for big drawers**
   - Above a threshold (e.g. 50k memories in the searched drawers), use an
     in-process HNSW index (look at `hnswlib-node`, `usearch`, or `sqlite-vec`;
     pick one that ships prebuilt for Windows, macOS arm64 and Linux, and check
     its licence against `THIRD_PARTY_LICENSES.md`). Take the top ~200 by
     vector, merge with the BM25 hits, then score with the existing hybrid formula.
   - **Privacy rule S7:** the recall index lives in process memory only, never
     on disk, and `forgetRecallIndex` must drop it. If a persisted index would
     be much faster, **stop and ask the owner** before writing any index to disk.
   - Forget, delete, replace and archive must remove entries from the ANN
     index too (follow how `entriesFor` prunes today).
4. **Measure 1M** and write the final numbers: cold (first search, builds the
   index) and warm p50 / p95, RAM used, at 10k / 100k / 1M.

## Must not change

- Hybrid scoring and weights in `hybrid.ts`, `MIN_RECALL_SCORE`, the
  working-layer boost.
- Results on the recall test sets: `test/multilingual-recall.test.mjs`, the
  P9 test that compares the index path to the full-row path, and
  `scripts/memory-baseline/recall.mjs` / `recall-set-p0.json`. Recall@k may
  not drop.
- Owner scoping: a search never reads another user's rows (see the
  `user_id` checks after reads by primary key).
- Drawer scoping, archived, replaced and agent-notes filters.

## Checks before you report

```bash
cd packages/backend
node --import tsx --test test/multilingual-recall.test.mjs
node --import tsx --test test/*recall*.test.mjs test/*p9*.test.mjs
npx tsc --noEmit
```

Add tests for: top-k heap equals full sort; int8 + re-score gives the same
top results as Float32 on the recall set; forget removes entries from the ANN index.

## Result

Measured 12 November 2026 on Windows 11, Intel i9-14900F (24 cores, 32 threads), 64 GB RAM,
local Ollama `qwen3-embedding:0.6b` for every query. `latency.mjs --vectors semantic --packed`,
owner chat with project alpha open (about 46.5% of all memories), 20 queries of the recall set.
Search time **includes the query embedding (about 55-60 ms)**. Every run is also in
`docs/internal/memory-search-results.json` (the playground page shows them with the change
against the previous run).

- **Branch and commits:** `girru/memory-search-speed-97063e` (worktree; the handoff named
  `memory/search-speed`), not pushed. `ea659ba6` handoff · `a09a6c09` scripts run on Windows ·
  `4e2d3075` step 1 · `d6c81381` step 2 · `f28d37d2` step 3 · `f5434fc3` stable loops, HNSW from
  20k, re-score fixes, tests · `9bf30093` `--json-stub` · `0340cbf6` licences · `552eecc4`
  playground, results log, `GIRRU_RECALL_STORE` switch.

- **Baseline before changes** (P9 recall index, 256 MB cap):

  | Memories | p50 | p95 | First search | Peak RAM |
  |---|---|---|---|---|
  | 10k | 120 ms | 124 ms | 2.3 s (model load) | 452 MB |
  | 100k | 807 ms | 825 ms | 3.1 s | 743 MB |
  | 1M | **32.6 s** | 33.8 s | 36.9 s | 4.1 GB |

  The documented Mac numbers (10k 44 ms, 100k 0.28 s) were on Apple silicon; this Windows
  machine measured 2.9x slower at 100k with the same code, so before/after is compared here.

- **After each step:**
  - Step 1 (store kept in step by id with TEMP triggers, inverted BM25, top-k heap, query norm
    once): 100k p50 807 -> 105 ms. Same results, scores and order (P9 test).
  - Step 2 (int8 vectors past 50k per drawer, Float32 re-score of the best 200): 100k with
    int8 forced p50 111 ms, peak RAM 666 -> 508 MB; the same hits as Float32.
  - Step 3 (usearch HNSW past 100k per drawer): 1M p50 32.6 s -> 135 ms, RAM 4.1 -> 1.5 GB.
  - Final (hot loops V8 keeps optimised, HNSW from 20k per drawer, working-layer rows and the
    hash rule in the re-score):

  | Memories | In open drawers | p50 | p95 | First search (builds the index) | Peak RAM | Index |
  |---|---|---|---|---|---|---|
  | 10k | 4.7k | **85 ms** | 118 ms | 0.4 s | 436 MB | exact |
  | 100k | 46.7k | **95 ms** | 114 ms | 4.6 s | 613 MB | 1 HNSW + 2 exact |
  | 1M | 465k | **90 ms** | 105 ms | 69 s | 1.3 GB | 2 HNSW + 1 exact |
  | 1M (json-stub) | 465k | 82 ms | 100 ms | 63 s | 1.3 GB | same |
  | 3M (json-stub) | 1.4M | **109 ms** | 127 ms | 3.9 min | 3.1 GB | 3 HNSW |
  | 10M (json-stub) | 4.65M | **266 ms** | 575 ms | **26.9 min** | 9.1 GB | 3 HNSW, 7.7 GB index |

  `--json-stub` stores the vector only in the packed column (what search reads when it is
  there; row-memory.ts) so 10M fits on disk (50 GB instead of ~180 GB); at 1M it is within noise
  of the full rows. At 10M the first query after the build took 2.5 s and the times fell over
  the run (575 -> ~150-280 ms): the 50 GB database was not in the OS cache for the re-score reads.

- **Recall test results (before / after):** `recall.mjs --mode ollama` (5,000 distractors, real
  model): before / after the same: hit@5 same language 0.958, cross-language 0.714; MRR 0.958 and
  0.641; leaks 0; stale unchanged; identical with the store forced exact, int8 and HNSW.
  `multilingual-recall.test.mjs`: all 7 tests pass (with and without P9), including the Ollama
  recall@3 thresholds. `store-p9-index.test.mjs`: 6/6 in every mode (default, int8 forced, HNSW
  forced) and with `GIRRU_RECALL_STORE=0`. New `recall-store.test.mjs` 5/5: top-k heap = full
  sort with ties; int8 = Float32 hits; HNSW same top hit for every query and the same top 5 for
  all but at most one; filters exact; replace, delete and edit leave the HNSW index; another
  owner never read; forget drops it; a write by another connection is seen. `npx tsc --noEmit`
  clean.
  Failing on Windows before and after, not memory search: two POSIX file-mode checks
  (`store-p9-backups`), `store-p9-health` (queue file mode), `store-p9b-screens` (Open in Code
  path), `memory-recall-cache` (system prompt prefix differs between turns), and the temp folder
  cleanup of several test files (EPERM while the database is open). Three recall tests imported
  modules by bare `C:` paths and could not start on Windows; fixed.

- **Library chosen for HNSW and why:** `usearch` 2.26.5, Apache-2.0 (bundles NumKong,
  Apache-2.0 / BSD-3-Clause; loaders MIT). Ships prebuilt binaries for win32-x64, darwin
  arm64+x64, linux x64 and arm64, so nothing compiles at install (`hnswlib-node` runs node-gyp).
  int8 quantisation, cosine, removal by key, multi-threaded add. Owner approved it on 12 November
  2026 (D-SEARCH-LIBS). In `THIRD_PARTY_LICENSES.md`. If it does not load, drawers fall back to
  int8 / exact. Note: its parallel insert leaves about 1% of points hard to reach on fully random
  data; the re-score of the best 200 by vector plus the best 200 by words keeps the measured
  recall unchanged.

- **Privacy (S7):** nothing is written to disk. Changed ids come from TEMP triggers that call a JS
  function (connection only, not in the database file). forget / delete / replace / archive leave
  the store and the HNSW index (killSlot); `forgetRecallIndex` drops a user's store; idle 30 min
  drops it; a write by another connection (`PRAGMA data_version`) drops every store.

- **Open questions for the owner:**
  1. **First search after a start at 10M takes 27 minutes** (3M: 4 min, 1M: 1 min) because the
     index lives in RAM only (S7). A saved, encrypted index that forget also deletes would start
     in seconds. Needs your OK because it changes S7.
  2. 10M p50 is 266 ms and p95 575 ms (3M: 109 / 127 ms). The extra time is the BM25 walk of
     long word lists and the re-score reads from a 50 GB database. Next steps if 10M must be
     under 150 ms: per-drawer word counts kept up to date, skipping very common words, keeping
     the 200 re-score vectors in RAM.
  3. For the ad: "1 million memories: 0.09 s per search (was 32.6 s)" and "3 million: 0.11 s"
     are measured on this machine with the query embedding included. 10M is measured too (0.27 s
     median) but needs 9 GB of RAM and a 27-minute first build. Which one should the ad use?
  4. PostgreSQL and the encrypted store still use the P9 path (the change capture is SQLite only).
  5. Measure on the Mac (main machine soon): run `latency.mjs --record` or the playground there.
