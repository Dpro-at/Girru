-- Admission receipts only; message text is stored solely by normal chat admission.
CREATE TABLE mcp_chat_requests (
 owner_id TEXT NOT NULL REFERENCES users(id),
 session_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 run_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('reserved','submitted','refused')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(owner_id,session_id,request_id)
);
