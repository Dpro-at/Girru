/**
 * STORE-MAP-01 P9 (D9): our own in-memory recall index (GIRRU_STORE_P9).
 *
 * Recall used to read every row of the open drawers with `SELECT *`, parse
 * its vector and metadata, and count the words of every memory again for
 * every query (P0: ~1 s at 100k memories with hash vectors, ~3.4 s with
 * semantic ones). This index keeps, per memory, what scoring needs: its word
 * counts and its vector (a typed array). A search now reads only light
 * columns (id, text, vector model), takes the index entry when the text and
 * the model are unchanged, reads vectors only for new or changed memories,
 * scores, and loads full rows for the results alone.
 *
 * The numbers are the same as the old path (same BM25 math through
 * bm25FromCounts, the same cosine loop, the same order), so recall does not
 * change; a test compares both paths.
 *
 * Privacy (S7): the index lives in this process only, never on disk. An entry
 * whose row is gone (forgotten, deleted, replaced, archived) is dropped the
 * next time its drawer is searched, `forgetRecallIndex` drops a user's whole
 * index at once (forget calls it), and a user's index is dropped after
 * IDLE_MS without a search. Its size is capped (GIRRU_RECALL_INDEX_MB,
 * default 256 MB); past the cap new memories are scored without being kept.
 */

import { all, sql } from '../repositories/sql-steps.js';
import { lexicalTokens } from './text-normalize.js';
import { termCounts } from './hybrid.js';
import { LEGACY_HASH_MODEL } from './embedding.js';
import { forgetRecallStore, recallStoreStats } from './recall-store.js';

export interface IndexEntry {
  id: string;
  content: string;
  /** Model of the stored vector, as the old path reads it (undefined: not comparable). */
  model: string | undefined;
  vec: Float32Array | Float64Array | null;
  /** Where `vec` came from: the packed column (P3), the JSON text, or none. */
  from: 'packed' | 'json' | 'none';
  /** Squared norm of `vec` (summed in the same order as cosine). */
  sq: number;
  counts: Map<string, number>;
  length: number;
  layer: string;
  drawerKind: string;
  drawerKey: string;
  bytes: number;
}

/** A light row of a recall query: what decides whether an index entry is still right. */
export interface LightRow {
  id: string;
  content: string;
  embedding_model: string | null;
  has_json: number | boolean | null;
  has_vec: number | boolean | null;
  memory_layer: string | null;
  dk: string;
  dkey: string;
}

/** Columns a recall query selects instead of `*` (P9). */
export const LIGHT_COLUMNS = `id, content, embedding_model,
  (CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS has_json,
  (CASE WHEN embedding_vec IS NOT NULL THEN 1 ELSE 0 END) AS has_vec, memory_layer`;

const IDLE_MS = 30 * 60 * 1000;
const READ_CHUNK = 500;

interface UserIndex { entries: Map<string, IndexEntry>; lastUsed: number }
const users = new Map<string, UserIndex>();
let totalBytes = 0;

function capBytes(): number {
  const mb = Number(process.env.GIRRU_RECALL_INDEX_MB);
  return (Number.isFinite(mb) && mb >= 0 ? mb : 256) * 1024 * 1024;
}

/** The old path's model of a row: only a row with JSON text has one (rowToMemory). */
function modelOf(row: LightRow): string | undefined {
  return row.has_json ? (row.embedding_model || LEGACY_HASH_MODEL) : undefined;
}

/** Which vector the old path would read for this row (a packed column wins). */
function sourceOf(row: LightRow): IndexEntry['from'] {
  return row.has_vec ? 'packed' : row.has_json ? 'json' : 'none';
}

function sqNorm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return s;
}

/** Packed Float32 (P3) -> a typed array over an aligned copy; null when not a whole vector. */
function packed(b: unknown): Float32Array | null {
  const buf = Buffer.isBuffer(b) ? b : b instanceof Uint8Array ? Buffer.from(b) : null;
  if (!buf || buf.length === 0 || buf.length % 4 !== 0) return null;
  const aligned = new Uint8Array(buf.length);
  aligned.set(buf);
  return new Float32Array(aligned.buffer);
}

function dropUser(userId: string): void {
  const u = users.get(userId);
  if (!u) return;
  for (const e of u.entries.values()) totalBytes -= e.bytes;
  users.delete(userId);
}

function sweepIdle(now: number): void {
  for (const [id, u] of users) if (now - u.lastUsed > IDLE_MS) dropUser(id);
}

/** Drop a user's whole index (forget, trash, a model change). */
export function forgetRecallIndex(userId?: string): void {
  forgetRecallStore(userId); // MEM-SPEED-01: the store kept in step by id
  if (userId === undefined) {
    users.clear();
    totalBytes = 0;
    return;
  }
  dropUser(userId);
}

/** For the health view and tests: entries kept and their size. */
export function recallIndexStats(): { users: number; entries: number; bytes: number } {
  let entries = 0;
  for (const u of users.values()) entries += u.entries.size;
  const store = recallStoreStats();
  const all = new Set([...users.keys(), ...store.userIds]);
  return { users: all.size, entries: entries + store.entries, bytes: totalBytes + store.bytes };
}

/**
 * Index entries for these light rows, in their order. Rows whose text or
 * model changed (or that are new) are read again (vector) and re-counted.
 * `prune`: the rows are every current row of `drawers`, so an entry of those
 * drawers that is not among them is gone and is dropped.
 */
export async function entriesFor(
  userId: string,
  rows: LightRow[],
  prune: { drawers: Array<{ kind: string; key: string }> } | null,
): Promise<IndexEntry[]> {
  const now = Date.now();
  sweepIdle(now);
  let u = users.get(userId);
  if (!u) { u = { entries: new Map(), lastUsed: now }; users.set(userId, u); }
  u.lastUsed = now;

  const out: Array<IndexEntry | null> = new Array(rows.length);
  const misses: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const e = u.entries.get(r.id);
    if (e && e.content === r.content && e.model === modelOf(r) && e.layer === (r.memory_layer || 'factual')
      && e.drawerKind === r.dk && e.drawerKey === r.dkey && e.from === sourceOf(r)) {
      out[i] = e;
    } else {
      out[i] = null;
      misses.push(i);
    }
  }

  for (let start = 0; start < misses.length; start += READ_CHUNK) {
    const chunk = misses.slice(start, start + READ_CHUNK);
    const ids = chunk.map((i) => rows[i].id);
    // By primary key; the owner is checked here (with `user_id = ?` the planner may scan by user).
    const vecRows = await sql().read(all<{ id: string; user_id: string; embedding_vec: unknown; embedding: string | null }>(
      `SELECT id, user_id, embedding_vec, CASE WHEN embedding_vec IS NULL THEN embedding END AS embedding
         FROM memories WHERE id IN (${ids.map(() => '?').join(', ')})`,
      ...ids,
    ));
    const byId = new Map(vecRows.filter((v) => v.user_id === userId).map((v) => [v.id, v]));
    for (const i of chunk) {
      const r = rows[i];
      const v = byId.get(r.id);
      // Same choice as rowToMemory: the packed vector when there is one, else the JSON text.
      let vec: Float32Array | Float64Array | null = v ? packed(v.embedding_vec) : null;
      let from: IndexEntry['from'] = vec ? 'packed' : 'none';
      if (!vec && v?.embedding) { vec = Float64Array.from(JSON.parse(v.embedding) as number[]); from = 'json'; }
      const tokens = lexicalTokens(r.content);
      const counts = termCounts(tokens);
      const entry: IndexEntry = {
        id: r.id, content: r.content, model: modelOf(r), vec, from, sq: vec ? sqNorm(vec) : 0,
        counts, length: tokens.length, layer: r.memory_layer || 'factual', drawerKind: r.dk, drawerKey: r.dkey,
        bytes: r.content.length * 2 + (vec ? vec.byteLength : 0) + counts.size * 48 + 160,
      };
      out[i] = entry;
      const old = u.entries.get(r.id);
      if (old) { totalBytes -= old.bytes; u.entries.delete(r.id); }
      if (totalBytes + entry.bytes <= capBytes()) {
        u.entries.set(r.id, entry);
        totalBytes += entry.bytes;
      }
    }
  }

  if (prune) {
    const seen = new Set(rows.map((r) => r.id));
    const open = new Set(prune.drawers.map((d) => `${d.kind}\u0000${d.key}`));
    for (const [id, e] of u.entries) {
      if (!seen.has(id) && open.has(`${e.drawerKind}\u0000${e.drawerKey}`)) {
        totalBytes -= e.bytes;
        u.entries.delete(id);
      }
    }
  }
  return out as IndexEntry[];
}

/** The same cosine as embedding.ts `cosine`, over an index entry (its norm summed once). */
export function entryCosine(q: readonly number[], e: IndexEntry): number {
  const b = e.vec;
  if (!b || q.length !== b.length || q.length === 0) return 0;
  let dot = 0, na = 0;
  for (let i = 0; i < q.length; i++) { dot += q[i] * b[i]; na += q[i] * q[i]; }
  const m = Math.sqrt(na) * Math.sqrt(e.sq);
  return m === 0 ? 0 : dot / m;
}
