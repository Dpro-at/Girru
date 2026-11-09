/** Shared existing SQL-row mapping. Callers must authenticate and decrypt before using it. */
import type {Memory,MemoryType} from './types.js';
import {unpackVector} from './vectors.js';
import {LEGACY_HASH_MODEL} from './embedding.js';
import {normalizeDrawer,defaultDrawerForType} from './drawers.js';
export function memoryFromDecryptedRow(row:any):Memory {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type as MemoryType,
      content: row.content,
      // STORE-MAP-01 P3: the packed Float32 vector when there is one, else the JSON text.
      embedding: (row.embedding_vec ? unpackVector(row.embedding_vec) : null) ?? (row.embedding ? JSON.parse(row.embedding) : undefined),
      embeddingModel: (row.embedding||row.embedding_vec) ? (row.embedding_model || LEGACY_HASH_MODEL) : undefined,
      memoryLayer: row.memory_layer || 'factual',
      importanceScore: row.importance_score ?? 0.5,
      status: row.status || 'active',
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      createdAt: new Date(row.created_at),
      lastAccessedAt: row.last_accessed_at || null,
      accessCount: row.access_count ?? 0,
      tags: row.tags ? JSON.parse(row.tags) : [],
      expiryTimestamp: row.expiry_timestamp || null,
      consolidationStatus: row.consolidation_status || 'pending',
      drawer: drawerOfRow(row),
      topicKey: row.topic_key ?? null,
      sourceAgentId: row.source_agent_id ?? null,
    };
  
}

function drawerOfRow(row:any){if(row.drawer_kind){try{return normalizeDrawer(row.drawer_key?{kind:row.drawer_kind,key:row.drawer_key}:{kind:row.drawer_kind});}catch{}}return defaultDrawerForType(row.type);}
