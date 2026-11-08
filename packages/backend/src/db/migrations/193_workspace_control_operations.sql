-- Real owner-reviewed operations; executing the operation requires a bound one-use approval ticket.
CREATE TABLE workspace_control_operations (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id),
 source TEXT NOT NULL CHECK(source IN ('external','native')),
 source_agent_id TEXT,
 source_session_id TEXT,
 request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 binding_nonce TEXT NOT NULL,
 kind TEXT NOT NULL,
 action TEXT NOT NULL,
 resource_id TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 snapshot_json TEXT NOT NULL,
 preview_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('preview','pending','applying','applied','uncertain')),
 approval_id TEXT UNIQUE,
 result_json TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(owner_id,source,request_id)
);
