-- STORE-MAP-01 P3 step 1 (expand): ONE list of departments for agents AND
-- projects (decision D8).
--
-- Today three lists exist: memory_departments (project drawers, by id), the
-- agents' free-text agents_config.department, and names copied into boards,
-- rules, specialties, hire batches and meeting decisions. This step only adds:
--
--   departments          the one list. Rows copied from memory_departments keep
--                        their id, so memory_project_scopes.department_id stays
--                        valid. norm_name is the lower-case key the text columns
--                        below already hold; it stays in step with name.
--   department_merges    one row per merge, so a merge can be undone.
--   department_questions what the upgrade could not decide by itself (a rule that
--                        names a department nobody uses), asked once (D9).
--   *.department_id      the id next to every copied name (filled by the
--                        background backfill while GIRRU_STORE_P3 is on).
--
-- Nothing reads the new columns until the switch is on; nothing is dropped.

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  letter TEXT,
  color TEXT,
  lead_agent_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, norm_name)
);

CREATE TABLE IF NOT EXISTS department_merges (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  into_id TEXT NOT NULL,
  from_row TEXT NOT NULL,
  moved TEXT NOT NULL,
  undone_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_department_merges_owner ON department_merges (owner_id, created_at);

CREATE TABLE IF NOT EXISTS department_questions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  name TEXT NOT NULL,
  answer TEXT,
  answered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, kind, subject_id, name)
);

ALTER TABLE agents_config ADD COLUMN department_id TEXT;
ALTER TABLE board_departments ADD COLUMN department_id TEXT;
ALTER TABLE board_card_departments ADD COLUMN department_id TEXT;
ALTER TABLE board_department_sources ADD COLUMN department_id TEXT;
ALTER TABLE specialty_templates ADD COLUMN department_id TEXT;
ALTER TABLE team_hire_batch_items ADD COLUMN department_id TEXT;
ALTER TABLE meeting_decisions ADD COLUMN department_id TEXT;
ALTER TABLE agent_rules ADD COLUMN department_ids TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_config_department_id ON agents_config (department_id);
CREATE INDEX IF NOT EXISTS idx_board_departments_department_id ON board_departments (department_id);
