# Memory search playground (internal)

A local page to try memory search after every change to the memory code, and to keep
every measurement so each improvement shows its difference.

## Run it

```bash
cd packages/backend
node --max-old-space-size=32768 --import tsx scripts/memory-baseline/playground.mjs
```

Open <http://127.0.0.1:41890> (`--port` changes the port).

1. **Test data**: pick a size (1k to 10M) and the vectors:
   - *random semantic*: fast at any size; queries are embedded by the real local model
     (`qwen3-embedding:0.6b`), so timings are real; the random memories only compete by words.
   - *real model*: every memory embedded by the local model (up to 50,000; slow).
   - *hash*: the offline fallback.
   The recall test set (`scripts/memory-baseline/recall-set-p0.json`) is always added, so the
   suggestions have known right answers.
2. **Search**: type a question or click a suggestion (English, Arabic, Iraqi dialect, German).
   The page shows total, search and embedding time, cold or warm index, index size and
   drawer modes, process RAM, and whether the expected memory was found (and at which rank),
   whether a "no answer" question returned anything, and whether a closed drawer leaked.
   *Mode* compares: `auto` (the defaults), `exact`, `int8`, `hnsw`, and `old P9 scan` (before
   MEM-SPEED-01: reads every row of the open drawers; slow past 100k).
3. **Benchmark**: runs 20 to 72 test questions (cold build first, each question with a
   fresh embedding) and saves p50 / p95, embedding time, cold time, RAM, index size,
   hit@5 and MRR to `docs/internal/memory-search-results.json`.
4. **All results**: every saved run per machine, with Δ against the previous run of the same
   size on the same machine, and a chart of the first and the latest run at each size.

From the command line the same file is filled by:

```bash
GIRRU_STORE_P9=1 node --max-old-space-size=32768 --import tsx scripts/memory-baseline/latency.mjs --size 1000000 --vectors semantic --packed --record "what changed"
```

## Safety

- A new throwaway data folder for every start (own database, HOME and test-only secrets);
  the owner's real memory is never read or written. Ctrl+C deletes the folder.
- Listens on 127.0.0.1 only and answers only requests addressed to it; network calls are
  limited to loopback (the local Ollama); the app's own ports are refused.
- The results file holds numbers, settings, the machine, the commit and test-set questions,
  never real memory text.

## Search switches (for comparisons)

| Variable | Default | Effect |
|---|---|---|
| `GIRRU_RECALL_STORE` | on | `0`: the P9 path that reads every row (before MEM-SPEED-01) |
| `GIRRU_RECALL_EXACT_MAX` | 50,000 | a drawer with more memories keeps int8 vectors (when no HNSW) |
| `GIRRU_RECALL_ANN_MIN` | 20,000 | a drawer with more memories gets an HNSW index (usearch) |
| `GIRRU_RECALL_RESCORE` | 200 | candidates re-scored with their full vector |
| `GIRRU_RECALL_INDEX_MB` | ¼ of RAM | the index size cap; past it search falls back to the P9 path |
| `GIRRU_RECALL_ANN_THREADS` | all cores | `1`: the same HNSW graph on every run (tests) |
| `GIRRU_RECALL_CONTEXT` | on | `0`: a chat recalls with the last message alone (before MEM-ACC-02) |
| `GIRRU_RECALL_PARTS` | on | `0`: no extra search for the head of a question with a relative clause (MEM-ACC-03) |

## Accuracy test (MEM-ACC-01)

`scripts/memory-baseline/accuracy.mjs` hides a simulated world (10 projects, 15 people, 1,280
questions with known answers, conversations and topic switches) among generated memories, all
embedded by the real local model, and measures what a chat recalls: Recall@5, Hit@1, wrong
project, mix-ups, temporal, multi-hop, no-answer, leaks and time. `--mode A` asks with the last
message only, `--mode B0` with the context query a chat uses now.

```bash
node --max-old-space-size=16384 --import tsx scripts/memory-baseline/accuracy.mjs --mode B0 --distractors 100000 --cache <folder outside the repo>
```
