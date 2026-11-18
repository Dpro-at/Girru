-- Textual review requests only; no apply/approval transition or capability grants.
CREATE TABLE workspace_control_drafts (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id),
 request_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('skill','personality','specialty','rule','agent')),
 action TEXT NOT NULL CHECK(action IN ('create','update','assign')),
 target_id TEXT,
 agent_id TEXT,
 target_fingerprint TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(owner_id,request_id)
);
