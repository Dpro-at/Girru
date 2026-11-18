-- STORE-MAP-01 P7 (GIRRU_STORE_P7), A7 / S9: Cursor and GitHub Copilot CLI join
-- the memory bridge. memory_bridge_clients is rebuilt with the wider check
-- (SQLite cannot change a CHECK in place); every row is kept. The two new
-- clients are offered only while P7 is on.
CREATE TABLE memory_bridge_clients_v2 (
  owner_id TEXT NOT NULL,
  client TEXT NOT NULL CHECK (client IN ('claude-code', 'codex', 'gemini-cli', 'antigravity', 'cursor', 'copilot')),
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, client)
);
INSERT INTO memory_bridge_clients_v2 (owner_id, client, enabled, updated_at)
  SELECT owner_id, client, enabled, updated_at FROM memory_bridge_clients;
DROP TABLE memory_bridge_clients;
ALTER TABLE memory_bridge_clients_v2 RENAME TO memory_bridge_clients;
