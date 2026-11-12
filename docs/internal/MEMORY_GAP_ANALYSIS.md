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
| 13 | All languages of the embedding model | Partial | `text-normalize.ts:336` | Semantic search is multilingual already (qwen3-embedding). Lexical side: Arabic, Iraqi, German, English have rules; **Chinese/Japanese** without spaces become one token per run; **Hindi/Indic** words split at vowel signs (`\p{M}` dropped); Cyrillic has no stop words. Fix the tokenizer (keep marks; character bigrams for CJK), then a per-language benchmark. | S–M | lexical recall for those scripts | per-language accuracy table |
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
