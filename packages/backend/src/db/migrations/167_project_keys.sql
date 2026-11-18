-- STORE-MAP-01 P3 step 4 (D3, FD1): memory keeps projects by id.
--
-- Project memory used the project's slug as its key, so deleting a project
-- left its memory behind and a new project with the same name silently took
-- it over. While GIRRU_STORE_P3 is on, start-up rewrites every project key
-- (memories, versions, scopes, pinned facts, rules, groups, design, databases,
-- links, proposals, the change log) from the slug to the chat project's id;
-- a project key with no chat project becomes a real project first. Turning
-- the switch off rewrites them back.
--
--   memory_project_keys   one row per project the move touched: its slug,
--                         its id and where it came from (chat_project | memory_only)
--   memory_key_state      per owner: what the keys are now ('slug' or 'id')

CREATE TABLE IF NOT EXISTS memory_project_keys (
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  project_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_memory_project_keys_project ON memory_project_keys (owner_id, project_id);

CREATE TABLE IF NOT EXISTS memory_key_state (
  owner_id TEXT PRIMARY KEY,
  keyed_by TEXT NOT NULL,
  moved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
