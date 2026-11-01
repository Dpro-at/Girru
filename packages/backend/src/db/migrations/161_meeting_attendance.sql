-- Attendance can change without erasing invitations, turns or decisions.
ALTER TABLE meeting_participants ADD COLUMN attending INTEGER NOT NULL DEFAULT 1;
ALTER TABLE meetings ADD COLUMN coordinator_agent_id TEXT REFERENCES agents_config(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS meeting_attendance_changes (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_digest TEXT NOT NULL,
  joined INTEGER NOT NULL,
  left_count INTEGER NOT NULL,
  present INTEGER NOT NULL,
  result_version INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS meeting_attendance_history ON meeting_attendance_changes(meeting_id, created_at);
