-- CP17: tasks exchanged with people from other Girru accounts. Only the task text and its answer;
-- the other person never gets this computer's agents, settings, memory, chats or files.
CREATE TABLE IF NOT EXISTS people_tasks (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('out','in')),
  link_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  person_name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('waiting','running','review','done','declined','failed')),
  answer TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  delivered INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, account_id, direction, device_id, id)
);
CREATE INDEX IF NOT EXISTS people_tasks_owner ON people_tasks(user_id, account_id, created_at);
