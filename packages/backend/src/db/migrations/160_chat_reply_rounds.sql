-- Durable, bounded participation in an ordinary saved conversation.
CREATE TABLE IF NOT EXISTS chat_reply_rounds (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  participants TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active',
  active_run_id TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_reply_round_one_active
  ON chat_reply_rounds(session_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS chat_reply_round_owner ON chat_reply_rounds(owner_id, session_id);
