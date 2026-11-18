-- Explicit owner-reviewed document admissions; payloads are encrypted by selected storage.
CREATE TABLE IF NOT EXISTS memory_encryption_document_admissions (
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,source_id TEXT NOT NULL,file_id TEXT NOT NULL,file_hash TEXT NOT NULL,
 key_id TEXT NOT NULL,authority_id TEXT NOT NULL,epoch BIGINT NOT NULL,forget_sequence BIGINT NOT NULL,forget_mac TEXT NOT NULL,
 source_revision BIGINT NOT NULL,file_revision BIGINT NOT NULL,review_hash TEXT NOT NULL,state TEXT NOT NULL,
 created_by TEXT NOT NULL,created_at TEXT NOT NULL,decided_by TEXT,decided_at TEXT,plan TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_encryption_document_admissions_file ON memory_encryption_document_admissions(owner_id,file_id,state);
