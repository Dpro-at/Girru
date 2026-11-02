-- STORE-MAP-01 pilot: change log (outbox), projection state and session
-- capabilities for ONE opted-in project (GIRRU_STORE_PILOT).
--
-- change_scopes lists the drawers that keep a change log. Empty by default,
-- so the triggers below write nothing until a project is opted in.
-- Every write to memories or memory_versions in an opted-in project drawer
-- adds a change event in the SAME transaction, whichever code path wrote it
-- (the filter is in the trigger body: PostgreSQL forbids subqueries in WHEN).
--
-- Three numbers stay distinct:
--   record_version      memory_versions.version of the memory (version events)
--   seq                 the change event's place in the log
--   projection_version  how many times a consumer rendered its projection
-- A consumer's watermark is the last seq it has rendered. Events are removed
-- only after every consumer of the scope has passed them, never by age.

CREATE TABLE IF NOT EXISTS change_scopes (
  scope TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS change_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete', 'version')),
  record_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_change_events_scope_seq ON change_events(scope, seq);

CREATE TABLE IF NOT EXISTS projection_state (
  consumer TEXT NOT NULL,
  scope TEXT NOT NULL,
  target TEXT,
  watermark INTEGER NOT NULL DEFAULT 0,
  projection_version INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('up_to_date', 'waiting', 'conflict', 'unreachable', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (consumer, scope)
);

CREATE TABLE IF NOT EXISTS session_capabilities (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'member')),
  project_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  client TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_capabilities_project ON session_capabilities(owner_id, project_id);

CREATE TRIGGER IF NOT EXISTS trg_memories_change_insert
AFTER INSERT ON memories
BEGIN
  INSERT INTO change_events (scope, user_id, entity, entity_id, op)
    SELECT s.scope, NEW.user_id, 'memory', NEW.id, 'insert' FROM change_scopes s
     WHERE s.enabled = 1 AND s.owner_id = NEW.user_id AND NEW.drawer_kind = 'project' AND s.scope = 'project:' || NEW.drawer_key;
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_change_update
AFTER UPDATE OF user_id, type, content, status, metadata, importance_score, tags, memory_layer, expiry_timestamp, drawer_kind, drawer_key, topic_key ON memories
BEGIN
  INSERT INTO change_events (scope, user_id, entity, entity_id, op)
    SELECT s.scope, OLD.user_id, 'memory', OLD.id, 'update' FROM change_scopes s
     WHERE s.enabled = 1 AND s.owner_id = OLD.user_id AND OLD.drawer_kind = 'project' AND s.scope = 'project:' || OLD.drawer_key;
  INSERT INTO change_events (scope, user_id, entity, entity_id, op)
    SELECT s.scope, NEW.user_id, 'memory', NEW.id, 'update' FROM change_scopes s
     WHERE s.enabled = 1 AND s.owner_id = NEW.user_id AND NEW.drawer_kind = 'project' AND s.scope = 'project:' || NEW.drawer_key
       AND NOT (OLD.user_id = NEW.user_id AND OLD.drawer_kind IS NOT DISTINCT FROM NEW.drawer_kind AND OLD.drawer_key IS NOT DISTINCT FROM NEW.drawer_key);
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_change_delete
AFTER DELETE ON memories
BEGIN
  INSERT INTO change_events (scope, user_id, entity, entity_id, op)
    SELECT s.scope, OLD.user_id, 'memory', OLD.id, 'delete' FROM change_scopes s
     WHERE s.enabled = 1 AND s.owner_id = OLD.user_id AND OLD.drawer_kind = 'project' AND s.scope = 'project:' || OLD.drawer_key;
END;

CREATE TRIGGER IF NOT EXISTS trg_memory_versions_change
AFTER INSERT ON memory_versions
BEGIN
  INSERT INTO change_events (scope, user_id, entity, entity_id, op, record_version)
    SELECT s.scope, NEW.user_id, 'memory', NEW.memory_id, 'version', NEW.version FROM change_scopes s
     WHERE s.enabled = 1 AND s.owner_id = NEW.user_id AND NEW.drawer_kind = 'project' AND s.scope = 'project:' || NEW.drawer_key;
END;
