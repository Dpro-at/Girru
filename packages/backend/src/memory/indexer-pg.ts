import {assertNoDefaultMemoryAccess} from './encryption/execution-context.js';
/**
 * Memory hybrid index on PostgreSQL (B2.2b-4).
 *
 * On SQLite the hybrid index (memory/indexer.ts) is its own file
 * (.data/memory/memory.db) with an FTS5 table. On PostgreSQL it lives in the
 * main database (migrations-pg r004/r005, from scripts/pg/runtime):
 *
 *   memory_index / memory_chunks / memory_relations
 *       the same tables; vectors are Float32 bytes (BLOB -> bytea, a Buffer
 *       both ways). Similarity stays in JS (no pgvector).
 *   full text (FTS5 memory_fts -> a generated column)
 *       memory_index.fts tsvector GENERATED ALWAYS AS
 *         (to_tsvector('simple', content || ' ' || tags)) STORED
 *       with a GIN index. The 'simple' configuration lower-cases and splits
 *       words without stemming or stop words, so Arabic, German and other
 *       languages are never stemmed with English rules. The row and its
 *       tokens go together (no separate FTS table to purge).
 *   query
 *       websearch_to_tsquery('simple', q): words are ANDed, "quoted phrases",
 *       OR and -word like the FTS5 query syntax, and it never fails on
 *       punctuation (FTS5 MATCH raises; the SQLite code then returns []).
 *   ranking
 *       ts_rank_cd (cover density), best first, like ORDER BY fts.rank
 *       (bm25) on SQLite. The keyword score keeps the SQLite formula
 *       1 / (1 + |rank|) over the engine's own rank value; the two engines'
 *       raw ranks are on different scales, so the order within the keyword
 *       results matches, the absolute keyword scores do not.
 *   trigram fallback
 *       only when the pg_trgm extension is already installed in the database
 *       (this module never creates it): when the full-text query finds
 *       nothing, rows whose content has a trigram similarity >= 0.3 with the
 *       query are returned, best first (catches attached Arabic prefixes such
 *       as و / ال / ب that 'simple' keeps as part of the word).
 *
 * Differences from SQLite FTS5 ('porter unicode61'): no English stemming
 * ("running" does not find "run"), no diacritic folding; PostgreSQL has no
 * secure_delete: a purged row's old tuple stays in the table file until
 * VACUUM reuses the space (autovacuum), the WAL is not truncated.
 */

import type { IndexStats, Memory, MemoryChunk, MemorySearchQuery, MemorySearchResult, MemoryConfig } from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import { getEmbeddingService } from './embedding.js';
import { all, one, run, sql, type Step } from '../repositories/sql-steps.js';

/** Float32 bytes of a vector (SQLite BLOB, PostgreSQL bytea). */
export function embeddingToBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

/** The vector of Float32 bytes (a Buffer from either driver), or null. */
export function bufferToEmbedding(buffer: Buffer | Uint8Array | null | undefined): number[] | null {
  if (!buffer) return null;
  const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (b.length % 4 !== 0) return null;
  // Copy into an aligned buffer: a pg Buffer may start at any byte offset.
  const aligned = new Uint8Array(b.length);
  aligned.set(b);
  return Array.from(new Float32Array(aligned.buffer));
}

/** Minimum pg_trgm similarity for the fallback. */
export const TRGM_MIN_SIMILARITY = 0.3;

/** Remove one memory from the PostgreSQL hybrid index (SQL step: joins forget's transaction). */
export function* purgePgIndexStep(memoryId: string): Step<void> {
  yield* run('DELETE FROM memory_chunks WHERE memory_id = ?', memoryId);
  yield* run('DELETE FROM memory_index WHERE memory_id = ?', memoryId);
  yield* run('DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?', memoryId, memoryId);
}

export class PgMemoryIndexer {
  private config: MemoryConfig;
  private embeddingService = getEmbeddingService();
  private pendingUpdates = 0;
  private lastSync: Date = new Date();
  private trgm: Promise<boolean> | null = null;

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };
  }

  /** Index a memory (row, full text through the generated column, chunks). */
  async index(memory: Memory): Promise<void> {
    const embedding = memory.embedding || await this.embeddingService.embed(memory.content);
    const embeddingModel = this.embeddingService.modelOf(embedding) ?? memory.embeddingModel ?? 'unknown';
    const chunks = memory.content.length > this.config.chunkSize * 4 ? await this.makeChunks(memory) : null;
    await sql().tx(function* () {
      yield* run(`
        INSERT INTO memory_index (id, memory_id, content, embedding, layer, importance, created_at, last_accessed, access_count, tags, embedding_model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET memory_id = excluded.memory_id, content = excluded.content, embedding = excluded.embedding,
          layer = excluded.layer, importance = excluded.importance, created_at = excluded.created_at,
          last_accessed = excluded.last_accessed, access_count = excluded.access_count, tags = excluded.tags,
          embedding_model = excluded.embedding_model
      `, memory.id, memory.id, memory.content, embeddingToBuffer(embedding), memory.layer ?? 'daily', memory.importance ?? 5,
        memory.createdAt.toISOString(), memory.lastAccessed?.toISOString() || null, memory.accessCount,
        JSON.stringify(memory.tags || []), embeddingModel);
      if (chunks) {
        yield* run('DELETE FROM memory_chunks WHERE memory_id = ?', memory.id);
        for (const c of chunks) {
          yield* run(`INSERT INTO memory_chunks (id, memory_id, content, embedding, position, offset_start, offset_end)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`,
            c.id, c.memoryId, c.content, embeddingToBuffer(c.embedding), c.position, c.offsetStart, c.offsetEnd);
        }
      }
    });
    this.pendingUpdates++;
  }

  /** Split a large memory into overlapping chunks with their own vectors (same rule as SQLite). */
  private async makeChunks(memory: Memory): Promise<MemoryChunk[]> {
    const chunkSize = this.config.chunkSize * 4;
    const overlap = this.config.chunkOverlap * 4;
    const chunks: MemoryChunk[] = [];
    let position = 0;
    let offset = 0;
    while (offset < memory.content.length) {
      const end = Math.min(offset + chunkSize, memory.content.length);
      const content = memory.content.slice(offset, end);
      chunks.push({
        id: `${memory.id}_chunk_${position}`, memoryId: memory.id, content,
        embedding: await this.embeddingService.embed(content), position, offsetStart: offset, offsetEnd: end,
      });
      offset = end - overlap;
      if (offset >= memory.content.length - overlap) break;
      position++;
    }
    return chunks;
  }

  async remove(memoryId: string): Promise<void> {
    await sql().tx(() => purgePgIndexStep(memoryId));
  }

  /** Forget (CORE-07): the rows go, and the full text with them (generated column). */
  async purge(memoryId: string): Promise<void> {
    await this.remove(memoryId);
  }

  /** Hybrid search: vector + full text + recency + importance (same weights as SQLite). */
  async search(query: string, embedding: number[], limit = 10, options: Partial<MemorySearchQuery> = {}): Promise<MemorySearchResult[]> {
    const weights = this.config.searchWeights;
    const vectorResults = await this.vectorSearch(embedding, limit * 3, this.embeddingService.modelOf(embedding));
    const keywordResults = await this.keywordSearch(query, limit * 3);
    const map = new Map<string, { memory: any; vectorScore: number; keywordScore: number; recencyScore: number; importanceScore: number }>();
    for (const r of vectorResults) {
      map.set(r.memoryId, { memory: r, vectorScore: r.score, keywordScore: 0, recencyScore: recency(r.created_at), importanceScore: r.importance / 10 });
    }
    for (const r of keywordResults) {
      const e = map.get(r.memoryId);
      if (e) e.keywordScore = r.score;
      else map.set(r.memoryId, { memory: r, vectorScore: 0, keywordScore: r.score, recencyScore: recency(r.created_at), importanceScore: r.importance / 10 });
    }
    const results: MemorySearchResult[] = [...map.values()]
      .map(({ memory, vectorScore, keywordScore, recencyScore, importanceScore }) => ({
        memory: rowToMemory(memory),
        similarity: weights.vector * vectorScore + weights.keyword * keywordScore + weights.recency * recencyScore + weights.importance * importanceScore,
        scoreBreakdown: { vectorScore, keywordScore, recencyScore, importanceScore },
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
    return applyFilters(results, options);
  }

  /** Vectors of the newest rows (only the query vector's model), cosine in JS. */
  private async vectorSearch(embedding: number[], limit: number, model?: string): Promise<any[]> {
    const rows = await sql().read(all('SELECT * FROM memory_index ORDER BY created_at DESC, id DESC LIMIT ?', limit * 2));
    return rows
      .map((row) => {
        const stored = bufferToEmbedding(row.embedding);
        const score = stored && (!model || row.embedding_model === model) ? this.embeddingService.similarity(embedding, stored) : 0;
        return { ...row, memoryId: row.memory_id, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Full-text search (see the header): tsvector 'simple' + GIN, pg_trgm fallback when installed. */
  async keywordSearch(query: string, limit: number): Promise<any[]> {
    if (typeof query !== 'string' || !query.trim()) return [];
    const rows = await sql().read(all(`
      SELECT m.*, ts_rank_cd(m.fts, q) AS rank
        FROM memory_index m, websearch_to_tsquery('simple', ?) q
       WHERE m.fts @@ q
       ORDER BY rank DESC, m.memory_id
       LIMIT ?`, query, limit));
    if (rows.length === 0 && await this.hasTrgm()) {
      const fuzzy = await sql().read(all(`
        SELECT m.*, similarity(m.content, ?) AS rank
          FROM memory_index m
         WHERE similarity(m.content, ?) >= ?
         ORDER BY rank DESC, m.memory_id
         LIMIT ?`, query, query, TRGM_MIN_SIMILARITY, limit));
      return fuzzy.map((row) => ({ ...row, memoryId: row.memory_id, score: 1 / (1 + Math.abs(Number(row.rank) || 0)), fuzzy: true }));
    }
    return rows.map((row) => ({ ...row, memoryId: row.memory_id, score: 1 / (1 + Math.abs(Number(row.rank) || 0)) }));
  }

  /** pg_trgm installed in this database? (checked once; never created here) */
  hasTrgm(): Promise<boolean> {
    if (!this.trgm) {
      this.trgm = sql().read(one(`SELECT 1 AS ok FROM pg_extension WHERE extname = 'pg_trgm'`)).then((r) => !!r, () => false);
    }
    return this.trgm;
  }

  async addRelation(sourceId: string, targetId: string, type: 'similar' | 'related' | 'contradicts' | 'supports' | 'follows', strength: number): Promise<void> {
    await sql().read(run(`
      INSERT INTO memory_relations (source_id, target_id, relation_type, strength, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (source_id, target_id, relation_type) DO UPDATE SET strength = excluded.strength, created_at = excluded.created_at
    `, sourceId, targetId, type, strength, new Date().toISOString()));
  }

  async getRelated(memoryId: string, limit = 5): Promise<string[]> {
    const rows = await sql().read(all<{ target_id: string }>('SELECT target_id FROM memory_relations WHERE source_id = ? ORDER BY strength DESC, target_id LIMIT ?', memoryId, limit));
    return rows.map((r) => r.target_id);
  }

  async sync(): Promise<void> {
    this.lastSync = new Date();
    this.pendingUpdates = 0;
  }

  async getStats(): Promise<IndexStats> {
    const m = await sql().read(one<{ count: number }>('SELECT COUNT(*) AS count FROM memory_index'));
    const c = await sql().read(one<{ count: number }>('SELECT COUNT(*) AS count FROM memory_chunks'));
    return { totalMemories: m?.count ?? 0, totalChunks: c?.count ?? 0, indexSize: 0, lastSync: this.lastSync, pendingUpdates: this.pendingUpdates };
  }

  /** Nothing to close: the process pool is shared. */
  close(): void {}
}

function recency(createdAt: string): number {
  const age = Date.now() - new Date(createdAt).getTime();
  return Math.exp(-age / (7 * 24 * 60 * 60 * 1000));
}

function rowToMemory(row: any): Memory {
  return {
    id: row.memory_id || row.id,
    userId: row.user_id || '',
    type: row.type || 'fact',
    content: row.content,
    embedding: bufferToEmbedding(row.embedding) || undefined,
    layer: row.layer || 'daily',
    importance: row.importance || 5,
    status: 'active',
    createdAt: new Date(row.created_at),
    lastAccessed: row.last_accessed ? new Date(row.last_accessed) : undefined,
    accessCount: row.access_count || 0,
    tags: row.tags ? JSON.parse(row.tags) : [],
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  } as Memory;
}

function applyFilters(results: MemorySearchResult[], options: Partial<MemorySearchQuery>): MemorySearchResult[] {
  return results.filter(({ memory }) => {
    if (options.types && !options.types.includes(memory.type)) return false;
    if (options.layers && !(memory.layer && options.layers.includes(memory.layer))) return false;
    if (options.minImportance && (memory.importance ?? 0) < options.minImportance) return false;
    if (options.fromDate && memory.createdAt < options.fromDate) return false;
    if (options.toDate && memory.createdAt > options.toDate) return false;
    if (options.tags && options.tags.length > 0 && !options.tags.some((t) => (memory.tags || []).includes(t))) return false;
    return true;
  });
}

let pgIndexer: PgMemoryIndexer | null = null;

/** The PostgreSQL hybrid index (AGENT_PLAYER_DB=postgres). */
export function getPgMemoryIndexer(config?: Partial<MemoryConfig>): PgMemoryIndexer {
  assertNoDefaultMemoryAccess();
  if (!pgIndexer) pgIndexer = new PgMemoryIndexer(config);
  return pgIndexer;
}

for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(PgMemoryIndexer.prototype))){if(name==='constructor'||typeof descriptor.value!=='function')continue;const original=descriptor.value;Object.defineProperty(PgMemoryIndexer.prototype,name,{...descriptor,value:function(this:PgMemoryIndexer,...args:unknown[]){assertNoDefaultMemoryAccess();return original.apply(this,args);}});}
