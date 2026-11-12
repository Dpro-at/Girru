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

export function recallStoreStats(): { users: number; userIds: string[]; entries: number; bytes: number } {
  let entries = 0;
  for (const u of users.values()) for (const d of u.drawers.values()) entries += d.slots.length - d.dead;
  return { users: users.size, userIds: [...users.keys()], entries, bytes: storeBytes };
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
    created: [], model: [], vec: [], sq: [], len: [], slotBytes: [], terms: new Map(), acc: new Float64Array(1024), mark: new Uint8Array(1024), bytes: 0,
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
  u.vec.push(vec); u.sq.push(sq); u.len.push(tokens.length);
  u.slotOf.set(r.id, slot);
  d.slots.push(slot);
  if (!replaced) { d.live++; d.sumLen += tokens.length; }
  const bytes = 200 + r.id.length * 2 + (vec ? vec.byteLength : 0) + counts.size * 8;
  u.slotBytes.push(bytes);
  d.bytes += bytes; u.bytes += bytes; storeBytes += bytes;
}

function killSlot(u: UserStore, slot: number): void {
  if (!u.alive[slot]) return;
  u.alive[slot] = 0;
  const d = u.drawerOf[slot];
  d.dead++;
  if (!u.replaced[slot]) { d.live--; d.sumLen -= u.len[slot]; }
  u.slotOf.delete(u.ids[slot]);
  u.vec[slot] = null; // free the vector now; the rest goes at compaction
  const b = u.slotBytes[slot];
  d.bytes -= b; u.bytes -= b; storeBytes -= b;
}

/** Drop dead slots from posting lists and drawer lists once many have died. */
function compact(u: UserStore): void {
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
  const d: Drawer = { kind, key, slots: [], dead: 0, live: 0, sumLen: 0, bytes: 0 };
  const first = db.prepare(`SELECT ${ROW_COLUMNS} FROM memories WHERE user_id = ? AND ${DRAWER_KIND_SQL} = ? AND ${DRAWER_KEY_SQL} = ?
    ORDER BY created_at ASC, id ASC LIMIT ${PAGE}`);
  const next = db.prepare(`SELECT ${ROW_COLUMNS} FROM memories WHERE user_id = ? AND ${DRAWER_KIND_SQL} = ? AND ${DRAWER_KEY_SQL} = ?
    AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT ${PAGE}`);
  const cap = storeCapBytes();
  let rows = first.all(userId, kind, key) as FullRow[];
  while (rows.length) {
    for (const r of rows) addSlot(u, d, r);
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
      if (d) addSlot(u, d, r); // a drawer not loaded yet reads it when it is first searched
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

interface QueryVector { vector: number[]; model: string; dims: number; semantic: boolean }

/**
 * Prepare a user's store for these drawers (load, apply changes). Null when
 * this store cannot serve the search (not the main SQLite connection, or past
 * the size cap): the caller uses the P9 path.
 */
export async function openStore(userId: string, drawers: DrawerRef[]): Promise<{ drawers: Drawer[] } | null> {
  if (!ready()) return null;
  const now = Date.now();
  for (const [id, x] of users) if (now - x.lastUsed > IDLE_MS) dropUser(id);
  let u = users.get(userId);
  if (!u) { u = newUser(now); users.set(userId, u); }
  u.lastUsed = now;
  applyChanges(u, userId);

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
    }
    out.push(d);
  }
  return { drawers: out };
}

/** Rows whose vector is not of `model`, among the candidates, oldest first (lazy re-embed). */
export function staleIn(userId: string, open: { drawers: Drawer[] }, q: StoreQuery, model: string, max: number): Array<{ id: string; content: string }> {
  const u = users.get(userId);
  if (!u) return [];
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
export function searchStore(userId: string, open: { drawers: Drawer[] }, q: StoreQuery, qv: QueryVector): StoreHit[] {
  const u = users.get(userId)!;
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
  for (const d of open.drawers) {
    for (const s of d.slots) {
      if (!u.alive[s] || (filtered && !candidate(u, s, q)) || (!filtered && u.replaced[s])) continue;
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
    }
  }
  const hits = top.sorted().map(({ slot, similarity }) => ({ id: u.ids[slot], similarity, vector: vectors.get(slot) ?? null, lexical: lexOf(slot) }));
  for (const s of touched) u.mark[s] = 0;
  return hits;
}
