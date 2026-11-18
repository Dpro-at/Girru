-- AGENT-BTW-01: side-question channel (/btw).
-- A side question is answered off an immutable snapshot of a main agent's
-- context, by an independent service with its own history and token budget.
-- It never writes into the main chat transcript or run tables. Only the
-- side-question history lives here; the context snapshot itself is in-memory
-- (captured at submission time) and is never persisted.

-- One side-question session per parent chat/task session (owner-scoped).
-- `summary` is the rolling summary of older Q&A folded out of the verbatim
-- recent window; `summarized_through` is how many of the oldest done requests
-- have already been folded into it.
-- `history_local` is the locality the stored history (summary + Q&A) was
-- produced under: 1 = a local model, 0 = a cloud/paid model, NULL = no history
-- yet. Local-only "stays on this computer" memory must never ride a cloud
-- request, so when a request's provider locality differs from this the history
-- is cleared before the request runs (service.ts, P9 policy).
CREATE TABLE IF NOT EXISTS side_question_sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  parent_session_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  summarized_through INTEGER NOT NULL DEFAULT 0,
  history_local INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_id, parent_session_id)
);

-- One row per /btw question. `answer` keeps the cumulative (possibly partial)
-- answer. A leftover `running` row becomes `interrupted` on restart with its
-- partial answer kept. `cancelled` = the user pressed stop.
CREATE TABLE IF NOT EXISTS side_question_requests (
  id TEXT PRIMARY KEY,
  side_session_id TEXT NOT NULL REFERENCES side_question_sessions(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('running','done','interrupted','cancelled','error')),
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  -- 1 = answered by a local model, 0 = a cloud/paid model. Used to keep
  -- local-sourced Q&A out of a later cloud request.
  source_local INTEGER NOT NULL DEFAULT 1,
  -- Strictly increasing insertion order within a side session. created_at is
  -- only second-granular and id is a random UUID, so ordering by them is not
  -- insertion order for rapid questions; `ord` gives the recent/older slices a
  -- deterministic order (assigned per session at insert time).
  ord INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS side_question_requests_session
  ON side_question_requests(side_session_id, ord);
CREATE INDEX IF NOT EXISTS side_question_requests_owner_status
  ON side_question_requests(owner_id, status);
