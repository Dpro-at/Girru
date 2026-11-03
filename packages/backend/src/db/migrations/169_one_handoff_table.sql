-- STORE-MAP-01 P4 step D7: one handoff table.
--
-- agent_handoffs now also holds the notes coding apps write for a project
-- (scope_kind 'project', source 'coding_app', `client` = which app; agent_id
-- is 'app:<client>'). The table is rebuilt because SQLite cannot change a
-- CHECK; every row, index and trigger is kept. While GIRRU_STORE_P4 is on,
-- coding-app notes are written to both tables and read from this one;
-- memory_bridge_handoffs is dropped one release later.

CREATE TABLE agent_handoffs_v2 (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('conversation', 'task', 'project')),
  scope_id TEXT NOT NULL,
  project_id TEXT,
  version INTEGER NOT NULL,
  done TEXT NOT NULL DEFAULT '[]',
  remaining TEXT NOT NULL DEFAULT '[]',
  next_steps TEXT NOT NULL DEFAULT '[]',
  open_questions TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL CHECK (source IN ('agent', 'model', 'fallback', 'owner', 'coding_app')),
  run_id TEXT,
  client TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, agent_id, scope_kind, scope_id, version)
);
INSERT INTO agent_handoffs_v2 (id, owner_id, agent_id, scope_kind, scope_id, project_id, version, done, remaining, next_steps, open_questions, source, run_id, created_at)
  SELECT id, owner_id, agent_id, scope_kind, scope_id, project_id, version, done, remaining, next_steps, open_questions, source, run_id, created_at FROM agent_handoffs;
DROP TABLE agent_handoffs;
ALTER TABLE agent_handoffs_v2 RENAME TO agent_handoffs;

CREATE INDEX IF NOT EXISTS idx_agent_handoffs_project ON agent_handoffs(owner_id, agent_id, project_id);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_run ON agent_handoffs(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_app ON agent_handoffs(owner_id, project_id, created_at) WHERE scope_kind = 'project';

CREATE TRIGGER IF NOT EXISTS trg_handoffs_cache_rev_insert
AFTER INSERT ON agent_handoffs
BEGIN
  INSERT INTO memory_cache_revisions (user_id, scope, revision) VALUES (NEW.owner_id, 'handoff', 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_handoffs_cache_rev_delete
AFTER DELETE ON agent_handoffs
BEGIN
  INSERT INTO memory_cache_revisions (user_id, scope, revision) VALUES (OLD.owner_id, 'handoff', 1)
    ON CONFLICT (user_id, scope) DO UPDATE SET revision = memory_cache_revisions.revision + 1;
END;
