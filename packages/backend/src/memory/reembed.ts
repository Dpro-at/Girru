/**
 * Re-embedding job (CORE-06). When the preferred embedding model changes
 * (or a memory was saved while the model was down and got the hash
 * fallback), stored vectors of another model are never compared with new
 * ones. Search re-embeds a few of them lazily; this explicit owner job
 * re-embeds all of one user's memories at once.
 */

import { backgroundSlot } from '../llm/local-scheduler.js';
import { all, sql } from '../repositories/sql-steps.js';
import { LEGACY_HASH_MODEL, getEmbeddingService } from './embedding.js';
import { getMemoryStorage } from './storage.js';

const BATCH = 32;
export const MAX_REEMBED_PER_RUN = 5000;

export interface EmbeddingStatus {
  targetModel: string;
  models: Array<{ model: string; count: number }>;
  stale: number;
}

/** Vectors of this user per model (counts only). */
export async function embeddingStatus(userId: string): Promise<EmbeddingStatus> {
  const target = getEmbeddingService().targetModel();
  const rows = await sql().read(all<{ model: string; count: number }>(
    `SELECT CASE WHEN embedding IS NULL THEN 'none' ELSE COALESCE(embedding_model, ?) END AS model, COUNT(*) AS count
       FROM memories WHERE user_id = ? GROUP BY 1 ORDER BY 1`,
    LEGACY_HASH_MODEL, userId));
  return { targetModel: target, models: rows, stale: rows.filter((r) => r.model !== target).reduce((s, r) => s + r.count, 0) };
}

export interface ReembedResult {
  targetModel: string;
  reembedded: number;
  remaining: number;
  /** Set when the preferred model did not answer (nothing more was changed). */
  error?: string;
}

/** Re-embed this user's memories whose vector is not of the preferred model. */
export async function reembedUserMemories(userId: string, options: { limit?: number } = {}): Promise<ReembedResult> {
  const service = getEmbeddingService();
  const target = service.targetModel();
  const storage = getMemoryStorage();
  const limit = Math.min(Math.max(Math.floor(Number(options.limit) || MAX_REEMBED_PER_RUN), 1), MAX_REEMBED_PER_RUN);
  const stale = await sql().read(all<{ id: string; content: string }>(
    `SELECT id, content FROM memories WHERE user_id = ? AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model != ?)
      ORDER BY created_at ASC, id ASC LIMIT ?`,
    userId, target, limit));
  let reembedded = 0;
  let error: string | undefined;
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH);
    // STORE-MAP-01 P2b (LAT): a batch never runs while a local reply runs (P2b off: no wait).
    const release = await backgroundSlot();
    let vectors: Awaited<ReturnType<typeof service.embedManyDetailed>>;
    try { vectors = await service.embedManyDetailed(batch.map((r) => r.content)); } finally { release(); }
    if (vectors.some((v) => v.model !== target)) { error = `embedding model ${target} is not available`; break; }
    for (const [j, r] of batch.entries()) {
      if (await storage.setEmbedding(userId, r.id, r.content, vectors[j].vector, vectors[j].model)) reembedded++;
    }
  }
  return { targetModel: target, reembedded, remaining: (await embeddingStatus(userId)).stale, ...(error ? { error } : {}) };
}
