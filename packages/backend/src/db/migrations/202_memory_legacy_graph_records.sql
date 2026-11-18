-- Authenticated bounded parts preserve the full legacy graph, including rejected decisions.
CREATE TABLE IF NOT EXISTS memory_encryption_legacy_graph (
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,bundle_id TEXT NOT NULL,ordinal INTEGER NOT NULL,parts INTEGER NOT NULL,
 sha256 TEXT NOT NULL,format TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(owner_id,ordinal)
);
