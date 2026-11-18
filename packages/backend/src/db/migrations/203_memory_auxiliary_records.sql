-- Authenticated owner-joined legacy child content, preserved without implicit replay.
CREATE TABLE IF NOT EXISTS memory_encryption_auxiliary (
 id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,bundle_id TEXT NOT NULL,ordinal INTEGER NOT NULL,parts INTEGER NOT NULL,
 sha256 TEXT NOT NULL,format TEXT NOT NULL,created_at TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(owner_id,ordinal)
);
