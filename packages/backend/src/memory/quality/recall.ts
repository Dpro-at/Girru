import {assertNoDefaultMemoryAccess} from '../encryption/execution-context.js';
/**
 * Reply recall of the quality engine (STORE-MAP-01 P9b, MD5, MD6, MD8;
 * GIRRU_STORE_P9B).
 *
 *   route   (MD5) the message's intent (intent.ts, rules only) picks the
 *           memory types and drawers it prefers; history weighs recency more.
 *   fetch   the usual fast recall: hybrid search (storage.search) and the
 *           knowledge graph, a pool of POOL candidates.
 *   re-rank (MD6) our own scoring, no model: the hybrid score times trust
 *           (confidence, MD3), plus recency, importance, the weight earned
 *           from use (MD7), agent relevance (P9 M3) and the intent fit;
 *           a memory flagged as contradicting a verified one ranks lower.
 *           HARD BUDGET of RERANK_BUDGET_MS (300 ms): when the extra reads are
 *           late, the reply takes the fast ranking and goes on (fellBack).
 *   know    (MD8) when even the best candidate is below RELIABLE_SCORE, there
 *           is no reliable memory: nothing is recalled and the agent is told
 *           to ask the owner ONCE (an open question, pipeline.askOnce); the
 *           same question again within 14 days says "already asked". The
 *           owner's answer, once saved, resolves it (pipeline.stored).
 *
 * The thresholds were set on the P0 recall set (scripts/memory-baseline):
 * every true hit's best score is above RELIABLE_SCORE in both embedding
 * modes, while most questions with no answer stay below it.
 */

import { createHash } from 'node:crypto';
import { getMemoryStorage } from '../storage.js';
import { graphRecall } from '../graph/recall.js';
import { agentProfile, rankedScore, type AgentProfile } from '../agent-relevance.js';
import { getEmbeddingService } from '../embedding.js';
import { lexicalTokens } from '../text-normalize.js';
import { redactImportText } from '../import/redact.js';
import type { DrawerRef } from '../drawers.js';
import type { Memory } from '../types.js';
import { classifyIntent, fitsIntent, isMemoryQuestion, type RecallIntent } from './intent.js';
import { bandOf, confidenceOf, trustRows, type ConfidenceBand, type TrustRow } from './trust.js';
import { askOnce } from './pipeline.js';

export const RERANK_BUDGET_MS = 300;
/** Candidates fetched for the re-rank (the reply keeps at most its own limit). */
export const POOL = 24;
/** Best score below this (hash or semantic embeddings): no reliable memory. */
export const RELIABLE_SCORE = { semantic: 0.16, hash: 0.16 } as const;
/** A single item below this share of the best item's score is left out (fewer, better lines). */
export const ITEM_SHARE = 0.45;
/**
 * Two candidates of one drawer that share at least SIBLING_OVERLAP of the
 * shorter one's content words and SIBLING_JACCARD of all their words are
 * about the same topic; the older one
 * then ranks STALE_SIBLING lower (the newer fact on a topic wins, MD6).
 */
export const SIBLING_OVERLAP = 0.5;
export const SIBLING_JACCARD = 0.4;
export const STALE_SIBLING = 0.8;
/** The newer sibling may be at most this much less confident and still win. */
const SIBLING_TRUST_SLACK = 0.1;
/** A memory found only through the graph counts this share of its graph score. */
export const GRAPH_ONLY = 0.6;
const GRAPH_BOTH_BONUS = 0.05;
/** Graph-only memories below the share kept per reply. */
const GRAPH_KEPT = 2;
const HALF_LIFE_DAYS = { default: 365, history: 45 } as const;
const W = { trustBase: 0.75, trust: 0.35, recency: 0.12, importance: 0.1, intent: 0.12, contradiction: 0.85 } as const;

export type RecallWhy = 'meaning' | 'keyword' | 'graph';

export interface QualityItem {
  memory: Memory;
  /** The re-ranked score (0–~1.3). */
  score: number;
  /** The fast (hybrid or graph) score it started from. */
  base: number;
  why: RecallWhy;
  confidence: number;
  band: ConfidenceBand;
  verified: boolean;
}

export interface QualityRecall {
  items: QualityItem[];
  intent: RecallIntent;
  /** False: no reliable memory (MD8); items is then empty. */
  reliable: boolean;
  /** MD8: the message asks something memory could answer (a question, not a greeting or an order). */
  questionLike: boolean;
  /** The best fast score among the candidates (what MD8 judged). */
  best: number;
  /** True when the re-rank missed its budget and the fast ranking was used. */
  fellBack: boolean;
  rerankMs: number;
  /** MD8: the open question the agent should ask (or already asked). */
  question: { id: string; alreadyAsked: boolean } | null;
}

export interface QualityRecallInput {
  userId: string;
  drawers: readonly DrawerRef[];
  query: string;
  agentId?: string | null;
  /** Items returned at most (default 6). */
  limit?: number;
  /** MEM-ACC-03: extra queries (the head of a question with a relative clause); their hits join the pool at their own score. */
  parts?: readonly string[];
  /** Memory ids already in the prompt (the context pack). */
  skip?: ReadonlySet<string>;
  /** MD8: record the open question when nothing reliable is found (chat replies). */
  ask?: boolean;
  budgetMs?: number;
  now?: number;
}

interface Candidate { m: Memory; base: number; why: RecallWhy }

const ageDays = (m: Memory, now: number) => {
  const t = m.createdAt ? new Date(m.createdAt).getTime() : NaN;
  return Number.isFinite(t) ? Math.max(0, (now - t) / 86_400_000) : 365;
};

/** The re-ranked score of one candidate (pure). */
export function rerankScore(c: Candidate, ctx: { intent: RecallIntent; now: number; trust: ReadonlyMap<string, TrustRow>; profile: AgentProfile | null }): { score: number; confidence: number; verified: boolean } {
  const t = confidenceOf(c.m, ctx.trust);
  const row = ctx.trust.get(c.m.id);
  const half = ctx.intent === 'history' ? HALF_LIFE_DAYS.history : HALF_LIFE_DAYS.default;
  const recency = Math.pow(0.5, ageDays(c.m, ctx.now) / half);
  const importance = (typeof c.m.importanceScore === 'number' ? c.m.importanceScore : 0.5) - 0.5;
  // MD7: only a verified memory has a positive use weight (usage.ts); a negative one may apply to any.
  const use = row ? (row.verified ? row.useWeight : Math.min(0, row.useWeight)) : 0;
  let s = c.base * (W.trustBase + W.trust * t.confidence) * (1 + W.recency * recency + W.importance * importance + use);
  if (fitsIntent(ctx.intent, c.m, c.why === 'graph')) s *= 1 + W.intent;
  if (row?.flags.some((f) => f.startsWith('contradicts:'))) s *= W.contradiction;
  s = rankedScore(s, ctx.profile, c.m);
  return { score: s, confidence: t.confidence, verified: t.verified };
}

/**
 * Same drawer, same topic (shared words), both relevant: the older one loses
 * STALE_SIBLING (in place) — unless the newer one is clearly less trusted
 * (a tool's newer text never pushes down the owner's fact).
 */
export function demoteOlderSiblings(list: Array<{ c: Candidate; score: number; confidence?: number }>, best: number): void {
  const strong = list.filter((x) => x.c.base >= best * 0.5).slice(0, POOL);
  const words = new Map(strong.map((x) => [x.c.m.id, new Set(lexicalTokens(x.c.m.content))]));
  const older = new Set<string>();
  for (let i = 0; i < strong.length; i++) {
    for (let j = i + 1; j < strong.length; j++) {
      const a = strong[i].c.m, b = strong[j].c.m;
      if ((a.drawer?.kind ?? '') !== (b.drawer?.kind ?? '') || (a.drawer?.key ?? '') !== (b.drawer?.key ?? '')) continue;
      const wa = words.get(a.id)!, wb = words.get(b.id)!;
      const min = Math.min(wa.size, wb.size);
      if (min < 2) continue;
      let shared = 0;
      for (const t of wa) if (wb.has(t)) shared++;
      // Both: most words of the shorter one, and a good share of all words (a shared label alone is no topic).
      if (shared / min < SIBLING_OVERLAP || shared / (wa.size + wb.size - shared) < SIBLING_JACCARD) continue;
      const ta = new Date(a.createdAt).getTime(), tb = new Date(b.createdAt).getTime();
      if (ta === tb) continue;
      const [o, nw] = ta < tb ? [strong[i], strong[j]] : [strong[j], strong[i]];
      if ((nw.confidence ?? 0.6) + SIBLING_TRUST_SLACK < (o.confidence ?? 0.6)) continue;
      older.add(o.c.m.id);
    }
  }
  for (const x of list) if (older.has(x.c.m.id)) x.score *= STALE_SIBLING;
}

/** Normalized question text for "asked once" (same words, any order or case). */
export function questionHash(userId: string, query: string): string {
  const words = [...new Set(lexicalTokens(query))].sort().join(' ') || query.trim().toLowerCase();
  return createHash('sha256').update(`${userId}\n${words}`).digest('hex').slice(0, 32);
}

function timeout(ms: number): { promise: Promise<'late'>; clear: () => void } {
  let t: NodeJS.Timeout | undefined;
  const promise = new Promise<'late'>((r) => { t = setTimeout(() => r('late'), ms); t.unref?.(); });
  return { promise, clear: () => clearTimeout(t) };
}

export async function qualityRecall(input: QualityRecallInput): Promise<QualityRecall> {
  assertNoDefaultMemoryAccess();
  const intent = classifyIntent(input.query);
  const limit = input.limit ?? 6;
  const questionLike = isMemoryQuestion(input.query, lexicalTokens(input.query).length);
  const empty: QualityRecall = { items: [], intent, reliable: false, questionLike: questionLike, best: 0, fellBack: false, rerankMs: 0, question: null };
  const query = input.query.trim().slice(0, 2000);
  if (!query || input.drawers.length === 0) return empty;
  const skip = input.skip ?? new Set<string>();
  const drawers = [...input.drawers];
  const pool = Math.max(POOL, limit) + skip.size;
  const [found, graph] = await Promise.all([
    getMemoryStorage().search({ userId: input.userId, query, drawers, limit: pool, mode: 'hybrid' }),
    graphRecall({ userId: input.userId, drawers }, query, { limit: Math.min(pool, 12) }),
  ]);
  const now = input.now ?? Date.now();
  const byId = new Map<string, Candidate>();
  for (const r of found) byId.set(r.memory.id, { m: r.memory, base: r.similarity, why: (r.scoreBreakdown?.keywordScore ?? 0) > 0 ? 'keyword' : 'meaning' });
  for (const part of (input.parts ?? []).slice(0, 2)) {
    const extra = await getMemoryStorage().search({ userId: input.userId, query: part.trim().slice(0, 2000), drawers, limit: pool, mode: 'hybrid' });
    for (const r of extra) {
      const prev = byId.get(r.memory.id);
      if (!prev) byId.set(r.memory.id, { m: r.memory, base: r.similarity, why: (r.scoreBreakdown?.keywordScore ?? 0) > 0 ? 'keyword' : 'meaning' });
      else if (r.similarity > prev.base) prev.base = r.similarity;
    }
  }
  for (const g of graph) {
    const prev = byId.get(g.memory.id);
    // A named entity (say a project or a person's name) links many memories with one graph score, so
    // the graph only confirms: found both ways adds a small bonus to the search score; found by the
    // graph alone counts GRAPH_ONLY of its graph score and never outranks a real match.
    if (prev) prev.base += GRAPH_BOTH_BONUS;
    else byId.set(g.memory.id, { m: g.memory, base: g.similarity * GRAPH_ONLY, why: 'graph' });
  }
  const candidates = [...byId.values()].filter((x) => !skip.has(x.m.id) && (x.m.status ?? 'active') === 'active'
    && !(x.m.expiryTimestamp && x.m.expiryTimestamp <= now));

  // MD8: judged on the fast score, so the answer does not depend on whether the re-rank was in time.
  const best = candidates.reduce((s, c) => Math.max(s, c.base), 0);
  // The query's vector is cached by the search above (semantic model) or cheap (hash).
  const semantic = (await getEmbeddingService().embedQuery(query)).semantic;
  const reliable = candidates.length > 0 && best >= (semantic ? RELIABLE_SCORE.semantic : RELIABLE_SCORE.hash);

  const t0 = performance.now();
  const budget = timeout(input.budgetMs ?? RERANK_BUDGET_MS);
  const work = (async () => {
    const [trust, profile] = await Promise.all([
      trustRows(input.userId, candidates.map((c) => c.m)),
      agentProfile(input.agentId).catch(() => null),
    ]);
    return candidates.map((c) => ({ c, ...rerankScore(c, { intent, now, trust, profile }) }));
  })();
  const scored = await Promise.race([work, budget.promise]).finally(budget.clear);
  const elapsed = performance.now() - t0;
  const rerankMs = Math.round(elapsed * 10) / 10;
  // A hard budget: late is late, even when the extra reads finished just before the timer fired.
  const fellBack = scored === 'late' || elapsed > (input.budgetMs ?? RERANK_BUDGET_MS);
  work.catch(() => undefined);
  const ranked = fellBack
    ? candidates.map((c) => ({ c, score: c.base, ...confidenceOf(c.m, new Map()) }))
    : scored;
  if (!fellBack) demoteOlderSiblings(ranked, best);
  ranked.sort((a, b) => b.score - a.score);

  if (!reliable) {
    let question: QualityRecall['question'] = null;
    if (input.ask && questionLike) {
      const text = redactImportText(query).text.replace(/\s+/g, ' ').slice(0, 300);
      question = await askOnce(input.userId, input.agentId ?? null, text, questionHash(input.userId, query)).catch(() => null);
    }
    return { items: [], intent, reliable: false, questionLike: questionLike, best, fellBack, rerankMs, question };
  }
  const top = ranked[0]?.score ?? 0;
  // A person or history question: a graph link (the person the message names) is kept even when its score
  // is low (it is why the memory is here), but at most GRAPH_KEPT of them.
  let graphKept = 0;
  const graphIntent = intent === 'person' || intent === 'history';
  const items = ranked.filter((x) => x.score >= top * ITEM_SHARE || (graphIntent && x.c.why === 'graph' && graphKept++ < GRAPH_KEPT)).slice(0, limit).map((x) => ({
    memory: x.c.m, score: x.score, base: x.c.base, why: x.c.why, confidence: x.confidence, band: bandOf(x.confidence), verified: x.verified,
  }));
  return { items, intent, reliable: true, questionLike: questionLike, best, fellBack, rerankMs, question: null };
}
