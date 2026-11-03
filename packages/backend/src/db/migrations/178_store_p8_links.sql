-- STORE-MAP-01 P8 task links (GIRRU_STORE_P8).
--
-- agent_handoffs gains what a handoff is about and what stops it (D25, D28):
--   blockers        JSON list of what blocks the work (the owner may edit it)
--   files_touched   JSON list of the files the work changed (read only)
--   card_id         the board card (task) it belongs to, or NULL
--   task_no         the task's number in the project's task file ("T-12"), or NULL
--   conversation_id the chat it was written in, or NULL
--   from_agent_id   a mid-task handoff between agents (D26): the lead who handed
--                   the work to this agent, or NULL
-- Written and read only while P8 is on; old rows keep the defaults.
--
-- run_notes (D27): a run's short working notes. They stay with the run, never
-- become memory by themselves, are read only for the owner and are cleared 14
-- days after the run's last note. At the run's end they become its handoff
-- (when the agent wrote none) and lesson suggestions the owner reviews.
ALTER TABLE agent_handoffs ADD COLUMN blockers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_handoffs ADD COLUMN files_touched TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_handoffs ADD COLUMN card_id TEXT;
ALTER TABLE agent_handoffs ADD COLUMN task_no TEXT;
ALTER TABLE agent_handoffs ADD COLUMN conversation_id TEXT;
ALTER TABLE agent_handoffs ADD COLUMN from_agent_id TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_handoffs_card ON agent_handoffs(owner_id, card_id, created_at);

CREATE TABLE IF NOT EXISTS run_notes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('chat', 'task', 'delegation')),
  agent_id TEXT NOT NULL,
  card_id TEXT,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (run_kind, run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_run_notes_owner ON run_notes(owner_id, created_at);
