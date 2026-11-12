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

## Result (fill in)

- Branch and commits:
- Baseline before changes (10k / 100k / 1M, cold and warm p50 / p95, RAM):
- After each step:
- Recall test results (before / after):
- Library chosen for HNSW and why (licence, platforms):
- Open questions for the owner:
