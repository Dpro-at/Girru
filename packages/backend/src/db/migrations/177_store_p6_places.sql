-- STORE-MAP-01 P6 screens (GIRRU_STORE_P6).
--
-- memory_place_settings (D23, PRIV2): per owner and Memory place ('owner',
--   'people', 'experience', 'tasks', 'company', 'project:<key>'), whether the
--   place stays on this computer (only the local model reads it). A place
--   without a row uses the default: people stays local, every other place
--   does not. Read and written only while P6 is on.
-- task_number_dismissals: a task-number problem in a project's task file that
--   the owner chose to leave as it is (Needs you › Leave); it is not shown
--   again. Nothing in the file or the board changes.
CREATE TABLE IF NOT EXISTS memory_place_settings (
  owner_id TEXT NOT NULL,
  place TEXT NOT NULL,
  stays_local INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, place)
);

CREATE TABLE IF NOT EXISTS task_number_dismissals (
  owner_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES chat_projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_id, item_id)
);
