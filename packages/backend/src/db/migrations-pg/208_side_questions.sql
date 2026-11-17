-- PostgreSQL translation of src/db/migrations/208_side_questions.sql
-- AGENT-BTW-01: side-question channel (/btw). PostgreSQL parity of the SQLite
-- migration. Kept in step with it by hand; see that file for the design notes.
-- jsonb candidates (kept as text): side_question_requests.status

-- history_local: locality the stored history was produced under (1 local, 0
-- cloud, NULL none). See the SQLite migration for the P9 privacy rationale.
CREATE TABLE IF NOT EXISTS side_question_sessions (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users (id),
  parent_session_id text NOT NULL,
  summary text NOT NULL DEFAULT '',
  summarized_through bigint NOT NULL DEFAULT 0,
  history_local bigint,
  created_at text NOT NULL DEFAULT (to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at text NOT NULL DEFAULT (to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE (owner_id, parent_session_id)
);

CREATE TABLE IF NOT EXISTS side_question_requests (
  id text PRIMARY KEY,
  side_session_id text NOT NULL REFERENCES side_question_sessions (id),
  owner_id text NOT NULL REFERENCES users (id),
  question text NOT NULL,
  answer text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('running','done','interrupted','cancelled','error')),
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  source_local bigint NOT NULL DEFAULT 1,
  -- Strictly increasing insertion order within a side session; see SQLite file.
  ord bigint NOT NULL DEFAULT 0,
  error text,
  created_at text NOT NULL DEFAULT (to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')),
  updated_at text NOT NULL DEFAULT (to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS side_question_requests_session
  ON side_question_requests (side_session_id, ord);
CREATE INDEX IF NOT EXISTS side_question_requests_owner_status
  ON side_question_requests (owner_id, status);
