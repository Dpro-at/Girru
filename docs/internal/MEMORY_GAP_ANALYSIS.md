# Girru memory: gap analysis (18 capabilities)

12 November 2026, code on branch `girru/memory-accuracy` (based on `main` after PR #212). Paths are
under `packages/backend/src/`. Status: **Done** (implemented), **Partial**, **Missing**. Complexity:
S (days), M (a week or two), L (several weeks). Measured numbers come from the accuracy test
(`scripts/memory-baseline/accuracy.mjs`: 1,280 questions among 100k memories with real embeddings,
answers by local `qwen2.5:7b`).

## Answers to the two direct questions

- **Does Girru train model weights at night?** No. Nothing in `src` fine-tunes or trains (no
  fine-tune, LoRA or training code; `memory/quality/usage.ts`: "No model, no training"). Night and
  weekly jobs analyse, summarise, flag and propose; models are used for inference only (embeddings,
  graph extraction, an optional summary rewrite).
- **Night and weekly jobs today** (`memory/jobs.ts`, per owner): doctor 02:40 (read-only checks),
  trash 03:30, retention 04:00 (if the owner turned it on: summarises ended tasks, consolidates old
  experience, forgets stale people facts), quality Mon 05:20 (repeated lessons → rule/skill
  proposals, project summaries), usage Mon 05:50 (use weights, decay, corrected-after-use flags),
  weekly summary Mon 08:00, documents every 20 min. Outside it: legacy consolidation 03:00
  (`services/memory-consolidation.ts`, expiry and tiers, merges nothing) and agent evolution
  proposals.

## Part 1: retrieval

| # | Capability | Status | Where | Gap and recommended change | Size | Effect | Tests |
|---|---|---|---|---|---|---|---|
| 1 | Related memories 2.0 (typed links by memory id) | Partial | `memory/graph/*`, migrations 101 (links), 048 `memory_relationships` | Graph links join **entities** (works_on, prefers, decided, part_of, depends_on, replaces, contradicts) with source memories and owner approval; memory-to-memory links exist only as a legacy keyword-overlap table. Add memory-to-memory links (caused_by, resulted_in, decided_by, supersedes, belongs_to) with confidence and provenance, filled from existing signals (supersedes from `superseded_by`, contradicts from conflicts, decided_by from graph `decided`), and expand only links whose target matches the question's words. | M | Related recall ↑, multi-hop ↑; +1 indexed read per search | related-recall in the accuracy test; permission/forget tests |
| 2 | Multi-hop | Partial | `graph/recall.ts:78` (≤2 hops, 25 entities/hop, permission-checked), new `context/query.ts` question split | Graph traversal exists; retrieval missed the answer when the question's clause dominated (0.45 R@5). **In progress (mode C):** search the question's head as well. Next: follow memory links from (1). | S→M | multi-hop answers 35% → measured next | multi-hop questions in the test (both hops in top 5) |
| 3 | Context-aware search | Done (new) | `context/query.ts`, `context/entities.ts`, `agent/execution/chat-turn.ts:591` | B0: conversation entity + names in all scripts; Recall@5 0.42 → 0.84, no mix-ups. Next: aliases across scripts are only as good as the graph's (13). | — | measured | `context-query`, `chat-recall-query` tests |
| 4 | No-answer detection | Partial (end to end good) | `quality/recall.ts` (RELIABLE_SCORE gate, ask-once) | Retrieval always returns related memories; **end to end** the local model says "not in memory" for 116/120 questions with no answer (97%). A match-strength label reached 120/120 but cost 9 points of correct answers, so not adopted. Next: an answerability check on the top few only (reranker, needs a model download) if 97% is not enough. | M | +3 points no-answer | answers test (`--answer-model`) |
| 5 | Temporal / historical search | Partial | `validity.ts` (valid_from/to, superseded_by), `storage.ts:486` (`NOT_REPLACED_SQL`), versions API | Replaced facts are hidden from every search; history is browsable, not searchable. Add an explicit history mode (intent "history" or a date in the question → include replaced rows, labelled "replaced on …", never as current). | M | time-travel 55% → | time-travel questions; replaced never ranked as current |

## Part 2: night intelligence

| # | Capability | Status | Where | Gap and recommended change | Size | Effect | Tests |
|---|---|---|---|---|---|---|---|
| 6 | Relationship discovery | Partial | `graph/store.ts:220 onMemorySaved`, `graph/extract.ts` (local model or rules EN/AR/DE) | Extraction runs per saved memory only; no job links existing memories. Add a night job that proposes memory links (from 1) for new memories, stored as derived with confidence, never as confirmed facts. | M | related recall ↑ | job only proposes; forget removes its links |
| 7 | Conflict analysis | Partial | `contradiction.ts`, `learning.ts`, `quality/pipeline.ts` | Conflicts are caught at write time (proposal keep new/old/both) and flagged against verified facts; no periodic scan. Add a doctor/night check that separates history (one replaced the other), different scope, proposal vs decision, and proposes only real conflicts. | M | fewer stale answers | conflict cases in the world |
| 8 | Consolidation with links | Partial | `retention.ts`, `weekly-summary.ts`, `project-summary.ts`, `lessons.ts` | Weekly digest and lesson proposals keep memory ids; retention summaries keep counts only (originals then forgotten) and project summaries keep a hash only. Keep source ids on every summary. | S | traceable summaries | summary → source ids; forget updates them |
| 9 | Night self-testing | Missing | (only the offline benchmark scripts) | Generate questions from **verified** memories (templates per fact kind, no model needed for most), run them at night through the real recall path, record pass/fail in the health view. Reuse the accuracy test's scoring. | M | catches regressions | generated tests validated against their source |
| 10 | Corrections → regression tests | Partial | `quality/usage.ts` (corrected-after-use flag) | Store each approved correction as a test case: current question → new fact; history question → old fact; old never as current. Run with (9). | S | prevents old facts returning | the OVH → new provider example |
| 11 | Retrieval failure analysis | Partial | `health.ts` (`recall_failed` = exceptions), traces, ask-once questions | Add a reason per failed self-test (missing context, entity, language, link, stale fact, ranking) and proposals; never change ranking weights automatically. | M | targeted fixes | each reason reproduced in a test |
| 12 | Night health report | Done (no quality metric) | `health.ts`, `doctor.ts` | Add self-test pass rate, conflicts, duplicates, index size and RAM to the existing view. | S | visibility | report holds counts only |

## Part 3–4: languages and integrity

| # | Capability | Status | Where | Gap and recommended change | Size | Effect | Tests |
|---|---|---|---|---|---|---|---|
| 13 | All languages of the embedding model | Partial → tokenizer done (MEM-LANG-01: Indic marks kept, CJK/Thai bigrams); per-language benchmark open | `text-normalize.ts:336` | Semantic search is multilingual already (qwen3-embedding). Lexical side: Arabic, Iraqi, German, English have rules; **Chinese/Japanese** without spaces become one token per run; **Hindi/Indic** words split at vowel signs (`\p{M}` dropped); Cyrillic has no stop words. Fix the tokenizer (keep marks; character bigrams for CJK), then a per-language benchmark. | S–M | lexical recall for those scripts | per-language accuracy table |
| 14 | Version-aware references | Partial → agent edits done (MEM-VER-01: memory_search shows `Id … | Version vN`, memory_edit/delete refuse an older version) | `memory-files.ts`, `api/routes/memory.ts:306` (optional expectedVersion → 409), `services/mcp-memory-proposals.ts` | Drawer files check at drawer level; `### m:<id>` lines carry no version; agent `memory_edit` and bridge `memory_propose` do not send the version they read. Add `v<n>` to exports and results; require it in `memory_edit` / `memory_propose`; a stale edit becomes a conflict proposal. | S | no overwrite of newer facts | stale edit refused / proposed |
| 15 | Evidence and provenance | Partial | `quality/trust.ts`, `validity.ts`, graph link sources | Memories have source and trust; links have source memories and approval, no confidence; summaries lack source ids. Add confidence + method (model/rule/owner) to derived links and summaries; recall labels inferred vs verified. | S–M | fewer inferences treated as facts | derived info never shown as verified |
| 16 | Forget integrity | Mostly done | `forget.ts:233-300` | Cleans rows, versions, indexes, graph, summaries, rules, proposals, files, caches (incl. the new recall store and names). Left: `memory_recall_uses` / `memory_recall_traces` (ids only), chat messages and conversation summaries that quoted the text, already written retention summaries, managed bridge brief files until their next sync. Decide which of these must go; re-export bridge files on forget. | S | privacy | forget test across SQLite, RAM index, MCP, files |

## Part 5–6: benchmarks and scale

| # | Capability | Status | Gap and recommended change |
|---|---|---|---|
| 17 | Benchmarks A/B/C, LongMemEval, LoCoMo | Partial | Own accuracy test done (A, B0, C running). LongMemEval (MIT, `s` 277 MB) next; LoCoMo is CC BY-NC (internal only). |
| 18 | 10M, RAM, PostgreSQL, MCP coverage | Partial | 10M measured (266 ms p50, 9 GB, 27 min first build). **PostgreSQL**: supported as a store, but the fast store is SQLite-only and PG search uses the older in-process path (no pgvector, `indexer-pg.ts` unused by search): port change capture to PG (triggers + a change table or LISTEN). MCP `memory_search` does not cover documents or handoffs. |

## Recommended order (unchanged rules: SQLite source of truth, RAM-only indexes, no cloud, no model call per search, measure before and after)

1. Finish C (question split) and measure → 2. version-aware edits (14) → 3. memory links + related
expansion (1, 2) → 4. history mode (5) → 5. corrections as tests + night self-testing (10, 9) →
6. tokenizer for CJK/Indic + per-language benchmark (13) → 7. LongMemEval → 8. PostgreSQL fast path,
MCP coverage, 10M tail.

## Agreed roadmap, 2026-11-13 (answer reliability first)

Owner's priority: Girru must know which facts a question needs and whether it holds enough evidence for each part
before it answers. No dialect-specific work; every fix is at the search-engine level for all languages. Search
speed stays under about 100 ms p50. Each step is measured on its own (search, then final answers by the local
model: correct, wrong, correct answers lost), and the owner decides from the numbers.

Why this order: in the last measurement most wrong answers to indirect questions came when search never found
the memory (the query kept the project's name but dropped the conversation's topic, and memories naming no project
outranked the project's own). A gate cannot fix a memory that was not found, so the evidence is found first, then judged.

| # | Step | What it does | Measure |
|---|---|---|---|
| 1 | **Active context: topic** (MEM-CTX-01) | The query keeps the rarest words (by idf over the owner's memory, any language) of the message that brought the project up | Indirect recall@5 (77% before); topic-switch not worse |
| 2 | **Active context: project anchor** | In a conversation about a project, a memory that neither names it nor sits in its drawer counts less | Recall; share of off-project memories in the top 6 |
| 3 | **Evidence gate** | Replaces Weak Drop (it lost 42 correct answers to save 29 wrong): a measured signal from meaning and word coverage between the question and the memory | Wrong answers down; every correct answer lost counted |
| 4 | **Memory-to-memory links / related** | A strong memory brings its siblings on the same project and subject (e.g. "we switched to X" ↔ "why we switched") | Indirect and multi-hop |
| 5 | **Question planner + coverage** | The question split becomes a plan (why / who / outcome) with an evidence bundle per part; a part without evidence is said to be missing | Multi-part questions: complete and correct |
| 6 | **Memory simulation tests** | A simulated project lifetime (tech change, cancelled decision, new owner, moved file, edited doc, forgotten memory); questions at each stage | No mix-ups across states and versions |
| 7 | **Nightly retrieval training** | Night self-test; corrections the owner approved become tests | Recall over time |
| 8 | Later | Provenance on links, consolidation with originals kept, memory budget optimizer | Tokens per answer, no accuracy loss |

Not repeated: HNSW, the knowledge graph and version history already exist. Code Intelligence and project discovery
stay plan-only ([CODE_INTELLIGENCE_PLAN.md](CODE_INTELLIGENCE_PLAN.md)).

### Measured and rejected, 2026-11-13 (kept so it is not tried again)

All on the accuracy test, 100k memories with real embeddings, final answers by local `qwen2.5:7b`,
mode E. Run-to-run noise on the same prompt is about ±10 answers, so a difference under that is not one.

| Tried | Result | Decision |
|---|---|---|
| **Topic words in the query** — the rarest words (idf) of the message that brought the project up | Indirect recall@5 0.74 → 0.59, top-1 0.55 → 0.44 | Rejected. In mixed-language memory, filler in the rarer language ("going", "yesterday") scores as rare and crowds out "database". |
| **The whole topic message as an extra query** | Indirect recall@5 0.74 → 0.75, top-1 0.55 → 0.42, p95 121 → 205 ms | Rejected. No recall gain, one extra search per turn. |
| **Project anchor** — a memory that neither names the conversation's project nor sits in its drawer counts less | Not built | Rejected by design: most real memories in a project drawer never repeat the project's name, so this scores well on generated distractors and would demote the owner's real memories. |
| **Weak Drop** — recall all-weak means nothing reliable | Wrong 87 → 61, correct 367 → 310 | Rejected: lost 42 correct to save 29 wrong. |
| **Evidence gate** — top hit shares almost no word with the question *and* the question's own words (names out) are in no recalled memory | Tuning questions: wrong 87 → 52, correct 367 → 358, invented 1 → 0. **Held-out questions (never used to pick the thresholds): 4 wrong prevented, 9 correct lost** (correct 139 → 136, wrong 74 → 75) | Rejected. The gain did not hold on questions it was not tuned on. |

Findings worth keeping:
- **`RELIABLE_SCORE` filters nothing in practice**: all 120 no-answer questions pass it. Abstaining has to come from somewhere else.
- **Semantic strength cannot tell a good hit from a confusing one here**: among the questions the gate blocked, the prevented wrong answers had a *higher* bare-question cosine (median 0.614) than the correct answers lost (0.515). Distractors are about the same topic, so meaning alone is what misleads. An exception of the form "strong semantic match, let it through" recovers 3 correct and brings back 2 wrong — noise.
- **Some "correct" answers are guesses**: of 8 correct answers the gate cost on the tuning set, 3 had no retrieved target at all. A measurement that counts them as losses overstates the cost.
- **The real bottleneck is retrieval, not the answer format**: in every question the gate blocked, search had not found the target. Indirect questions whose wording shares no word with the memory are the open problem.
- **Held-out question set**: `buildWorld(seed, { heldOut: true })` / `--held-out` — 10 other indirect wordings and 8 other no-answer questions. Every future change is checked on it before it is adopted.

## Adopted, 2026-11-13 (measured on held-out questions and with a strong model)

| # | Change | Measured |
|---|---|---|
| **MEM-CTX-02** | The recall query keeps topic words from the message that brought the project up, but only words the owner's memory of those drawers actually uses (`drawerTermCounts`), rarest there first, and never fewer than two (one word only ever cost hits) | Held-out indirect recall@5 0.79 → **0.86**, cross-language 0.858 → 0.879, search p50 106.6 → 107.0 ms. On the 14 held-out questions whose recall changed, a strong model went 8 → **14 of 14 correct, 0 wrong**; the local qwen2.5:7b went 2 → 6 wrong on the same evidence |
| **MEM-CONC-01** | The next memory version is claimed inside one transaction, so `UNIQUE(memory_id, version)` decides the winner. `lockName` is a no-op on SQLite, so the old read-then-write let two processes edit from one version | 3 processes, one memory: 2 saved / 1 refused (a lost update) → **1 saved / 2 refused**, three runs |
| **MEM-CONC-02** | The graph prune after a save covers only the entities and links that memory held, by id. `pruneGraphStep` scans every memory of the owner five times and ran on every save | One save at 100,000 memories: **950 ms → 1 ms**. Saves in 8 s: 4 → 1,472 |

### Measuring tools added
- `agents.mjs` — several agents in their own processes on one SQLite file: reads together (1 / 3 / 6), reads while another saves, three edits of one memory, handoff travel time, project isolation.
- `save-profile.mjs` — where one save spends its time at a given size.
- `accuracy.mjs --pack` + `pack-diff.mjs` + `pack-score.mjs` — the two-level test: what a chat would send a model, the questions where a change altered recall, and a mechanical score of any model's answers. Girru's own score is recall; a local model's answers are a secondary signal.

### MEM-CONC-03: the change log (fixed)
One agent's write used to rebuild every other agent's index: the change capture is TEMP, so another
connection's write was visible only as `PRAGMA data_version` moving. Triggers in the database now
append the owner and id of every write, and each process re-reads only those rows by primary key.
Paired runs at 100,000 memories, log off then on, back to back on one machine:

| | Off | On |
|---|---|---|
| Search p95 while another saves | 3,503 ms | **18.8 ms** |
| A handoff becomes visible after | 2,277 ms | **0 ms** |
| Memories saved in 8 s meanwhile | 1,527 | **2,260** |
| Search p50 while another saves | 6.5 ms | 11.1 ms |
| Searching alone | same either way (within this machine's drift) | |

The median search during a save rises because the readers now apply those writes instead of ignoring
them until a rebuild. Switch: `GIRRU_RECALL_CHANGELOG=0`. Rows older than an hour are pruned, at most
every five minutes; a process idle longer rebuilds, as before. The log holds ids only, never memory
text, and the index still never goes to disk.

**Still open:** the same mechanism for PostgreSQL (item 18) — its search uses the older in-process path
and has no change capture at all.
