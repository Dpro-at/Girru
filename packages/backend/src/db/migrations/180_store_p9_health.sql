-- STORE-MAP-01 P9 (OPS6, FAIL6): local memory health counts (GIRRU_STORE_P9).
--
-- One row per event: a save that did not happen, a recall that failed (the
-- reply went on without memory), a scheduled memory doctor run (its counts),
-- or the one notice raised for a repeated failure. Ids and counts only, never
-- memory text. Rows older than 30 days are removed when new ones come
-- (memory/health.ts). Nothing here leaves the computer.
CREATE TABLE IF NOT EXISTS memory_health_events (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('save_failed', 'recall_failed', 'doctor', 'notice')),
  ref TEXT,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_health_events_owner ON memory_health_events (owner_id, kind, at);
