-- RUNS-01: what the Runs section needs to say when a run ended, who started it and why it stopped.
ALTER TABLE chat_run_journal ADD COLUMN ended_at INTEGER;
ALTER TABLE chat_run_journal ADD COLUMN error_code TEXT;
ALTER TABLE job_executions ADD COLUMN started_by TEXT;
ALTER TABLE chat_schedules ADD COLUMN last_result TEXT;
ALTER TABLE chat_schedules ADD COLUMN last_reason TEXT;
ALTER TABLE chat_schedules ADD COLUMN last_run_id TEXT;
ALTER TABLE card_schedules ADD COLUMN last_reason TEXT;
ALTER TABLE card_schedules ADD COLUMN last_run_id TEXT;
CREATE INDEX IF NOT EXISTS idx_chat_run_journal_user_started ON chat_run_journal(user_id, started_at);
CREATE INDEX IF NOT EXISTS idx_job_executions_executed ON job_executions(executed_at);
-- Coding-app work (Claude Code, Codex, Gemini) handed over from a chat: kept after it ends, not only while it runs.
CREATE TABLE IF NOT EXISTS coding_app_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT,
  agent_id TEXT,
  app TEXT NOT NULL,
  about TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running',
  error_code TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  parent_run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_coding_app_runs_user_started ON coding_app_runs(user_id, started_at);
-- Sub-tasks (board RN6): the chat run an agent was in when it handed work over, asked a coding app or a small helper.
ALTER TABLE task_runs ADD COLUMN parent_run_id TEXT;
ALTER TABLE team_delegation_results ADD COLUMN parent_run_id TEXT;
ALTER TABLE team_delegation_results ADD COLUMN ended_at TEXT;
CREATE INDEX IF NOT EXISTS idx_coding_app_runs_parent ON coding_app_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_parent ON task_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_team_results_parent ON team_delegation_results(parent_run_id);
-- "Schedule a task" (board RN6): how a repeating task runs and tells the owner.
ALTER TABLE card_schedules ADD COLUMN notify TEXT NOT NULL DEFAULT 'important';
ALTER TABLE card_schedules ADD COLUMN new_chat INTEGER NOT NULL DEFAULT 1;
ALTER TABLE card_schedules ADD COLUMN thinking TEXT;
ALTER TABLE card_schedules ADD COLUMN project_id TEXT;
