import {assertNoDefaultMemoryAccess} from './encryption/execution-context.js';
/**
 * Memory Indexer
 * Hybrid search with Vector + Full-text + Recency scoring
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import type {
  Memory,
  MemoryChunk,
  MemorySearchResult,
  MemorySearchQuery,
  IndexStats,
  IMemoryIndexer,
  MemoryConfig,
} from './types.js';
import { DEFAULT_MEMORY_CONFIG } from './types.js';
import { getEmbeddingService } from './embedding.js';

/**
 * Tables of the hybrid index file (SQLite DDL). The same DDL is the source of
 * migrations-pg r004 (scripts/pg/runtime/r004_memory_index.sql, kept equal by
 * test/pg-runtime-ddl.test.mjs): on PostgreSQL the tables live in the main
 * database (memory/indexer-pg.ts).
 */
export const INDEXER_TABLES_SQL = `
-- Memory index table
CREATE TABLE IF NOT EXISTS memory_index (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  layer TEXT NOT NULL,
  importance INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  last_accessed TEXT,
  access_count INTEGER DEFAULT 0,
  tags TEXT,
  embedding_model TEXT,
  UNIQUE(memory_id)
);

-- Chunks table for large memories
CREATE TABLE IF NOT EXISTS memory_chunks (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  position INTEGER NOT NULL,
  offset_start INTEGER NOT NULL,
  offset_end INTEGER NOT NULL,
  embedding_model TEXT,
  FOREIGN KEY (memory_id) REFERENCES memory_index(memory_id) ON DELETE CASCADE
);

-- Relations table
CREATE TABLE IF NOT EXISTS memory_relations (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  strength REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id, relation_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_memory_layer ON memory_index(layer);
CREATE INDEX IF NOT EXISTS idx_memory_importance ON memory_index(importance);
CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_index(created_at);
CREATE INDEX IF NOT EXISTS idx_chunks_memory ON memory_chunks(memory_id);
`;

/**
 * The FTS5 full-text table (SQLite only). Source of migrations-pg r005
 * (scripts/pg/runtime/r005_memory_fts.sql); PostgreSQL has no FTS5, so r005
 * is a hand-written override (scripts/pg/overrides/r005_memory_fts.sql): a
 * generated tsvector column on memory_index with a GIN index
 * (memory/indexer-pg.ts explains the design and the differences).
 */
export const INDEXER_FTS_SQL = `
-- Full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memory_id,
  content,
  tags,
  tokenize='porter unicode61'
);
`;

export class MemoryIndexer implements IMemoryIndexer {
  private db: Database.Database;
  private config: MemoryConfig;
  private embeddingService = getEmbeddingService();
  private pendingUpdates: number = 0;
  private lastSync: Date = new Date();

  constructor(config: Partial<MemoryConfig> = {}) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };

    // Ensure directory exists
    const dir = dirname(this.config.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.config.dbPath);
    this.db.pragma('journal_mode = WAL');

    this.createTables();
  }

  /**
   * Create database tables
   */
  private createTables(): void {
    this.db.exec(INDEXER_TABLES_SQL);
    this.db.exec(INDEXER_FTS_SQL);
    // CORE-06: model of each stored vector; vectors of other models are not compared.
    for (const table of ['memory_index', 'memory_chunks']) {
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
      if (!cols.includes('embedding_model')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN embedding_model TEXT`);
    }
  }

  /**
   * Index a memory
   */
  async index(memory: Memory): Promise<void> {
    // Generate embedding if not present
    const embedding = memory.embedding || await this.embeddingService.embed(memory.content);
    const embeddingModel = this.embeddingService.modelOf(embedding) ?? memory.embeddingModel ?? 'unknown';
    const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);

    // Insert/update memory index
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_index (
        id, memory_id, content, embedding, layer, importance,
        created_at, last_accessed, access_count, tags, embedding_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id,
      memory.id,
      memory.content,
      embeddingBuffer,
      memory.layer,
      memory.importance,
      memory.createdAt.toISOString(),
      memory.lastAccessed?.toISOString() || null,
      memory.accessCount,
      JSON.stringify(memory.tags || []),
      embeddingModel
    );

    // Update FTS index
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_fts (memory_id, content, tags)
      VALUES (?, ?, ?)
    `).run(
      memory.id,
      memory.content,
      (memory.tags || []).join(' ')
    );

    // Chunk large memories
    if (memory.content.length > this.config.chunkSize * 4) {
      await this.chunkMemory(memory, embedding);
    }

    this.pendingUpdates++;
  }

  /**
   * Chunk a large memory into smaller pieces
   */
  private async chunkMemory(memory: Memory, _parentEmbedding: number[]): Promise<void> {
    // Remove existing chunks
    this.db.prepare('DELETE FROM memory_chunks WHERE memory_id = ?').run(memory.id);

    // Split into chunks
    const chunkSize = this.config.chunkSize * 4; // ~4 chars per token approximation
    const overlap = this.config.chunkOverlap * 4;
    const chunks: MemoryChunk[] = [];

    let position = 0;
    let offset = 0;

    while (offset < memory.content.length) {
      const end = Math.min(offset + chunkSize, memory.content.length);
      const content = memory.content.slice(offset, end);

      const embedding = await this.embeddingService.embed(content);

      chunks.push({
        id: `${memory.id}_chunk_${position}`,
        memoryId: memory.id,
        content,
        embedding,
        position,
        offsetStart: offset,
        offsetEnd: end,
      });

      offset = end - overlap;
      if (offset >= memory.content.length - overlap) break;
      position++;
    }

    // Insert chunks
    const stmt = this.db.prepare(`
      INSERT INTO memory_chunks (id, memory_id, content, embedding, position, offset_start, offset_end)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      const embeddingBuffer = Buffer.from(new Float32Array(chunk.embedding).buffer);
      stmt.run(
        chunk.id,
        chunk.memoryId,
        chunk.content,
        embeddingBuffer,
        chunk.position,
        chunk.offsetStart,
        chunk.offsetEnd
      );
    }
  }

  /**
   * Remove a memory from index
   */
  async remove(memoryId: string): Promise<void> {
    this.db.prepare('DELETE FROM memory_index WHERE memory_id = ?').run(memoryId);
    this.db.prepare('DELETE FROM memory_chunks WHERE memory_id = ?').run(memoryId);
    this.db.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId);
    this.db.prepare('DELETE FROM memory_relations WHERE source_id = ? OR target_id = ?')
      .run(memoryId, memoryId);
  }

  /**
   * Remove a memory for good (CORE-07 forget): the index rows, and the
   * full-text index is merged so no old token segment keeps its words.
   * Freed pages are zeroed (secure_delete) and the WAL is checkpointed.
   */
  async purge(memoryId: string): Promise<void> {
    this.db.pragma('secure_delete = ON');
    await this.remove(memoryId);
    this.db.prepare(`INSERT INTO memory_fts(memory_fts) VALUES('optimize')`).run();
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* busy: checkpointed later */ }
  }

  /**
   * Hybrid search combining vector, keyword, and recency
   */
  async search(
    query: string,
    embedding: number[],
    limit: number = 10,
    options: Partial<MemorySearchQuery> = {}
  ): Promise<MemorySearchResult[]> {
    const weights = this.config.searchWeights;

    // Vector search (only vectors of the query vector's model, CORE-06)
    const vectorResults = await this.vectorSearch(embedding, limit * 3, this.embeddingService.modelOf(embedding));

    // Keyword search (FTS)
    const keywordResults = await this.keywordSearch(query, limit * 3);

    // Merge results with hybrid scoring
    const resultMap = new Map<string, {
      memory: any;
      vectorScore: number;
      keywordScore: number;
      recencyScore: number;
      importanceScore: number;
    }>();

    // Process vector results
    for (const result of vectorResults) {
      resultMap.set(result.memoryId, {
        memory: result,
        vectorScore: result.score,
        keywordScore: 0,
        recencyScore: this.calculateRecencyScore(result.createdAt),
        importanceScore: result.importance / 10,
      });
    }

    // Process keyword results
    for (const result of keywordResults) {
      const existing = resultMap.get(result.memoryId);
      if (existing) {
        existing.keywordScore = result.score;
      } else {
        resultMap.set(result.memoryId, {
          memory: result,
          vectorScore: 0,
          keywordScore: result.score,
          recencyScore: this.calculateRecencyScore(result.createdAt),
          importanceScore: result.importance / 10,
        });
      }
    }

    // Calculate final scores and sort
    const results: MemorySearchResult[] = Array.from(resultMap.values())
      .map(({ memory, vectorScore, keywordScore, recencyScore, importanceScore }) => {
        const finalScore =
          weights.vector * vectorScore +
          weights.keyword * keywordScore +
          weights.recency * recencyScore +
          weights.importance * importanceScore;

        return {
          memory: this.rowToMemory(memory),
          similarity: finalScore,
          scoreBreakdown: {
            vectorScore,
            keywordScore,
            recencyScore,
            importanceScore,
          },
        };
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    // Apply filters if provided
    return this.applyFilters(results, options);
  }

  /**
   * Vector similarity search
   */
  private async vectorSearch(embedding: number[], limit: number, model?: string): Promise<any[]> {
    const rows = this.db.prepare(`
      SELECT * FROM memory_index
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit * 2) as any[];

    // Calculate cosine similarity for each
    const queryEmbedding = embedding;

    return rows
      .map((row) => {
        const storedEmbedding = this.bufferToEmbedding(row.embedding);
        const score = storedEmbedding && (!model || row.embedding_model === model)
          ? this.embeddingService.similarity(queryEmbedding, storedEmbedding)
          : 0;

        return { ...row, memoryId: row.memory_id, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Full-text keyword search
   */
  private async keywordSearch(query: string, limit: number): Promise<any[]> {
    try {
      const rows = this.db.prepare(`
        SELECT m.*, fts.rank
        FROM memory_fts fts
        JOIN memory_index m ON m.memory_id = fts.memory_id
        WHERE memory_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `).all(query, limit) as any[];

      // Normalize BM25 ranks to 0-1 scores
      return rows.map((row) => ({
        ...row,
        memoryId: row.memory_id,
        score: 1 / (1 + Math.abs(row.rank || 0)),
      }));
    } catch {
      // FTS query might fail with special characters
      return [];
    }
  }

  /**
   * Calculate recency score (0-1)
   */
  private calculateRecencyScore(createdAt: string): number {
    const age = Date.now() - new Date(createdAt).getTime();
    const dayInMs = 24 * 60 * 60 * 1000;

    // Exponential decay: score = e^(-age/halfLife)
    // Half-life of 7 days
    const halfLife = 7 * dayInMs;
    return Math.exp(-age / halfLife);
  }

  /**
   * Convert buffer to embedding array
   */
  private bufferToEmbedding(buffer: Buffer | null): number[] | null {
    if (!buffer) return null;
    return Array.from(new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4));
  }

  /**
   * Apply search filters
   */
  private applyFilters(
    results: MemorySearchResult[],
    options: Partial<MemorySearchQuery>
  ): MemorySearchResult[] {
    return results.filter((result) => {
      const memory = result.memory;

      if (options.types && !options.types.includes(memory.type)) {
        return false;
      }

      if (options.layers && (!memory.layer || !options.layers.includes(memory.layer))) {
        return false;
      }

      // A memory without an importance counts as 0 (it used to pass any minimum).
      if (options.minImportance && (memory.importance ?? 0) < options.minImportance) {
        return false;
      }

      if (options.fromDate && memory.createdAt < options.fromDate) {
        return false;
      }

      if (options.toDate && memory.createdAt > options.toDate) {
        return false;
      }

      if (options.tags && options.tags.length > 0) {
        const memoryTags = memory.tags || [];
        if (!options.tags.some((tag) => memoryTags.includes(tag))) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Convert database row to Memory object
   */
  private rowToMemory(row: any): Memory {
    return {
      id: row.memory_id || row.id,
      userId: row.user_id || '',
      type: row.type || 'fact',
      content: row.content,
      embedding: row.embedding ? this.bufferToEmbedding(row.embedding) || undefined : undefined,
      layer: row.layer || 'daily',
      importance: row.importance || 5,
      status: 'active',
      createdAt: new Date(row.created_at),
      lastAccessed: row.last_accessed ? new Date(row.last_accessed) : undefined,
      accessCount: row.access_count || 0,
      tags: row.tags ? JSON.parse(row.tags) : [],
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    };
  }

  /**
   * Add relationship between memories
   */
  addRelation(
    sourceId: string,
    targetId: string,
    type: 'similar' | 'related' | 'contradicts' | 'supports' | 'follows',
    strength: number
  ): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_relations (source_id, target_id, relation_type, strength, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sourceId, targetId, type, strength, new Date().toISOString());
  }

  /**
   * Get related memories
   */
  getRelated(memoryId: string, limit: number = 5): string[] {
    const rows = this.db.prepare(`
      SELECT target_id FROM memory_relations
      WHERE source_id = ?
      ORDER BY strength DESC
      LIMIT ?
    `).all(memoryId, limit) as any[];

    return rows.map((r) => r.target_id);
  }

  /**
   * Sync index (no-op for now, can be used for background tasks)
   */
  async sync(): Promise<void> {
    this.lastSync = new Date();
    this.pendingUpdates = 0;
  }

  /**
   * Get index statistics
   */
  getStats(): IndexStats {
    const memoryCount = (this.db.prepare('SELECT COUNT(*) as count FROM memory_index').get() as any).count;
    const chunkCount = (this.db.prepare('SELECT COUNT(*) as count FROM memory_chunks').get() as any).count;

    return {
      totalMemories: memoryCount,
      totalChunks: chunkCount,
      indexSize: 0, // Would need file system access
      lastSync: this.lastSync,
      pendingUpdates: this.pendingUpdates,
    };
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }
}

// Singleton
let indexer: MemoryIndexer | null = null;

export function getMemoryIndexer(config?: Partial<MemoryConfig>): MemoryIndexer {
  assertNoDefaultMemoryAccess();
  if (!indexer) {
    indexer = new MemoryIndexer(config);
  }
  return indexer;
}

for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(MemoryIndexer.prototype))){if(name==='constructor'||typeof descriptor.value!=='function')continue;const original=descriptor.value;Object.defineProperty(MemoryIndexer.prototype,name,{...descriptor,value:function(this:MemoryIndexer,...args:unknown[]){assertNoDefaultMemoryAccess();return original.apply(this,args);}});}
