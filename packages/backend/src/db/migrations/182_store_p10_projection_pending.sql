-- STORE-MAP-01 P10: crash recovery for the brief-file projection.
--
--   projection_state.pending_hash  the hash of the file Girru is about to
--                                  write, recorded before the write and
--                                  cleared with the state update after it.
--                                  A crash between the two leaves a file
--                                  with this hash: the next run knows it is
--                                  Girru's own write, not an outside edit.
ALTER TABLE projection_state ADD COLUMN pending_hash TEXT;

-- A project renamed in Girru is a change of every file that names it (the
-- brief's title): the change log records it like a memory change, so the
-- brief file follows on the next sync (P10, "a rename reaches every file").
CREATE TRIGGER IF NOT EXISTS trg_chat_projects_change_rename
AFTER UPDATE OF name ON chat_projects
BEGIN
  INSERT INTO change_events (scope, user_id, entity, entity_id, op)
    SELECT s.scope, s.owner_id, 'project', NEW.id, 'update' FROM change_scopes s
     WHERE s.enabled = 1 AND s.project_id = NEW.id AND OLD.name IS DISTINCT FROM NEW.name;
END;
