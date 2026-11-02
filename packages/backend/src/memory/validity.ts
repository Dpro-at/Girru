/**
 * STORE-MAP-01 P3 (FD3, D11): where a memory came from, how far to trust it,
 * and whether it is still true.
 *
 *   source / source_ref   owner | agent (agent id) | coding_app (client) | import | channel | system
 *   trust                 checked | unchecked | imported
 *   valid_from / valid_to since when the text is true / when a newer fact replaced it
 *   superseded_by         the memory that replaced it (the old row keeps status 'replaced')
 *
 * While GIRRU_STORE_P3 is on: every new memory gets its source and trust, a
 * new fact on a known topic replaces the old one instead of overwriting it
 * (the old row stays in History, hidden from lists and from agents), and an
 * owner edit is checked against the version the editor saw.
 */

import { all, one, run, sql, type Step } from '../repositories/sql-steps.js';
import type { Memory } from './types.js';

export const TRUST = ['checked', 'unchecked', 'imported'] as const;
export type Trust = (typeof TRUST)[number];
export const SOURCES = ['owner', 'agent', 'coding_app', 'import', 'channel', 'system'] as const;
export type Source = (typeof SOURCES)[number];
export interface Provenance { source: Source; sourceRef: string | null; trust: Trust }

/** SQL condition (on `memories`): not replaced by a newer fact. */
export const NOT_REPLACED_SQL = "COALESCE(memories.status, 'active') <> 'replaced'";

/**
 * Where a memory came from, from what is stored today: the source word in its
 * metadata, the saving agent, the coding app, and who wrote its versions.
 */
export function provenanceOf(input: { metadataSource?: unknown; sourceAgentId?: string | null; client?: unknown; ownerWrote?: boolean }): Provenance {
  const src = typeof input.metadataSource === 'string' ? input.metadataSource : '';
  const agent = input.sourceAgentId ?? null;
  if (src === 'import') return { source: 'import', sourceRef: null, trust: 'imported' };
  if (typeof input.client === 'string' && input.client) return { source: 'coding_app', sourceRef: input.client.slice(0, 64), trust: 'imported' };
  if (src === 'outsider') return { source: 'channel', sourceRef: null, trust: 'unchecked' };
  if (src === 'owner' || src === 'memory_file') return { source: 'owner', sourceRef: null, trust: 'checked' };
  if (agent || src === 'agent' || src === 'learning' || src === 'chat' || src === 'conversation') {
    // An agent wrote it; the owner approving or editing it counts as checking it.
    return { source: 'agent', sourceRef: agent, trust: input.ownerWrote ? 'checked' : 'unchecked' };
  }
  if (src === 'retention') return { source: 'system', sourceRef: null, trust: 'unchecked' };
  return input.ownerWrote ? { source: 'owner', sourceRef: null, trust: 'checked' } : { source: 'system', sourceRef: null, trust: 'unchecked' };
}

const meta = (m: Memory | { metadata?: unknown }): Record<string, unknown> => {
  const v = (m as { metadata?: unknown }).metadata;
  if (v && typeof v === 'object') return v as Record<string, unknown>;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {}; } catch { return {}; } }
  return {};
};

/** Provenance of a memory about to be saved by `actor` (the owner's id when the owner saves it). */
export function provenanceForSave(memory: Memory, actor: string): Provenance {
  const md = meta(memory);
  return provenanceOf({ metadataSource: md.source, sourceAgentId: memory.sourceAgentId ?? null, client: md.client, ownerWrote: actor === memory.userId });
}

/** Writes source, trust and valid_from on a saved row that has none yet (inside the save's transaction). */
export function* stampProvenanceStep(memory: Memory, actor: string): Step<void> {
  const p = provenanceForSave(memory, actor);
  yield* run('UPDATE memories SET source = ?, source_ref = ?, trust = ?, valid_from = COALESCE(valid_from, created_at) WHERE id = ? AND source IS NULL',
    p.source, p.sourceRef, p.trust, memory.id);
}

/**
 * Backfill (resumable: it only picks rows without a source): source, trust and
 * valid_from for up to `limit` existing memories. Returns how many it filled.
 */
export function* backfillProvenanceStep(limit = 500): Step<number> {
  const rows = yield* all<{ id: string; user_id: string; metadata: string | null; source_agent_id: string | null; created_at: string }>(
    'SELECT id, user_id, metadata, source_agent_id, created_at FROM memories WHERE source IS NULL ORDER BY id LIMIT ?', limit);
  for (const r of rows) {
    const md = meta({ metadata: r.metadata });
    const ownerWrote = !!(yield* one('SELECT 1 AS x FROM memory_versions WHERE memory_id = ? AND created_by = ? LIMIT 1', r.id, r.user_id));
    const p = provenanceOf({ metadataSource: md.source, sourceAgentId: r.source_agent_id, client: md.client, ownerWrote });
    yield* run('UPDATE memories SET source = ?, source_ref = ?, trust = ?, valid_from = COALESCE(valid_from, created_at) WHERE id = ? AND source IS NULL', p.source, p.sourceRef, p.trust, r.id);
  }
  return rows.length;
}

/** Runs the backfill to the end in small transactions; safe to stop and run again. */
export async function backfillProvenance(batch = 500): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await sql().tx(() => backfillProvenanceStep(batch), { immediate: true });
    total += n;
    if (n < batch) return total;
  }
}

/**
 * Inside the transaction that saved `newer`: the older memory stops being
 * true. It keeps its text, topic and versions; status 'replaced' hides it
 * from lists, recall and briefs.
 */
export function* replaceStep(userId: string, olderId: string, newerId: string): Step<void> {
  const now = new Date().toISOString();
  yield* run(`UPDATE memories SET status = 'replaced', valid_to = ?, superseded_by = ? WHERE id = ? AND user_id = ? AND ${NOT_REPLACED_SQL}`, now, newerId, olderId, userId);
}

/** "Mark as checked" (and its undo): the owner vouches for an agent's or an import's memory. */
export async function setChecked(userId: string, id: string, checked: boolean): Promise<Trust | null> {
  return sql().tx(function* () {
    const r = yield* one<{ source: string | null; metadata: string | null; source_agent_id: string | null }>('SELECT source, metadata, source_agent_id FROM memories WHERE id = ? AND user_id = ?', id, userId);
    if (!r) return null;
    const md = meta({ metadata: r.metadata });
    const base = provenanceOf({ metadataSource: md.source, sourceAgentId: r.source_agent_id, client: md.client, ownerWrote: false }).trust;
    const trust: Trust = checked ? 'checked' : base === 'checked' ? 'unchecked' : base;
    yield* run('UPDATE memories SET trust = ? WHERE id = ? AND user_id = ?', trust, id, userId);
    return trust;
  }, { immediate: true });
}

/** The version an editor must have seen to save over a memory (its last version, 0 before any). */
export function* currentVersionStep(memoryId: string): Step<number> {
  const r = yield* one<{ v: number | null }>('SELECT MAX(version) AS v FROM memory_versions WHERE memory_id = ?', memoryId);
  return Number(r?.v ?? 0);
}

/** What the memory panel shows about provenance and validity. */
export interface Validity { source: string | null; sourceRef: string | null; trust: string | null; validFrom: string | null; validTo: string | null; supersededBy: string | null; replaces: string[]; version: number }

export async function validityOf(userId: string, id: string): Promise<Validity | null> {
  return sql().read((function* () {
    const r = yield* one<any>('SELECT source, source_ref, trust, valid_from, valid_to, superseded_by FROM memories WHERE id = ? AND user_id = ?', id, userId);
    if (!r) return null;
    const older = yield* all<{ id: string }>('SELECT id FROM memories WHERE superseded_by = ? AND user_id = ? ORDER BY valid_to DESC, id', id, userId);
    return {
      source: r.source ?? null, sourceRef: r.source_ref ?? null, trust: r.trust ?? null, validFrom: r.valid_from ?? null,
      validTo: r.valid_to ?? null, supersededBy: r.superseded_by ?? null, replaces: older.map((o) => o.id), version: yield* currentVersionStep(id),
    };
  })());
}
