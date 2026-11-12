/**
 * MEM-SPEED-01: the recall index kept in step by memory id (GIRRU_STORE_P9, SQLite).
 *
 * The P9 recall index (recall-index.ts) still read the light columns of every
 * row of the open drawers on every search, to see what had changed. At 100k
 * memories that read alone was most of the search; at millions it is minutes.
 * This store keeps, per owner and per drawer, what scoring needs, and learns
 * what changed from the database itself:
 *
 *  - Change capture: TEMP triggers on `memories` (this connection only; they
 *    are never part of the schema and never written to the database file)
 *    call a JS function with the owner and id of every inserted, updated or
 *    deleted row. The next search of that owner re-reads those rows by
 *    primary key and nothing else. A write by another connection is seen
 *    through `PRAGMA data_version`: then every owner's store is dropped and
 *    rebuilt on its next search (always correct, slow only after such a write).
 *  - Per drawer: the memories of one drawer, loaded on the first search that
 *    opens it (by the drawer expression index, in pages, yielding between them).
 *  - BM25 through an inverted term index (term -> slots + counts), so only
 *    memories that contain a query word are touched. Same numbers as
 *    bm25FromCounts (same terms order, same arithmetic).
 *  - Cosine with the query norm computed once; a top-k heap instead of a
 *    full sort, with the old tie order (created_at, id).
 *
 * Results are the same memories, scores and order as the full-row path
 * (test/store-p9-index.test.mjs compares them).
 *
 * Privacy (S7): process memory only. forgetRecallIndex drops a user's store
 * (forget calls it); a gone row leaves the store at the next search of its
 * owner; a store is dropped after IDLE_MS without a search. Nothing here is
 * written to disk.
 */

import os from 'node:os';
import { createRequire } from 'node:module';
import { getDatabase } from '../db/index.js';
import { sql, sqliteSteps } from '../repositories/sql-steps.js';
import { lexicalTokens } from './text-normalize.js';
import { BM25_B, BM25_K1, MIN_RECALL_SCORE, WORKING_LAYER_BOOST, hybridScore, termCounts, vectorScore } from './hybrid.js';
import { LEGACY_HASH_MODEL } from './embedding.js';
import { DRAWER_KEY_SQL, DRAWER_KIND_SQL, normalizeDrawer, type DrawerRef } from './drawers.js';

const IDLE_MS = 30 * 60 * 1000;
const PAGE = 5000;

type Vec = Float32Array | Float64Array;

interface Posting { slots: Int32Array; tf: Int32Array; n: number }

interface Drawer {
  kind: string;
  key: string;
  /** Slots of this drawer (dead ones are skipped and compacted later). */
  slots: number[];
  dead: number;
  /** Alive, not replaced: their count and summed token length (BM25 n and avgdl). */
  live: number;
  sumLen: number;
  bytes: number;
  /**
   * 'exact': full vectors in RAM. 'i8' (a drawer past GIRRU_RECALL_EXACT_MAX
   * memories): unit vectors scalar-quantised to int8 (4x smaller); the best
   * candidates are re-scored with their full vectors read by id.
   */
  mode: 'exact' | 'i8' | 'ann';
  q8: Int8Array;
  q8dims: number;
  q8n: number;
  /**
   * 'ann' (a drawer past GIRRU_RECALL_ANN_MIN memories): an in-process HNSW
   * index (usearch, int8, cosine) over its live vectors, keyed by slot. Slots
   * not in it (no vector, another size, replaced) are in `others`.
   */
  ann: AnnIndex | null;
  annDims: number;
  others: Set<number>;
  pendKeys: number[];
  pendVecs: Float32Array[];
}

interface AnnIndex {
  add(keys: BigUint64Array, vectors: Float32Array, threads?: number): void;
  search(vector: Float32Array, k: number, threads: number): { keys: BigUint64Array; distances: Float32Array };
  remove(keys: bigint): number | number[];
  size(): number;
}

let annLib: { Index: new (cfg: object) => AnnIndex } | null | undefined;
/** usearch (Apache-2.0, prebuilt for Windows, macOS and Linux); null when it does not load here. */
function annIndexClass(): { Index: new (cfg: object) => AnnIndex } | null {
  if (annLib !== undefined) return annLib;
  try { annLib = createRequire(import.meta.url)('usearch'); } catch { annLib = null; }
  return annLib ?? null;
}

interface UserStore {
  drawers: Map<string, Drawer>;
  lastUsed: number;
  /** Ids written since the last search (from the triggers). */
  changed: Set<string>;
  /** id -> slot */
  slotOf: Map<string, number>;
  // Per slot (structure of arrays).
  ids: string[];
  drawerOf: Drawer[];
  type: string[];
  layerRaw: Array<string | null>;
  layer: string[];
  importance: number[];
  replaced: Uint8Array;
  alive: Uint8Array;
  created: string[];
  model: Array<string | undefined>;
  vec: Array<Vec | null>;
  sq: number[];
  len: number[];
  slotBytes: number[];
  /** Row of the slot in its drawer's int8 block, or -1. */
  q8row: number[];
  terms: Map<string, Posting>;
  /** Per-search scratch, reused: BM25 sums by slot and which slots were touched. */
  acc: Float64Array;
  mark: Uint8Array;
  bytes: number;
}

const users = new Map<string, UserStore>();
let storeBytes = 0;
let seenDataVersion: number | null = null;
let captureDb: unknown = null;

/** A drawer with more memories than this keeps int8 vectors (MEM-SPEED-01 step 2). */
export function exactMax(): number {
  const n = Number(process.env.GIRRU_RECALL_EXACT_MAX);
  return process.env.GIRRU_RECALL_EXACT_MAX !== undefined && Number.isFinite(n) && n >= 0 ? n : 50_000;
}

/** A drawer with more memories than this gets an HNSW index (MEM-SPEED-01 step 3). */
export function annMin(): number {
  const n = Number(process.env.GIRRU_RECALL_ANN_MIN);
  return process.env.GIRRU_RECALL_ANN_MIN !== undefined && Number.isFinite(n) && n >= 0 ? n : 100_000;
}

/** How many int8 candidates are re-scored with their full vector. */
function rescoreCount(limit: number): number {
  const n = Number(process.env.GIRRU_RECALL_RESCORE);
  return Math.max(limit, process.env.GIRRU_RECALL_RESCORE !== undefined && Number.isFinite(n) && n > 0 ? n : 200);
}

export function storeCapBytes(): number {
  const mb = Number(process.env.GIRRU_RECALL_INDEX_MB);
  if (process.env.GIRRU_RECALL_INDEX_MB !== undefined && Number.isFinite(mb) && mb >= 0) return mb * 1024 * 1024;
  // Auto: a quarter of this computer's memory.
  return Math.floor(os.totalmem() / 4);
}

const drawerId = (kind: string, key: string) => `${kind}\u0000${key}`;

function dropUser(userId: string): void {
  const u = users.get(userId);
  if (!u) return;
  storeBytes -= u.bytes;
  users.delete(userId);
}

/** Drop a user's store, or every store (forget, trash, a model change). */
export function forgetRecallStore(userId?: string): void {
  if (userId === undefined) {
    users.clear();
    storeBytes = 0;
    return;
  }
  dropUser(userId);
}

export function recallStoreStats(): { users: number; userIds: string[]; entries: number; bytes: number; drawers: Record<'exact' | 'i8' | 'ann', number> } {
  let entries = 0;
  const drawers = { exact: 0, i8: 0, ann: 0 };
  for (const u of users.values()) for (const d of u.drawers.values()) { entries += d.slots.length - d.dead; drawers[d.mode]++; }
  return { users: users.size, userIds: [...users.keys()], entries, bytes: storeBytes, drawers };
}

function onChange(userId: unknown, id: unknown): null {
  const u = users.get(String(userId));
  if (u) u.changed.add(String(id));
  return null;
}

const TRIGGERS = ['girru_recall_ins', 'girru_recall_upd', 'girru_recall_del'];

/**
 * True when the store can serve this search: the main SQLite connection, with
 * change capture in place. Re-creates the triggers (and drops every store)
 * when they are gone, e.g. after the table was rebuilt.
 */
function ready(): boolean {
  if (sql() !== sqliteSteps) return false; // PostgreSQL or a selected (encrypted) store: the P9 path
  let db: any;
  try { db = getDatabase().getDb(); } catch { return false; }
  try {
    if (captureDb !== db) {
      db.function('girru_recall_changed', { deterministic: false }, onChange);
      captureDb = db;
      forgetRecallStore();
      seenDataVersion = null;
    }
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM temp.sqlite_master WHERE type = 'trigger' AND name IN (${TRIGGERS.map(() => '?').join(', ')})`).get(...TRIGGERS) as { n: number }).n;
    if (n !== TRIGGERS.length) {
      db.exec(`
        DROP TRIGGER IF EXISTS temp.girru_recall_ins;
        DROP TRIGGER IF EXISTS temp.girru_recall_upd;
        DROP TRIGGER IF EXISTS temp.girru_recall_del;
        CREATE TEMP TRIGGER girru_recall_ins AFTER INSERT ON main.memories BEGIN SELECT girru_recall_changed(NEW.user_id, NEW.id); END;
        CREATE TEMP TRIGGER girru_recall_upd AFTER UPDATE ON main.memories BEGIN SELECT girru_recall_changed(OLD.user_id, OLD.id); SELECT girru_recall_changed(NEW.user_id, NEW.id); END;
        CREATE TEMP TRIGGER girru_recall_del AFTER DELETE ON main.memories BEGIN SELECT girru_recall_changed(OLD.user_id, OLD.id); END;`);
      forgetRecallStore(); // changes before the triggers were (back) in place were not seen
    }
    // A write by another connection is not captured: start again from the database.
    const v = Number(db.pragma('data_version', { simple: true }));
    if (seenDataVersion !== null && v !== seenDataVersion) forgetRecallStore();
    seenDataVersion = v;
    return true;
  } catch {
    return false;
  }
}

function newUser(now: number): UserStore {
  return {
    drawers: new Map(), lastUsed: now, changed: new Set(), slotOf: new Map(),
    ids: [], drawerOf: [], type: [], layerRaw: [], layer: [], importance: [], replaced: new Uint8Array(1024), alive: new Uint8Array(1024),
    created: [], model: [], vec: [], sq: [], len: [], slotBytes: [], q8row: [], terms: new Map(), acc: new Float64Array(1024), mark: new Uint8Array(1024), bytes: 0,
  };
}

function grow(u: UserStore, need: number): void {
  if (need <= u.alive.length) return;
  let cap = u.alive.length;
  while (cap < need) cap *= 2;
  const g8 = (a: Uint8Array) => { const b = new Uint8Array(cap); b.set(a); return b; };
  u.alive = g8(u.alive); u.replaced = g8(u.replaced); u.mark = new Uint8Array(cap); u.acc = new Float64Array(cap);
}

/** The columns a slot is built from (the vector as the old path reads it: packed first, else JSON). */
const ROW_COLUMNS = `id, user_id, type, content, embedding_model, memory_layer, status, importance_score, created_at,
  ${DRAWER_KIND_SQL} AS dk, ${DRAWER_KEY_SQL} AS dkey, embedding_vec,
  CASE WHEN embedding_vec IS NULL THEN embedding END AS embedding,
  (CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS has_json`;

interface FullRow {
  id: string; user_id: string; type: string; content: string; embedding_model: string | null; memory_layer: string | null;
  status: string | null; importance_score: number | null; created_at: string; dk: string; dkey: string;
  embedding_vec: unknown; embedding: string | null; has_json: number;
}

function packed(b: unknown): Float32Array | null {
  const buf = Buffer.isBuffer(b) ? b : b instanceof Uint8Array ? Buffer.from(b) : null;
  if (!buf || buf.length === 0 || buf.length % 4 !== 0) return null;
  const aligned = new Uint8Array(buf.length);
  aligned.set(buf);
  return new Float32Array(aligned.buffer);
}

function addSlot(u: UserStore, d: Drawer, r: FullRow): void {
  const slot = u.ids.length;
  grow(u, slot + 1);
  let vec: Vec | null = packed(r.embedding_vec);
  if (!vec && r.embedding) vec = Float64Array.from(JSON.parse(r.embedding) as number[]);
  let sq = 0;
  if (vec) for (let i = 0; i < vec.length; i++) sq += vec[i] * vec[i];
  const tokens = lexicalTokens(r.content);
  const counts = termCounts(tokens);
  for (const [t, f] of counts) {
    let p = u.terms.get(t);
    if (!p) { p = { slots: new Int32Array(4), tf: new Int32Array(4), n: 0 }; u.terms.set(t, p); }
    if (p.n === p.slots.length) {
      const s = new Int32Array(p.n * 2); s.set(p.slots); p.slots = s;
      const f2 = new Int32Array(p.n * 2); f2.set(p.tf); p.tf = f2;
    }
    p.slots[p.n] = slot; p.tf[p.n] = f; p.n++;
  }
  const replaced = (r.status ?? 'active') === 'replaced';
  u.ids.push(r.id); u.drawerOf.push(d); u.type.push(r.type); u.layerRaw.push(r.memory_layer); u.layer.push(r.memory_layer || 'factual');
  u.importance.push(r.importance_score === null ? NaN : Number(r.importance_score));
  u.replaced[slot] = replaced ? 1 : 0; u.alive[slot] = 1;
  u.created.push(r.created_at);
  u.model.push(r.has_json ? (r.embedding_model || LEGACY_HASH_MODEL) : undefined);
  u.vec.push(vec); u.sq.push(sq); u.len.push(tokens.length); u.q8row.push(-1);
  u.slotOf.set(r.id, slot);
  d.slots.push(slot);
  if (!replaced) { d.live++; d.sumLen += tokens.length; }
  const bytes = 200 + r.id.length * 2 + (vec ? vec.byteLength : 0) + counts.size * 8;
  u.slotBytes.push(bytes);
  d.bytes += bytes; u.bytes += bytes; storeBytes += bytes;
  if (d.mode === 'i8') quantizeSlot(u, d, slot);
  else if (d.mode === 'ann') annSlot(u, d, slot);
}

/** An HNSW vector costs about its int8 bytes plus its graph links. */
const annBytes = (dims: number) => dims + 256;

/** Queue a slot's vector for its drawer's HNSW index (added in batches by flushAnn), or keep it in `others`. */
function annSlot(u: UserStore, d: Drawer, slot: number, from?: Float32Array): void {
  const v = from ?? u.vec[slot];
  if (!v || v.length !== d.annDims || u.replaced[slot]) { d.others.add(slot); return; }
  d.pendKeys.push(slot);
  d.pendVecs.push(v instanceof Float32Array ? v : Float32Array.from(v));
  u.q8row[slot] = -2;
  const old = u.vec[slot];
  u.vec[slot] = null;
  const saved = (old ? old.byteLength : 0) - annBytes(d.annDims);
  u.slotBytes[slot] -= saved; d.bytes -= saved; u.bytes -= saved; storeBytes -= saved;
}

function flushAnn(d: Drawer): void {
  if (!d.ann || d.pendKeys.length === 0) return;
  const n = d.pendKeys.length, dims = d.annDims;
  const keys = new BigUint64Array(n);
  const flat = new Float32Array(n * dims);
  for (let i = 0; i < n; i++) { keys[i] = BigInt(d.pendKeys[i]); flat.set(d.pendVecs[i], i * dims); }
  d.pendKeys = []; d.pendVecs = [];
  d.ann.add(keys, flat, 0); // all cores
}

/** Move a drawer (exact or int8) to an HNSW index. False when usearch is not available here. */
function toAnn(u: UserStore, d: Drawer): boolean {
  const lib = annIndexClass();
  if (!lib) return false;
  let dims = d.q8dims;
  if (!dims) for (const s of d.slots) { const v = u.vec[s]; if (u.alive[s] && v && v.length) { dims = v.length; break; } }
  if (!dims) return false;
  d.ann = new lib.Index({ dimensions: dims, metric: 'cos', quantization: 'i8', connectivity: 16, expansion_add: 128, expansion_search: 64 });
  d.annDims = dims;
  const wasI8 = d.mode === 'i8';
  d.mode = 'ann';
  for (const s of d.slots) {
    if (!u.alive[s]) continue;
    const row = u.q8row[s];
    if (wasI8 && row >= 0) {
      const v = new Float32Array(dims);
      for (let i = 0; i < dims; i++) v[i] = d.q8[row * dims + i] / 127;
      u.slotBytes[s] -= dims; d.bytes -= dims; u.bytes -= dims; storeBytes -= dims; // its int8 bytes
      u.q8row[s] = -1;
      annSlot(u, d, s, v); // counts the HNSW bytes in place of the int8 ones
    } else {
      annSlot(u, d, s);
    }
  }
  d.q8 = new Int8Array(0); d.q8n = 0;
  flushAnn(d);
  return true;
}

/** Move a slot's vector into its drawer's int8 block (unit length, x127). */
function quantizeSlot(u: UserStore, d: Drawer, slot: number): void {
  const v = u.vec[slot];
  if (!v || v.length === 0) return;
  if (d.q8dims === 0) d.q8dims = v.length;
  if (v.length !== d.q8dims) return; // another model's size: kept in full
  if ((d.q8n + 1) * d.q8dims > d.q8.length) {
    const b = new Int8Array(Math.max(d.q8dims * 1024, d.q8.length * 2));
    b.set(d.q8); d.q8 = b;
  }
  const norm = Math.sqrt(u.sq[slot]);
  const at = d.q8n * d.q8dims;
  for (let i = 0; i < v.length; i++) {
    const x = norm === 0 ? 0 : Math.round((v[i] / norm) * 127);
    d.q8[at + i] = x > 127 ? 127 : x < -127 ? -127 : x;
  }
  u.q8row[slot] = d.q8n++;
  u.vec[slot] = null;
  const saved = v.byteLength - v.length;
  u.slotBytes[slot] -= saved; d.bytes -= saved; u.bytes -= saved; storeBytes -= saved;
}

/** A drawer that grew past exactMax() switches to int8 vectors, past annMin() to an HNSW index. */
function maybeQuantize(u: UserStore, d: Drawer): void {
  if (d.mode === 'ann') { flushAnn(d); return; }
  if (d.live > annMin() && toAnn(u, d)) return;
  if (d.mode !== 'exact' || d.live <= exactMax()) return;
  d.mode = 'i8';
  for (const s of d.slots) if (u.alive[s]) quantizeSlot(u, d, s);
}

function killSlot(u: UserStore, slot: number): void {
  if (!u.alive[slot]) return;
  u.alive[slot] = 0;
  const d = u.drawerOf[slot];
  d.dead++;
  if (!u.replaced[slot]) { d.live--; d.sumLen -= u.len[slot]; }
  u.slotOf.delete(u.ids[slot]);
  if (u.q8row[slot] === -2 && d.ann) { flushAnn(d); d.ann.remove(BigInt(slot)); }
  d.others.delete(slot);
  u.vec[slot] = null; // free the vector now; the rest goes at compaction
  const b = u.slotBytes[slot];
  d.bytes -= b; u.bytes -= b; storeBytes -= b;
}

/** Drop dead slots from posting lists and drawer lists once many have died. */
function compact(u: UserStore): void {
  // Slot arrays never shrink: past twice the live slots the store starts again (next search rebuilds it),
  // so churn can not hold memory the size cap does not count.
  if (u.ids.length > 4096 && u.ids.length > 2 * u.slotOf.size) {
    for (const [id, x] of users) if (x === u) dropUser(id);
    return;
  }
  let dead = 0;
  for (const d of u.drawers.values()) dead += d.dead;
  if (dead < 1024 || dead * 4 < u.slotOf.size) return;
  for (const [t, p] of u.terms) {
    let w = 0;
    for (let i = 0; i < p.n; i++) if (u.alive[p.slots[i]]) { p.slots[w] = p.slots[i]; p.tf[w] = p.tf[i]; w++; }
    p.n = w;
    if (w === 0) u.terms.delete(t);
  }
  for (const d of u.drawers.values()) {
    if (!d.dead) continue;
    d.slots = d.slots.filter((s) => u.alive[s] === 1);
    d.dead = 0;
  }
}

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** Load one drawer of a user, in pages. False when the size cap does not allow it. */
async function loadDrawer(u: UserStore, userId: string, kind: string, key: string): Promise<Drawer | null> {
  const db: any = getDatabase().getDb();
  const d: Drawer = { kind, key, slots: [], dead: 0, live: 0, sumLen: 0, bytes: 0, mode: 'exact', q8: new Int8Array(0), q8dims: 0, q8n: 0,
    ann: null, annDims: 0, others: new Set(), pendKeys: [], pendVecs: [] };
  const first = db.prepare(`SELECT ${ROW_COLUMNS} FROM memories WHERE user_id = ? AND ${DRAWER_KIND_SQL} = ? AND ${DRAWER_KEY_SQL} = ?
    ORDER BY created_at ASC, id ASC LIMIT ${PAGE}`);
  const next = db.prepare(`SELECT ${ROW_COLUMNS} FROM memories WHERE user_id = ? AND ${DRAWER_KIND_SQL} = ? AND ${DRAWER_KEY_SQL} = ?
    AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT ${PAGE}`);
  const cap = storeCapBytes();
  let rows = first.all(userId, kind, key) as FullRow[];
  while (rows.length) {
    for (const r of rows) addSlot(u, d, r);
    maybeQuantize(u, d);
    if (storeBytes > cap) {
      for (const s of d.slots) killSlot(u, s);
      compact(u);
      return null;
    }
    if (rows.length < PAGE) break;
    const last = rows[rows.length - 1];
    await yieldNow();
    rows = next.all(userId, kind, key, last.created_at, last.created_at, last.id) as FullRow[];
  }
  return d;
}

/** Re-read the rows written since the last search (triggers), by primary key. */
function applyChanges(u: UserStore, userId: string): void {
  if (u.changed.size === 0) return;
  const db: any = getDatabase().getDb();
  const ids = [...u.changed];
  u.changed.clear();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const id of chunk) {
      const s = u.slotOf.get(id);
      if (s !== undefined) killSlot(u, s);
    }
    // By primary key; the owner is checked here.
    const rows = db.prepare(`SELECT ${ROW_COLUMNS} FROM memories WHERE id IN (${chunk.map(() => '?').join(', ')})`).all(...chunk) as FullRow[];
    for (const r of rows) {
      if (r.user_id !== userId) continue;
      const d = u.drawers.get(drawerId(r.dk, r.dkey));
      if (d) { addSlot(u, d, r); maybeQuantize(u, d); } // a drawer not loaded yet reads it when it is first searched
    }
  }
  compact(u);
}

export interface StoreQuery {
  userId: string;
  query: string;
  drawers: DrawerRef[];
  type?: string;
  layer?: string;
  minImportance?: number;
  limit: number;
}

export interface StoreHit { id: string; similarity: number; vector: number | null; lexical: number }

export interface OpenStore { drawers: Drawer[]; store: UserStore }

interface QueryVector { vector: number[]; model: string; dims: number; semantic: boolean }

/**
 * Prepare a user's store for these drawers (load, apply changes). Null when
 * this store cannot serve the search (not the main SQLite connection, or past
 * the size cap): the caller uses the P9 path.
 */
export async function openStore(userId: string, drawers: DrawerRef[]): Promise<OpenStore | null> {
  if (!ready()) return null;
  const now = Date.now();
  for (const [id, x] of users) if (now - x.lastUsed > IDLE_MS) dropUser(id);
  let u = users.get(userId);
  if (!u) { u = newUser(now); users.set(userId, u); }
  u.lastUsed = now;
  applyChanges(u, userId);
  if (users.get(userId) !== u) { u = newUser(now); users.set(userId, u); } // dropped by compact: start again

  // The SQL filters at drawer level: an archived project and an agent's own notes are never searched.
  const db: any = getDatabase().getDb();
  const archived = new Set((db.prepare(`SELECT slug FROM memory_project_scopes WHERE owner_id = ? AND archived_at IS NOT NULL`).all(userId) as Array<{ slug: string }>).map((r) => r.slug));
  const out: Drawer[] = [];
  const seen = new Set<string>();
  for (const ref of drawers) {
    const n = normalizeDrawer(ref);
    const kind = n.kind, key = n.key || '';
    const id = drawerId(kind, key);
    if (seen.has(id)) continue;
    seen.add(id);
    if ((kind as string) === 'agent' || (kind === 'project' && archived.has(key))) continue;
    let d = u.drawers.get(id);
    if (!d) {
      const loaded = await loadDrawer(u, userId, kind, key);
      if (!loaded) return null;
      d = loaded;
      u.drawers.set(id, d);
      applyChanges(u, userId); // writes made while it loaded
      if (users.get(userId) !== u) return null; // dropped by compact meanwhile: the P9 path this time
    }
    out.push(d);
  }
  return { drawers: out, store: u };
}

/** Rows whose vector is not of `model`, among the candidates, oldest first (lazy re-embed). */
export function staleIn(userId: string, open: OpenStore, q: StoreQuery, model: string, max: number): Array<{ id: string; content: string }> {
  const u = users.get(userId);
  if (!u || u !== open.store) return [];
  const found: number[] = [];
  for (const d of open.drawers) for (const s of d.slots) if (u.alive[s] && u.model[s] !== model && candidate(u, s, q)) found.push(s);
  found.sort((a, b) => cmpOrder(u, a, b));
  const ids = found.slice(0, max).map((s) => u.ids[s]);
  if (ids.length === 0) return [];
  const db: any = getDatabase().getDb();
  const rows = db.prepare(`SELECT id, user_id, content FROM memories WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as Array<{ id: string; user_id: string; content: string }>;
  const byId = new Map(rows.filter((r) => r.user_id === userId).map((r) => [r.id, r.content]));
  return ids.filter((id) => byId.has(id)).map((id) => ({ id, content: byId.get(id)! }));
}

function candidate(u: UserStore, s: number, q: StoreQuery): boolean {
  if (u.replaced[s]) return false;
  if (q.type !== undefined && u.type[s] !== q.type) return false;
  if (q.layer !== undefined && u.layerRaw[s] !== q.layer) return false;
  if (q.minImportance !== undefined && !(u.importance[s] >= q.minImportance)) return false;
  return true;
}

/** The old order of equal scores: created_at, then id (ascending). */
function cmpOrder(u: UserStore, a: number, b: number): number {
  const ca = u.created[a], cb = u.created[b];
  if (ca !== cb) return ca < cb ? -1 : 1;
  const ia = u.ids[a], ib = u.ids[b];
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** A min-heap of the best `k` (worst on top). */
class TopK {
  private s: number[] = [];
  private sim: number[] = [];
  constructor(private k: number, private u: UserStore) {}
  /** True when a is worse than b. */
  private worse(a: number, b: number): boolean {
    if (this.sim[a] !== this.sim[b]) return this.sim[a] < this.sim[b];
    return cmpOrder(this.u, this.s[a], this.s[b]) > 0;
  }
  push(slot: number, similarity: number): void {
    if (this.k <= 0) return;
    if (this.s.length < this.k) {
      this.s.push(slot); this.sim.push(similarity);
      let i = this.s.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (!this.worse(i, p)) break; this.swap(i, p); i = p; }
      return;
    }
    // Better than the worst kept?
    const better = similarity > this.sim[0] || (similarity === this.sim[0] && cmpOrder(this.u, slot, this.s[0]) < 0);
    if (!better) return;
    this.s[0] = slot; this.sim[0] = similarity;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.s.length && this.worse(l, m)) m = l;
      if (r < this.s.length && this.worse(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
  }
  private swap(a: number, b: number): void {
    [this.s[a], this.s[b]] = [this.s[b], this.s[a]];
    [this.sim[a], this.sim[b]] = [this.sim[b], this.sim[a]];
  }
  /** Best first. */
  sorted(): Array<{ slot: number; similarity: number }> {
    const idx = this.s.map((_, i) => i);
    idx.sort((a, b) => (this.worse(a, b) ? 1 : this.worse(b, a) ? -1 : 0));
    return idx.map((i) => ({ slot: this.s[i], similarity: this.sim[i] }));
  }
}

/** Score the open drawers; the best `limit` hits, best first (same numbers and order as the full-row path). */
export function searchStore(userId: string, open: OpenStore, q: StoreQuery, qv: QueryVector): StoreHit[] {
  const u = users.get(userId);
  if (!u || u !== open.store) return []; // forgotten (or dropped) since openStore
  const filtered = q.type !== undefined || q.layer !== undefined || q.minImportance !== undefined;
  const inOpen = new Set(open.drawers);

  // BM25 statistics over the candidates (bm25FromCounts).
  let n = 0, sumLen = 0;
  if (!filtered) {
    for (const d of open.drawers) { n += d.live; sumLen += d.sumLen; }
  } else {
    for (const d of open.drawers) for (const s of d.slots) if (u.alive[s] && candidate(u, s, q)) { n++; sumLen += u.len[s]; }
  }
  if (n === 0) return [];
  const terms = [...new Set(lexicalTokens(q.query))];
  const avgdl = sumLen / n || 1;
  const touched: number[] = [];
  let total = 1;
  if (terms.length) {
    const postings = terms.map((t) => u.terms.get(t));
    const idf = postings.map((p) => {
      let k = 0;
      if (p) for (let i = 0; i < p.n; i++) { const s = p.slots[i]; if (u.alive[s] && inOpen.has(u.drawerOf[s]) && candidate(u, s, q)) k++; }
      return Math.log(1 + (n - k + 0.5) / (k + 0.5));
    });
    total = idf.reduce((s, x) => s + x, 0) || 1;
    for (let t = 0; t < terms.length; t++) {
      const p = postings[t];
      if (!p) continue;
      const w = idf[t];
      for (let i = 0; i < p.n; i++) {
        const s = p.slots[i];
        if (!u.alive[s] || !inOpen.has(u.drawerOf[s]) || !candidate(u, s, q)) continue;
        const f = p.tf[i];
        const dl = u.len[s];
        if (!u.mark[s]) { u.mark[s] = 1; u.acc[s] = 0; touched.push(s); }
        u.acc[s] += w * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl));
      }
    }
  }
  const lexOf = (s: number) => (u.mark[s] ? Math.min(1, u.acc[s] / total) : 0);

  // Query norm once (the same sum as the per-entry loop of entryCosine).
  const qvec = qv.vector;
  let na = 0;
  for (let i = 0; i < qvec.length; i++) na += qvec[i] * qvec[i];
  const qn = Math.sqrt(na);
  const qf = Float64Array.from(qvec);

  const top = new TopK(q.limit, u);
  const vectors = new Map<number, number | null>();
  // int8 drawers: an approximate score picks candidates, re-scored below with the full vector.
  const approx = new TopK(rescoreCount(q.limit), u);
  const qunit = new Float64Array(qf.length);
  for (let i = 0; i < qf.length; i++) qunit[i] = qn === 0 ? 0 : qf[i] / qn;
  const exactScore = (s: number) => {
    const lexical = lexOf(s);
    const b = u.vec[s];
    const comparable = b !== null && u.model[s] === qv.model && b.length === qv.dims;
    let vector: number | null = null;
    if (comparable && (qv.semantic || lexical > 0)) {
      let cos = 0;
      if (qf.length === b.length && qf.length !== 0) {
        let dot = 0;
        for (let i = 0; i < qf.length; i++) dot += qf[i] * b[i];
        const m = qn * Math.sqrt(u.sq[s]);
        cos = m === 0 ? 0 : dot / m;
      }
      vector = vectorScore(cos, qv.semantic);
    }
    let similarity = hybridScore(vector, lexical, qv.semantic);
    if (similarity >= MIN_RECALL_SCORE && u.layer[s] === 'working') similarity += WORKING_LAYER_BOOST;
    if (similarity >= MIN_RECALL_SCORE) { top.push(s, similarity); vectors.set(s, vector); }
  };
  const lexicalOnly = (s: number) => {
    let similarity = hybridScore(null, lexOf(s), qv.semantic);
    if (similarity >= MIN_RECALL_SCORE && u.layer[s] === 'working') similarity += WORKING_LAYER_BOOST;
    if (similarity >= MIN_RECALL_SCORE) { top.push(s, similarity); vectors.set(s, null); }
  };
  // HNSW drawers: the nearest by vector, plus the best by words (both re-scored below), plus the rest exactly.
  const byWords = new TopK(rescoreCount(q.limit), u);
  const annDrawers = open.drawers.filter((d) => d.mode === 'ann');
  if (annDrawers.length) {
    const annSet = new Set(annDrawers);
    for (const s of touched) {
      const d = u.drawerOf[s];
      if (!annSet.has(d) || u.q8row[s] !== -2) continue; // others: scored with their drawer
      if (d.annDims === qv.dims && u.model[s] === qv.model) byWords.push(s, lexOf(s));
      else lexicalOnly(s);
    }
    const qf32 = Float32Array.from(qvec);
    for (const d of annDrawers) {
      for (const s of d.others) {
        if (!u.alive[s] || (filtered && !candidate(u, s, q)) || (!filtered && u.replaced[s])) continue;
        exactScore(s);
      }
      if (!d.ann || d.annDims !== qv.dims || !qv.semantic) continue; // a hash query: only rows with a word in common count
      flushAnn(d);
      const size = d.ann.size();
      if (size === 0) continue;
      const k = Math.min(size, rescoreCount(q.limit) * (filtered ? 4 : 1));
      const res = d.ann.search(qf32, k, 1);
      for (let i = 0; i < res.keys.length; i++) {
        const s = Number(res.keys[i]);
        if (!u.alive[s] || u.drawerOf[s] !== d || u.model[s] !== qv.model || (filtered && !candidate(u, s, q)) || u.replaced[s]) continue;
        let similarity = hybridScore(vectorScore(1 - res.distances[i], qv.semantic), lexOf(s), qv.semantic);
        if (u.layer[s] === 'working') similarity += WORKING_LAYER_BOOST;
        approx.push(s, similarity);
      }
    }
  }
  for (const d of open.drawers) {
    if (d.mode === 'ann') continue;
    const block = d.q8, dims = d.q8dims;
    const q8ok = d.mode === 'i8' && dims === qv.dims;
    for (const s of d.slots) {
      if (!u.alive[s] || (filtered && !candidate(u, s, q)) || (!filtered && u.replaced[s])) continue;
      const lexical = lexOf(s);
      const row = u.q8row[s];
      if (row >= 0) {
        if (!(q8ok && u.model[s] === qv.model && (qv.semantic || lexical > 0))) {
          // Not comparable with this query (or a hash cosine without a word in common): lexical part only, exact.
          let similarity = hybridScore(null, lexical, qv.semantic);
          if (similarity >= MIN_RECALL_SCORE && u.layer[s] === 'working') similarity += WORKING_LAYER_BOOST;
          if (similarity >= MIN_RECALL_SCORE) { top.push(s, similarity); vectors.set(s, null); }
          continue;
        }
        let dot = 0;
        const at = row * dims;
        for (let i = 0; i < dims; i++) dot += qunit[i] * block[at + i];
        let similarity = hybridScore(vectorScore(dot / 127, qv.semantic), lexical, qv.semantic);
        if (u.layer[s] === 'working') similarity += WORKING_LAYER_BOOST;
        approx.push(s, similarity);
        continue;
      }
      const b = u.vec[s];
      const comparable = b !== null && u.model[s] === qv.model && b.length === qv.dims;
      let vector: number | null = null;
      if (comparable && (qv.semantic || lexical > 0)) {
        let cos = 0;
        if (qf.length === b.length && qf.length !== 0) {
          let dot = 0;
          for (let i = 0; i < qf.length; i++) dot += qf[i] * b[i];
          const m = qn * Math.sqrt(u.sq[s]);
          cos = m === 0 ? 0 : dot / m;
        }
        vector = vectorScore(cos, qv.semantic);
      }
      let similarity = hybridScore(vector, lexical, qv.semantic);
      if (similarity >= MIN_RECALL_SCORE && u.layer[s] === 'working') similarity += WORKING_LAYER_BOOST;
      if (similarity >= MIN_RECALL_SCORE) { top.push(s, similarity); vectors.set(s, vector); }
    }
  }
  // Re-score the int8 and HNSW candidates with their full vectors (by primary key; the owner is checked).
  const pickedSet = new Set<number>();
  const picked: Array<{ slot: number }> = [];
  for (const c of [...approx.sorted(), ...byWords.sorted()]) if (!pickedSet.has(c.slot)) { pickedSet.add(c.slot); picked.push(c); }
  if (picked.length) {
    const db: any = getDatabase().getDb();
    for (let i = 0; i < picked.length; i += 500) {
      const chunk = picked.slice(i, i + 500);
      const rows = db.prepare(`SELECT id, user_id, embedding_vec, CASE WHEN embedding_vec IS NULL THEN embedding END AS embedding
        FROM memories WHERE id IN (${chunk.map(() => '?').join(', ')})`).all(...chunk.map((c) => u.ids[c.slot])) as Array<{ id: string; user_id: string; embedding_vec: unknown; embedding: string | null }>;
      const byId = new Map(rows.filter((r) => r.user_id === userId).map((r) => [r.id, r]));
      for (const { slot: s } of chunk) {
        const r = byId.get(u.ids[s]);
        if (!r) continue;
        let b: Vec | null = packed(r.embedding_vec);
        if (!b && r.embedding) b = Float64Array.from(JSON.parse(r.embedding) as number[]);
        const lexical = lexOf(s);
        let vector: number | null = null;
        if (b && b.length === qv.dims && qf.length !== 0) {
          let dot = 0, sqb = 0;
          for (let k = 0; k < b.length; k++) { dot += qf[k] * b[k]; sqb += b[k] * b[k]; }
          const m = qn * Math.sqrt(sqb);
          vector = vectorScore(m === 0 ? 0 : dot / m, qv.semantic);
        }
        let similarity = hybridScore(vector, lexical, qv.semantic);
        if (similarity >= MIN_RECALL_SCORE && u.layer[s] === 'working') similarity += WORKING_LAYER_BOOST;
        if (similarity >= MIN_RECALL_SCORE) { top.push(s, similarity); vectors.set(s, vector); }
      }
    }
  }
  const hits = top.sorted().map(({ slot, similarity }) => ({ id: u.ids[slot], similarity, vector: vectors.get(slot) ?? null, lexical: lexOf(slot) }));
  for (const s of touched) u.mark[s] = 0;
  return hits;
}
