-- Idempotency receipts retain identifiers and fingerprints, never memory text.
CREATE TABLE mcp_memory_requests (
 owner_id TEXT NOT NULL REFERENCES users(id),
 request_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 proposal_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (owner_id, request_id)
);
