-- STORE-MAP-01 P7 (GIRRU_STORE_P7), SEC2-3: tasks from .girru/tasks.md are untrusted.
--
-- task_file_cards.from_file: 1 = the task's text came from the file (a new
--   task written there, or a block changed there by someone other than
--   Girru); 0 = Girru made it (a card from a project chat) and the file has
--   not changed it since. Rows from before this migration count as from the
--   file.
-- task_file_approvals: the owner allowed tasks from this project's file to
--   run tools (once per project). Without it, a task from the file may be
--   planned, but every tool that changes something asks the owner first and a
--   scheduled run does not start. Read only while P7 is on.
ALTER TABLE task_file_cards ADD COLUMN from_file INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS task_file_approvals (
  project_id TEXT NOT NULL PRIMARY KEY REFERENCES chat_projects(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT (datetime('now'))
);
