-- Durable owner-scoped meetings and reviewed actions.
CREATE TABLE IF NOT EXISTS meetings (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 conversation_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(id) ON DELETE CASCADE,
 request_hash TEXT NOT NULL,
 title TEXT NOT NULL,
 objective TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'active',
 version INTEGER NOT NULL DEFAULT 1,
 selection TEXT NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0,
 active_run_id TEXT,
 summary TEXT NOT NULL DEFAULT '',
 review_run_id TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meetings_owner ON meetings(owner_id,
 updated_at);
CREATE TABLE IF NOT EXISTS meeting_participants (
 meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES agents_config(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,
 PRIMARY KEY(meeting_id,
 agent_id),
 UNIQUE(meeting_id,
 position)
);
CREATE TABLE IF NOT EXISTS meeting_turns (
 meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 run_id TEXT NOT NULL UNIQUE,
 agent_id TEXT,
 kind TEXT NOT NULL DEFAULT 'discussion',
 status TEXT NOT NULL DEFAULT 'starting',
 PRIMARY KEY(meeting_id,
 request_id)
);
CREATE TABLE IF NOT EXISTS meeting_decisions (
 id TEXT PRIMARY KEY,
 meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 agent_id TEXT,
 department TEXT,
 due_date TEXT,
 enabled INTEGER NOT NULL DEFAULT 1,
 board_id TEXT,
 card_id TEXT,
 position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_decisions ON meeting_decisions(meeting_id,
 position);
