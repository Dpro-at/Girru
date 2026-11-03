/**
 * STORE-MAP-01 P3 (step 5): memory vectors packed as little-endian Float32.
 *
 * `memories.embedding_vec` keeps the same numbers as the JSON text in
 * `memories.embedding`. Recall reads the packed vector when it is there; the
 * background job below fills older rows in small batches and can stop and
 * start again at any time (it only picks rows that have no packed vector yet).
 */

import { all, one, run, sql, type Step } from '../repositories/sql-steps.js';

/** Numbers -> packed Float32 (little-endian). */
export function packVector(v: readonly number[]): Buffer {
  return Buffer.from(Float32Array.from(v).buffer);
}

/** Packed Float32 -> numbers; null when the bytes are not a whole vector. */
export function unpackVector(b: unknown): number[] | null {
  const buf = Buffer.isBuffer(b) ? b : b instanceof Uint8Array ? Buffer.from(b) : null;
  if (!buf || buf.length === 0 || buf.length % 4 !== 0) return null;
  // A 4-byte aligned copy read as one Float32Array (this format is little-endian on every supported machine).
  const aligned = new Uint8Array(buf.length);
  aligned.set(buf);
  return Array.from(new Float32Array(aligned.buffer));
}

/** Inside a save: the packed copy of a vector just written (P3). */
export function* writeVectorStep(memoryId: string, embedding: readonly number[] | undefined): Step<void> {
  if (!embedding?.length) return;
  yield* run('UPDATE memories SET embedding_vec = ? WHERE id = ?', packVector(embedding), memoryId);
}

/** One batch of the background job; returns how many rows it packed. */
export function* backfillVectorsStep(limit = 200): Step<number> {
  const rows = yield* all<{ id: string; embedding: string }>('SELECT id, embedding FROM memories WHERE embedding IS NOT NULL AND embedding_vec IS NULL ORDER BY id LIMIT ?', limit);
  let packed = 0;
  for (const r of rows) {
    let v: unknown;
    try { v = JSON.parse(r.embedding); } catch { v = null; }
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
      // Not a vector: mark it with an empty packed value so the job never picks it again.
      yield* run('UPDATE memories SET embedding_vec = ? WHERE id = ?', Buffer.alloc(0), r.id);
      continue;
    }
    yield* run('UPDATE memories SET embedding_vec = ? WHERE id = ? AND embedding_vec IS NULL', packVector(v as number[]), r.id);
    packed++;
  }
  return rows.length ? Math.max(packed, 1) : 0;
}

/** Runs the job to the end in small transactions; safe to stop and run again. */
export async function backfillVectors(batch = 200): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await sql().tx(() => backfillVectorsStep(batch), { immediate: true });
    total += n;
    if (n === 0) return total;
    await new Promise((r) => setImmediate(r)); // other work goes first between batches
  }
}

/** How far the job is: rows with a vector, and how many already packed. */
export async function vectorJobStatus(): Promise<{ done: number; total: number }> {
  return sql().read((function* () {
    const r = yield* one<{ total: number; done: number }>('SELECT COUNT(*) AS total, SUM(CASE WHEN embedding_vec IS NOT NULL THEN 1 ELSE 0 END) AS done FROM memories WHERE embedding IS NOT NULL');
    return { done: Number(r?.done ?? 0), total: Number(r?.total ?? 0) };
  })());
}
