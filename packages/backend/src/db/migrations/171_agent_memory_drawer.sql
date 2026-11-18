-- STORE-MAP-01 P5: an agent's own notes (MEMORY.md) move into the database,
-- and agent packages are imported as untrusted data.
--
-- agent_memory_imports: one row per agent once its MEMORY.md was imported
-- into its own drawer (memories.drawer_kind 'agent', drawer_key = the agent
-- id). The file's earlier versions (.memory-versions) become the memory's
-- history, so nothing is imported twice and the old history is kept.
--   memory_id      the agent drawer memory holding the notes
--   file_hash      sha256 of MEMORY.md when it was imported (NULL: no file)
--   versions       history rows taken from .memory-versions
--   written_hash   sha256 of the MEMORY.md Girru last wrote from the drawer;
--                  another hash means it was changed outside Girru (kept,
--                  never overwritten, until the owner decides)
--
-- agent_package_imports: where an imported agent came from (provenance).
--   package_hash   sha256 of the package as read
--   schema_version the package format version
--   refused        JSON list of what the import left out (never permissions,
--                  credentials, hooks or private history)

CREATE TABLE IF NOT EXISTS agent_memory_imports (
  agent_id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  file_hash TEXT,
  versions INTEGER NOT NULL DEFAULT 0,
  written_hash TEXT,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_package_imports (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  package_hash TEXT NOT NULL CHECK (length(package_hash) = 64),
  schema_version INTEGER NOT NULL,
  source_name TEXT,
  refused TEXT NOT NULL DEFAULT '[]',
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_package_imports_hash ON agent_package_imports(package_hash);
