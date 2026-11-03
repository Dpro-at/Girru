/**
 * Confidence from corroboration (STORE-MAP-01 P9b, MD3; GIRRU_STORE_P9B).
 *
 * Every memory written while P9b is on has a trust record (migration 181):
 * the sources that stated the same text and the confidence that follows.
 *
 *   start       the first source sets the start value (START_CONFIDENCE): the
 *               owner's own words are high, an approved proposal close to it,
 *               a chat extraction or an agent's save medium, a single fact
 *               written by a tool (MCP or coding tool, a repository file, a
 *               run's notes) low, and a channel (an outsider) lowest.
 *   corroborate every further DISTINCT source raises it:
 *                 c' = 1 − (1 − c) · (1 − CORROBORATION_GAIN · weight(kind))
 *               (the same source twice counts once). Owner approval lifts it
 *               to at least OWNER_APPROVED. Never above MAX_UNOWNED without
 *               the owner.
 *   verified    owner-stated or owner-approved, or stated by at least two
 *               distinct TRUSTED sources (chat or agent). Tools, imports
 *               that were not approved and channels never verify a fact on
 *               their own, however often they repeat it (CX11: a poisoned
 *               fact must not gain trust by repetition).
 *
 * The record is bound to the text by content_hash: after an edit it no longer
 * counts until the new text is captured again (legacyConfidence meanwhile).
 */

import { createHash } from 'node:crypto';
import { all, one, run, sql, tableExists, type Step } from '../../repositories/sql-steps.js';
import type { Memory } from '../types.js';

export type TrustKind = 'owner' | 'approved' | 'chat' | 'agent' | 'tool' | 'import' | 'channel' | 'system';

export const START_CONFIDENCE: Readonly<Record<TrustKind, number>> = {
  owner: 0.9,
  approved: 0.85,
  chat: 0.5,
  agent: 0.45,
  import: 0.45,
  system: 0.5,
  tool: 0.3,
  channel: 0.2,
};
/** How much a corroborating source of each kind counts (0–1). */
const WEIGHT: Readonly<Record<TrustKind, number>> = {
  owner: 1, approved: 1, chat: 0.8, agent: 0.6, import: 0.5, system: 0.4, tool: 0.35, channel: 0.15,
};
export const CORROBORATION_GAIN = 0.5;
export const OWNER_APPROVED = 0.85;
export const MAX_UNOWNED = 0.9;
/** Kinds that count toward "verified" without the owner. */
const TRUSTED: ReadonlySet<TrustKind> = new Set(['chat', 'agent']);
/** Confidence bands shown in recall output. */
export const HIGH_CONFIDENCE = 0.75;
export const LOW_CONFIDENCE_BAND = 0.4;

export interface TrustSource { key: string; kind: TrustKind }
export interface Trust { confidence: number; verified: boolean; sources: number }

export const contentHash = (text: string): string =>
  createHash('sha256').update(String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex').slice(0, 32);

/** Confidence and verification from the distinct sources of one text (pure; first source first). */
export function trustOf(sources: readonly TrustSource[]): Trust {
  const seen = new Map<string, TrustKind>();
  for (const s of sources) if (!seen.has(s.key)) seen.set(s.key, s.kind);
  const kinds = [...seen.values()];
  if (!kinds.length) return { confidence: START_CONFIDENCE.system, verified: false, sources: 0 };
  let c = START_CONFIDENCE[kinds[0]];
  for (const k of kinds.slice(1)) c = 1 - (1 - c) * (1 - CORROBORATION_GAIN * WEIGHT[k]);
  const owner = kinds.includes('owner');
  const approved = kinds.includes('approved');
  if (approved) c = Math.max(c, OWNER_APPROVED);
  if (!owner && !approved) c = Math.min(c, MAX_UNOWNED);
  c = Math.min(0.99, c);
  const trusted = [...seen.values()].filter((k) => TRUSTED.has(k)).length;
  return { confidence: Math.round(c * 1000) / 1000, verified: owner || approved || trusted >= 2, sources: seen.size };
}

/** A memory written before P9b (no trust record for its text): judged by what it says about itself. */
export function legacyConfidence(m: Pick<Memory, 'metadata' | 'sourceAgentId'>): Trust {
  const source = String((m.metadata as Record<string, unknown> | undefined)?.source ?? '');
  if (source === 'outsider') return { confidence: START_CONFIDENCE.channel, verified: false, sources: 0 };
  if (source === 'extraction') return { confidence: START_CONFIDENCE.chat, verified: false, sources: 0 };
  if (m.sourceAgentId || source === 'agent') return { confidence: START_CONFIDENCE.agent, verified: false, sources: 0 };
  return { confidence: 0.6, verified: false, sources: 0 };
}

export type ConfidenceBand = 'high' | 'medium' | 'low';
export const bandOf = (c: number): ConfidenceBand => (c >= HIGH_CONFIDENCE ? 'high' : c >= LOW_CONFIDENCE_BAND ? 'medium' : 'low');

let ready: boolean | null = null;
/** True when migration 181 ran. */
export async function trustTablesReady(): Promise<boolean> {
  if (ready) return true;
  ready = await sql().read(tableExists('memory_trust')).catch(() => false);
  return ready;
}
export function resetTrustForTests(): void { ready = null; }

export interface TrustRow {
  memoryId: string;
  source: string;
  contentHash: string;
  confidence: number;
  verified: boolean;
  useWeight: number;
  uses: number;
  flags: string[];
  enrichState: 'pending' | 'ready' | 'failed';
}

function parseFlags(s: string | null): string[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; }
}

const rowOf = (r: any): TrustRow => ({
  memoryId: r.memory_id, source: r.source, contentHash: r.content_hash, confidence: Number(r.confidence),
  verified: Number(r.verified) === 1, useWeight: Number(r.use_weight) || 0, uses: Number(r.uses) || 0,
  flags: parseFlags(r.flags), enrichState: r.enrich_state,
});

/**
 * Add one source of the memory's current text and store the confidence that
 * follows (inside the caller's transaction). A source already listed for this
 * text counts once; sources of an older text are dropped.
 */
export function* corroborateStep(m: Pick<Memory, 'id' | 'userId' | 'content'>, source: TrustSource, firstSource: string, at: string): Step<Trust> {
  const hash = contentHash(m.content);
  yield* run('DELETE FROM memory_trust_sources WHERE memory_id = ? AND user_id = ? AND content_hash <> ?', m.id, m.userId, hash);
  const known = yield* one<{ n: number }>('SELECT COUNT(*) AS n FROM memory_trust_sources WHERE memory_id = ? AND source_key = ?', m.id, source.key);
  if (!Number(known?.n)) {
    yield* run('INSERT INTO memory_trust_sources (memory_id, user_id, source_key, kind, content_hash, at) VALUES (?, ?, ?, ?, ?, ?)',
      m.id, m.userId, source.key, source.kind, hash, at);
  }
  const rows = yield* all<{ source_key: string; kind: TrustKind }>(
    'SELECT source_key, kind FROM memory_trust_sources WHERE memory_id = ? AND user_id = ? ORDER BY at, source_key', m.id, m.userId);
  const t = trustOf(rows.map((r) => ({ key: r.source_key, kind: r.kind })));
  const prev = yield* one<{ content_hash: string }>('SELECT content_hash FROM memory_trust WHERE memory_id = ?', m.id);
  if (!prev) {
    yield* run(`INSERT INTO memory_trust (memory_id, user_id, source, content_hash, confidence, verified, enrich_state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, m.id, m.userId, firstSource, hash, t.confidence, t.verified ? 1 : 0, at, at);
  } else if (prev.content_hash !== hash) {
    // New text: judged anew (use weight and flags belong to the old text's record only while it is the same fact).
    yield* run(`UPDATE memory_trust SET source = ?, content_hash = ?, confidence = ?, verified = ?, enrich_state = 'pending', updated_at = ? WHERE memory_id = ?`,
      firstSource, hash, t.confidence, t.verified ? 1 : 0, at, m.id);
  } else {
    yield* run('UPDATE memory_trust SET confidence = ?, verified = ?, updated_at = ? WHERE memory_id = ?', t.confidence, t.verified ? 1 : 0, at, m.id);
  }
  return t;
}

/** Trust records of these memories that still match their text (others are left out). */
export async function trustRows(userId: string, memories: ReadonlyArray<Pick<Memory, 'id' | 'content'>>): Promise<Map<string, TrustRow>> {
  const out = new Map<string, TrustRow>();
  if (!memories.length || !(await trustTablesReady())) return out;
  const ids = [...new Set(memories.map((m) => m.id))].slice(0, 500);
  const rows = await sql().read(all<any>(
    `SELECT * FROM memory_trust WHERE user_id = ? AND memory_id IN (${ids.map(() => '?').join(', ')})`, userId, ...ids));
  const text = new Map(memories.map((m) => [m.id, m.content]));
  for (const r of rows) {
    const t = rowOf(r);
    if (t.contentHash === contentHash(text.get(t.memoryId) ?? '')) out.set(t.memoryId, t);
  }
  return out;
}

/** The confidence a recall shows for one memory: its trust record, else the legacy judgement. */
export function confidenceOf(m: Pick<Memory, 'id' | 'metadata' | 'sourceAgentId'>, rows: ReadonlyMap<string, TrustRow>): Trust {
  const r = rows.get(m.id);
  return r ? { confidence: r.confidence, verified: r.verified, sources: 0 } : legacyConfidence(m);
}

/** Forget: the memory's trust rows and the open question it resolved go with it (inside the forget transaction). */
export function* forgetTrustStep(userId: string, memoryId: string): Step<void> {
  if (!(yield* tableExists('memory_trust'))) return;
  yield* run('DELETE FROM memory_trust WHERE memory_id = ? AND user_id = ?', memoryId, userId);
  yield* run('DELETE FROM memory_trust_sources WHERE memory_id = ? AND user_id = ?', memoryId, userId);
  // The question it answered names the same topic: it goes too.
  yield* run('DELETE FROM memory_open_questions WHERE user_id = ? AND resolved_memory_id = ?', userId, memoryId);
}
