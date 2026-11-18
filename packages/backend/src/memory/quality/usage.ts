/**
 * Learn from use (STORE-MAP-01 P9b, MD7; GIRRU_STORE_P9B). No model, no
 * training: the replies' own record of what they used (memory_recall_uses,
 * trace.ts) moves a small weight on each memory's trust record, which the
 * re-rank adds (recall.ts).
 *
 *   used      a VERIFIED memory (trust.ts: owner-stated, owner-approved or
 *             confirmed by two trusted sources) used in replies of the last
 *             USE_WINDOW_DAYS gains up to MAX_USE_WEIGHT (log of the count).
 *             An unverified or untrusted one never gains, however often it
 *             is used (CX11: use is not evidence that a fact is true).
 *   unused    a memory older than UNUSED_AFTER_DAYS that no reply used in the
 *             window loses DECAY_PER_RUN per run, down to MIN_USE_WEIGHT
 *             (weekly job: about ten weeks to the floor). Nothing is deleted.
 *   corrected a memory the owner corrected after a reply had used it (an owner
 *             edit, or a newer fact replaced it) is flagged
 *             'corrected-after-use', for the owner to look at.
 */

import { all, columnExists, one, run, sql, type Step } from '../../repositories/sql-steps.js';
import { indexTraceUses } from '../context/trace.js';
import { contentHash, legacyConfidence, trustTablesReady } from './trust.js';

export const USE_WINDOW_DAYS = 90;
export const MAX_USE_WEIGHT = 0.2;
export const MIN_USE_WEIGHT = -0.2;
export const DECAY_PER_RUN = 0.02;
export const UNUSED_AFTER_DAYS = 60;
export const CORRECTED_FLAG = 'corrected-after-use';
const BATCH = 1000;

/** The next use weight of one memory (pure). */
export function nextUseWeight(prev: number, s: { verified: boolean; uses: number; ageDays: number }): number {
  const w = Number.isFinite(prev) ? prev : 0;
  if (s.uses > 0) return s.verified ? Math.min(MAX_USE_WEIGHT, Math.round(0.05 * Math.log2(1 + s.uses) * 1000) / 1000) : Math.min(0, w);
  if (s.ageDays >= UNUSED_AFTER_DAYS) return Math.max(MIN_USE_WEIGHT, Math.round((w - DECAY_PER_RUN) * 1000) / 1000);
  return w;
}

const parseFlags = (s: string | null): string[] => { try { const v = JSON.parse(s ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

/** One run for one account: weights from use, decay, corrected-after-use flags. */
export async function learnFromUse(userId: string, now: Date = new Date()): Promise<{ weighed: number; flagged: number }> {
  if (!(await trustTablesReady())) return { weighed: 0, flagged: 0 };
  await indexTraceUses(userId).catch(() => 0);
  const since = new Date(now.getTime() - USE_WINDOW_DAYS * 86_400_000).toISOString();
  const uses = new Map((await sql().read(all<{ memory_id: string; n: number; last: string }>(
    'SELECT memory_id, COUNT(*) AS n, MAX(created_at) AS last FROM memory_recall_uses WHERE user_id = ? AND created_at >= ? GROUP BY memory_id', userId, since)))
    .map((r) => [r.memory_id, { n: Number(r.n), last: r.last }]));

  let weighed = 0;
  let after = '';
  for (;;) {
    const rows = await sql().read(all<{ memory_id: string; verified: number; use_weight: number; created_at: string }>(
      'SELECT memory_id, verified, use_weight, created_at FROM memory_trust WHERE user_id = ? AND memory_id > ? ORDER BY memory_id LIMIT ?', userId, after, BATCH));
    if (!rows.length) break;
    await sql().tx(function* (): Step<void> {
      for (const r of rows) {
        const u = uses.get(r.memory_id);
        const ageDays = (now.getTime() - new Date(r.created_at).getTime()) / 86_400_000;
        const w = nextUseWeight(Number(r.use_weight), { verified: Number(r.verified) === 1, uses: u?.n ?? 0, ageDays });
        if (w === Number(r.use_weight) && !u) continue;
        yield* run('UPDATE memory_trust SET use_weight = ?, uses = ?, last_used_at = COALESCE(?, last_used_at), updated_at = ? WHERE memory_id = ?',
          w, u?.n ?? 0, u?.last ?? null, now.toISOString(), r.memory_id);
        weighed++;
      }
    });
    after = rows[rows.length - 1].memory_id;
    if (rows.length < BATCH) break;
  }

  const flagged = await flagCorrected(userId, now);
  return { weighed, flagged };
}

/** Memories the owner corrected after a reply used them (see the module comment). */
async function flagCorrected(userId: string, now: Date): Promise<number> {
  const edited = await sql().read(all<{ memory_id: string }>(`
    SELECT DISTINCT v.memory_id FROM memory_versions v
     WHERE v.user_id = ? AND v.change = 'update' AND v.created_by = ?
       AND EXISTS (SELECT 1 FROM memory_recall_uses u WHERE u.user_id = v.user_id AND u.memory_id = v.memory_id AND u.created_at < v.created_at)
     ORDER BY v.memory_id LIMIT 5000`, userId, userId));
  const replaced = (await sql().read(columnExists('memories', 'superseded_by')))
    ? await sql().read(all<{ memory_id: string }>(`
      SELECT m.id AS memory_id FROM memories m
       WHERE m.user_id = ? AND m.superseded_by IS NOT NULL AND m.valid_to IS NOT NULL
         AND EXISTS (SELECT 1 FROM memory_recall_uses u WHERE u.user_id = m.user_id AND u.memory_id = m.id AND u.created_at < m.valid_to)
       ORDER BY m.id LIMIT 5000`, userId))
    : [];
  const ids = [...new Set([...edited, ...replaced].map((r) => r.memory_id))];
  let n = 0;
  const at = now.toISOString();
  for (const id of ids) {
    const done = await sql().tx(function* (): Step<boolean> {
      const t = yield* one<{ flags: string | null }>('SELECT flags FROM memory_trust WHERE memory_id = ? AND user_id = ?', id, userId);
      if (t) {
        const flags = parseFlags(t.flags);
        if (flags.includes(CORRECTED_FLAG)) return false;
        yield* run('UPDATE memory_trust SET flags = ?, updated_at = ? WHERE memory_id = ?', JSON.stringify([...flags, CORRECTED_FLAG].slice(-10)), at, id);
        return true;
      }
      // A memory from before P9b: it gets a record (its legacy confidence) to carry the flag.
      const m = yield* one<{ content: string; metadata: string | null; source_agent_id: string | null }>(
        'SELECT content, metadata, source_agent_id FROM memories WHERE id = ? AND user_id = ?', id, userId);
      if (!m) return false;
      let metadata: Record<string, unknown> = {};
      try { metadata = JSON.parse(m.metadata ?? '{}'); } catch { /* keep empty */ }
      const c = legacyConfidence({ metadata, sourceAgentId: m.source_agent_id });
      yield* run(`INSERT INTO memory_trust (memory_id, user_id, source, content_hash, confidence, verified, flags, enrich_state, created_at, updated_at)
        VALUES (?, ?, 'legacy', ?, ?, 0, ?, 'ready', ?, ?)`, id, userId, contentHash(m.content), c.confidence, JSON.stringify([CORRECTED_FLAG]), at, at);
      return true;
    });
    if (done) n++;
  }
  return n;
}

/** Memories flagged corrected-after-use (ids only), newest first. */
export async function correctedAfterUse(userId: string, limit = 100): Promise<string[]> {
  if (!(await trustTablesReady())) return [];
  const rows = await sql().read(all<{ memory_id: string }>(
    `SELECT memory_id FROM memory_trust WHERE user_id = ? AND flags LIKE ? ORDER BY updated_at DESC, memory_id LIMIT ?`, userId, `%${CORRECTED_FLAG}%`, limit));
  return rows.map((r) => r.memory_id);
}
