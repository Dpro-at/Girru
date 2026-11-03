-- STORE-MAP-01 P6 (GIRRU_STORE_P6), FAIL2: idempotent memory writes.
--
-- A write through the memory contract may carry a request id chosen by the
-- caller. The first call records it (status 'pending', then 'done' with its
-- answer); a retry with the same id gets the same answer and writes nothing
-- again. Ids and the answer's ids only, never memory text.
CREATE TABLE IF NOT EXISTS write_requests (
  owner_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  verb TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_write_requests_created ON write_requests(created_at);
