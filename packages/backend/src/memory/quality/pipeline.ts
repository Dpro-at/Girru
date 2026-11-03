/**
 * One write pipeline for every source (STORE-MAP-01 P9b, MD1; GIRRU_STORE_P9B).
 *
 * Every memory, whoever writes it, passes the same steps:
 *
 *   1 capture        chat extraction (retrieval.ts), an agent's memory_save
 *                    (repositories/memory-recall.ts), MCP and coding tools
 *                    (memory/bridge/*), a run's working notes, channel turns
 *                    (origin outsider): all through learn(); imports and edited
 *                    exports through a proposal (memory-files.ts); the owner's
 *                    own saves through the memory repository.
 *   2 split          one fact per memory (write-quality.ts splitFacts, P9 M1).
 *   3 link entities  the knowledge graph, queued after the save (graph/store.ts
 *                    onMemorySaved) — the only step that may use a local model,
 *                    always in the background.
 *   4 dedupe/merge   by topic key and near-duplicates on write (learning.ts);
 *                    a duplicate from another source is not saved again, it
 *                    CORROBORATES the known memory (MD3, trust.ts).
 *   5 contradiction  a contradiction is a proposal, keep-new supersedes (P9 M4).
 *   6 importance, trust, sensitivity   calibrated importance (M1); confidence
 *                    from the source (trust.ts); special-category and personal
 *                    data ask the owner (P9 PRIV3/PRIV7).
 *   7 store          with provenance: the write source, the source key (which
 *                    agent, which tool, which conversation day), time.
 *
 * LAT rule 2: steps 1–2 and 4–7 are rule based (no generative model) and the
 * memory is stored and findable at once, its trust record "pending". The
 * background queue then enriches it: waits for the entity links, finds
 * near-duplicates the write could not see (other sources saved the same fact
 * through another path: both corroborate each other), flags a contradiction
 * with a verified memory and sensitive text, and marks it "ready". The queue
 * pauses between small batches and no reply ever waits for it.
 *
 * Also MD8: a stored fact whose words answer an open question of the owner
 * resolves it (recall.ts asked it once).
 */

import { v4 as uuidv4 } from 'uuid';
import { all, one, run, sql, type Step } from '../../repositories/sql-steps.js';
import { storeP9bEnabled } from '../../services/store-p9b.js';
import { storeP3Enabled } from '../../services/store-p3.js';
import { getMemoryStorage } from '../storage.js';
import { graphIdle } from '../graph/store.js';
import { nearDuplicate } from '../write-quality.js';
import { detectContradiction } from '../contradiction.js';
import { personalDataKinds, specialCategory } from '../personal-data.js';
import { lexicalTokens } from '../text-normalize.js';
import { corroborateStep, trustRows, trustTablesReady, type TrustKind, type TrustSource } from './trust.js';
import type { Memory } from '../types.js';

/** What a learned candidate says about where it came from. */
export interface CaptureOrigin {
  origin: 'owner' | 'agent' | 'extraction' | 'outsider';
  /** The version actor: an owner id, `agent:<id>`, `extraction`, `bridge:<client>`. */
  actor: string;
  agentId?: string | null;
  reviewReason?: string | null;
  /** Chat extraction: the conversation, when known. */
  sessionId?: string | null;
}

const day = (at: string) => at.slice(0, 10);

/** The source of a learned item (pure). */
export function sourceOfCapture(c: CaptureOrigin, at: string): TrustSource & { label: string } {
  if (c.origin === 'outsider') return { kind: 'channel', key: `channel:${c.agentId ?? 'unknown'}`, label: 'channel' };
  if (c.actor.startsWith('bridge:')) return { kind: 'tool', key: c.actor.slice(0, 80), label: 'coding tool' };
  if (c.reviewReason === 'repository-file') return { kind: 'tool', key: `repository:${c.agentId ?? c.actor}`.slice(0, 80), label: 'repository file' };
  if (c.reviewReason === 'run-notes') return { kind: 'tool', key: `run-notes:${c.agentId ?? 'unknown'}`, label: 'run notes' };
  if (c.origin === 'extraction') return { kind: 'chat', key: `chat:${c.sessionId ?? day(at)}`, label: 'chat' };
  if (c.origin === 'agent') return { kind: 'agent', key: `agent:${c.agentId ?? 'unknown'}`, label: 'agent' };
  return { kind: 'owner', key: 'owner', label: 'owner' };
}

/** The source a proposal's text came from (createdBy and reasons), before the owner's approval. */
export function sourceOfProposal(p: { source: string; createdBy: string; reasons: readonly string[]; agentId?: string | null }, ownerId: string): TrustSource & { label: string } {
  if (p.source === 'import') return { kind: 'import', key: 'import', label: 'import' };
  if (p.source === 'upload' || p.source === 'file') return { kind: 'owner', key: 'owner', label: 'owner' };
  if (p.reasons.includes('outsider')) return { kind: 'channel', key: `channel:${p.agentId ?? 'unknown'}`, label: 'channel' };
  if (p.createdBy.startsWith('bridge:') || p.reasons.includes('repository-file')) return { kind: 'tool', key: p.createdBy.slice(0, 80), label: 'coding tool' };
  if (p.reasons.includes('run-notes')) return { kind: 'tool', key: `run-notes:${p.agentId ?? 'unknown'}`, label: 'run notes' };
  if (p.createdBy === 'extraction') return { kind: 'chat', key: 'chat:proposal', label: 'chat' };
  if (p.createdBy.startsWith('agent:')) return { kind: 'agent', key: p.createdBy.slice(0, 80), label: 'agent' };
  if (p.createdBy === ownerId) return { kind: 'owner', key: 'owner', label: 'owner' };
  return { kind: 'system', key: `system:${p.createdBy.slice(0, 60)}`, label: 'system' };
}

const nowIso = () => new Date().toISOString();

/**
 * Step 7: the memory is stored; record where it came from (and, for an
 * approval, the owner's approval) and queue its enrichment. Never throws:
 * the memory is saved already, a missing trust record only means the legacy
 * confidence is shown.
 */
export async function stored(memories: ReadonlyArray<Memory | null | undefined>, sources: ReadonlyArray<TrustSource & { label?: string }>): Promise<void> {
  const list = memories.filter((m): m is Memory => !!m && !!m.id);
  if (!list.length || !sources.length || !storeP9bEnabled() || !(await trustTablesReady())) return;
  const at = nowIso();
  const first = sources[0].label ?? sources[0].kind;
  try {
    await sql().tx(function* (): Step<void> {
      for (const m of list) {
        for (const s of sources) yield* corroborateStep(m, s, first, at);
        if (storeP3Enabled()) yield* provenanceStep(m.id, sources);
      }
    });
  } catch { return; } // the memory is saved; it shows its legacy confidence
  for (const m of list) enqueue(m.userId, m.id);
  await resolveOpenQuestions(list[0].userId, list, sources[0]).catch(() => 0);
}

/** P3's provenance columns (source, trust; only while P3 is on), where nothing set them yet: an owner approval makes it checked. */
function* provenanceStep(id: string, sources: ReadonlyArray<TrustSource>): Step<void> {
  const k = sources[0].kind;
  const approved = sources.some((s) => s.kind === 'approved' || s.kind === 'owner');
  const source = k === 'owner' || k === 'approved' ? 'owner' : k === 'chat' || k === 'agent' ? 'agent' : k === 'tool' ? 'coding_app' : k;
  const trust = approved ? 'checked' : k === 'tool' || k === 'import' ? 'imported' : 'unchecked';
  yield* run('UPDATE memories SET source = ?, trust = ?, valid_from = COALESCE(valid_from, created_at) WHERE id = ? AND source IS NULL', source, trust, id);
  if (approved) yield* run("UPDATE memories SET trust = 'checked' WHERE id = ? AND trust <> 'checked'", id);
}

/** Step 4: the same fact again from (maybe) another source: it corroborates the known memory. */
export async function corroborated(userId: string, memoryId: string, source: TrustSource & { label?: string }): Promise<void> {
  if (!storeP9bEnabled() || !(await trustTablesReady())) return;
  const m = await getMemoryStorage().getOwned(userId, memoryId).catch(() => null);
  if (!m) return;
  const at = nowIso();
  await sql().tx(function* (): Step<void> { yield* corroborateStep(m, source, source.label ?? source.kind, at); }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Background enrichment (LAT: save now, enrich later)
// ---------------------------------------------------------------------------

const waiting = new Map<string, string>(); // memory id -> user id
let running: Promise<void> | null = null;
/** Memories enriched per turn of the queue; the queue yields to replies between turns. */
const BATCH = 10;
const PAUSE_MS = 25;

function enqueue(userId: string, id: string): void {
  waiting.set(id, userId);
  if (!running) running = drain().finally(() => { running = null; });
}

async function drain(): Promise<void> {
  while (waiting.size) {
    await new Promise((r) => setTimeout(r, PAUSE_MS));
    const batch = [...waiting.entries()].slice(0, BATCH);
    for (const [id] of batch) waiting.delete(id);
    for (const [id, userId] of batch) await enrichOne(userId, id).catch(() => markState(id, 'failed'));
  }
}

/** Resolves when every queued enrichment has finished (tests, the quality job). */
export async function enrichmentIdle(): Promise<void> {
  while (running) await running;
}

async function markState(id: string, state: 'ready' | 'failed', flags?: string[]): Promise<void> {
  await sql().read(run(`UPDATE memory_trust SET enrich_state = ?, ${flags ? 'flags = ?, ' : ''}updated_at = ? WHERE memory_id = ?`,
    ...(flags ? [state, JSON.stringify(flags), nowIso(), id] : [state, nowIso(), id]))).catch(() => undefined);
}

/** Enrich one stored memory (see the module comment). Exported for the quality job. */
export async function enrichOne(userId: string, id: string): Promise<void> {
  const storage = getMemoryStorage();
  const m = await storage.getOwned(userId, id);
  if (!m || !m.drawer) { await markState(id, 'failed'); return; }
  await graphIdle();
  const rows = await trustRows(userId, [m]);
  const own = rows.get(id);
  if (!own) return;
  const flags = new Set(own.flags.filter((f) => !f.startsWith('contradicts:') && f !== 'sensitive'));
  const similar = (await storage.search({ userId, query: m.content, drawers: [m.drawer], limit: 6 })).filter((r) => r.memory.id !== id);
  const others = await trustRows(userId, similar.map((r) => r.memory));
  const at = nowIso();
  for (const r of similar) {
    const o = r.memory;
    if (nearDuplicate(o.content, m.content)) {
      // The same fact twice (two paths): each corroborates the other with its sources — except the
      // owner's own word or approval, which belong to that text only (a tool's look-alike never
      // becomes "owner-verified" by resembling it).
      const carry = (list: TrustSource[]) => list.filter((x) => x.kind !== 'owner' && x.kind !== 'approved');
      const theirs = carry(await sourcesOf(o.id));
      const mine = carry(await sourcesOf(id));
      await sql().tx(function* (): Step<void> {
        for (const s of theirs) yield* corroborateStep(m, s, own.source, at);
        for (const s of mine) yield* corroborateStep(o, s, others.get(o.id)?.source ?? s.kind, at);
      }).catch(() => undefined);
    } else if (others.get(o.id)?.verified && detectContradiction(o.content, m.content)) {
      flags.add(`contradicts:${o.id}`);
    }
  }
  if (specialCategory(m.content) || personalDataKinds(m.content).length) flags.add('sensitive');
  await markState(id, 'ready', [...flags].slice(0, 10));
}

async function sourcesOf(memoryId: string): Promise<TrustSource[]> {
  const rows = await sql().read(all<{ source_key: string; kind: TrustKind }>(
    'SELECT source_key, kind FROM memory_trust_sources WHERE memory_id = ? ORDER BY at, source_key', memoryId));
  return rows.map((r) => ({ key: r.source_key, kind: r.kind }));
}

/** Memories still "pending" (a restart emptied the in-process queue): queued again, at most `limit`. */
export async function requeuePending(userId: string, limit = 200): Promise<number> {
  if (!(await trustTablesReady())) return 0;
  const rows = await sql().read(all<{ memory_id: string }>(
    `SELECT memory_id FROM memory_trust WHERE user_id = ? AND enrich_state = 'pending' ORDER BY created_at LIMIT ?`, userId, limit));
  for (const r of rows) enqueue(userId, r.memory_id);
  return rows.length;
}

// ---------------------------------------------------------------------------
// MD8: an answer resolves the open question
// ---------------------------------------------------------------------------

/** Open questions older than this expire (asked once, never forever). */
export const OPEN_QUESTION_DAYS = 14;
/** Expired and resolved questions (their redacted text) are deleted after this many days. */
export const QUESTION_KEEP_DAYS = 30;
/** A stored fact resolves a question when it shares at least this share of the question's content words (and two words). */
const RESOLVE_SHARE = 0.5;

/** Content words a question and an answer can share. */
const terms = (s: string) => new Set(lexicalTokens(s));

/** Does this stored text answer that question? (pure) */
export function answers(question: string, fact: string): boolean {
  const q = terms(question);
  if (!q.size) return false;
  const f = terms(fact);
  let shared = 0;
  for (const t of q) if (f.has(t)) shared++;
  return shared >= Math.min(2, q.size) && shared / q.size >= RESOLVE_SHARE;
}

async function resolveOpenQuestions(userId: string, memories: readonly Memory[], source: TrustSource): Promise<number> {
  // Only the owner's words (or an agent writing them down) answer the owner's question; never a tool or a channel.
  if (!['owner', 'approved', 'chat', 'agent'].includes(source.kind)) return 0;
  const since = new Date(Date.now() - OPEN_QUESTION_DAYS * 86_400_000).toISOString();
  const open = await sql().read(all<{ id: string; question: string }>(
    `SELECT id, question FROM memory_open_questions WHERE user_id = ? AND status = 'open' AND asked_at >= ? ORDER BY asked_at DESC LIMIT 20`, userId, since));
  let n = 0;
  for (const q of open) {
    const m = memories.find((x) => answers(q.question, x.content));
    if (!m) continue;
    await sql().read(run(`UPDATE memory_open_questions SET status = 'resolved', resolved_memory_id = ?, resolved_at = ? WHERE id = ? AND status = 'open'`, m.id, nowIso(), q.id));
    n++;
  }
  return n;
}

/** Record that the agent asks the owner this question (once). Returns the open question, new or already asked. */
export async function askOnce(userId: string, agentId: string | null, question: string, questionHash: string): Promise<{ id: string; alreadyAsked: boolean } | null> {
  if (!(await trustTablesReady())) return null;
  const since = new Date(Date.now() - OPEN_QUESTION_DAYS * 86_400_000).toISOString();
  return sql().tx(function* (): Step<{ id: string; alreadyAsked: boolean }> {
    yield* run(`UPDATE memory_open_questions SET status = 'expired' WHERE user_id = ? AND status = 'open' AND asked_at < ?`, userId, since);
    yield* run(`DELETE FROM memory_open_questions WHERE user_id = ? AND status <> 'open' AND asked_at < ?`,
      userId, new Date(Date.now() - QUESTION_KEEP_DAYS * 86_400_000).toISOString());
    const known = yield* one<{ id: string }>(
      `SELECT id FROM memory_open_questions WHERE user_id = ? AND question_hash = ? AND status = 'open' ORDER BY asked_at DESC LIMIT 1`, userId, questionHash);
    if (known) return { id: known.id, alreadyAsked: true };
    const id = `oq-${uuidv4()}`;
    yield* run(`INSERT INTO memory_open_questions (id, user_id, agent_id, question_hash, question, status, asked_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      id, userId, agentId, questionHash, question, nowIso());
    return { id, alreadyAsked: false };
  });
}

/** Expire open questions and delete old expired or resolved ones (the weekly usage job; askOnce does the same). */
export async function cleanQuestions(userId: string): Promise<void> {
  if (!(await trustTablesReady())) return;
  const since = new Date(Date.now() - OPEN_QUESTION_DAYS * 86_400_000).toISOString();
  const keep = new Date(Date.now() - QUESTION_KEEP_DAYS * 86_400_000).toISOString();
  await sql().tx(function* (): Step<void> {
    yield* run(`UPDATE memory_open_questions SET status = 'expired' WHERE user_id = ? AND status = 'open' AND asked_at < ?`, userId, since);
    yield* run(`DELETE FROM memory_open_questions WHERE user_id = ? AND status <> 'open' AND asked_at < ?`, userId, keep);
  });
}

