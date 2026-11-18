-- STORE-MAP-01 P9b (MD1, MD3, MD7, MD8): the memory quality engine (GIRRU_STORE_P9B).
--
--   memory_trust          one row per memory written while P9b is on: where it
--                         came from (write source), its confidence and whether
--                         it is verified (owner-stated, owner-approved or
--                         confirmed by two trusted sources), the weight it
--                         earned from use (MD7: verified facts only gain),
--                         flags (JSON list, e.g. corrected-after-use) and the
--                         background enrichment state. content_hash ties the
--                         row to the text it judged: after an edit the row no
--                         longer counts until it is written again.
--   memory_trust_sources  the distinct sources that stated the same text
--                         (corroboration, MD3). Ids and source labels only.
--   memory_open_questions MD8: a question the agent asked the owner because
--                         no reliable memory existed, so it is asked once; the
--                         answer saved later resolves it. Redacted, at most
--                         300 characters; expired after 14 days.
-- Ids, numbers and labels only, except the redacted question text.
CREATE TABLE IF NOT EXISTS memory_trust (
  memory_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  confidence REAL NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  use_weight REAL NOT NULL DEFAULT 0,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  flags TEXT,
  enrich_state TEXT NOT NULL DEFAULT 'pending' CHECK (enrich_state IN ('pending', 'ready', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_trust_user ON memory_trust (user_id, enrich_state);

CREATE TABLE IF NOT EXISTS memory_trust_sources (
  memory_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'approved', 'chat', 'agent', 'tool', 'import', 'channel', 'system')),
  content_hash TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (memory_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_memory_trust_sources_user ON memory_trust_sources (user_id, memory_id);

CREATE TABLE IF NOT EXISTS memory_open_questions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  agent_id TEXT,
  question_hash TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'expired')),
  resolved_memory_id TEXT,
  asked_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_open_questions_user ON memory_open_questions (user_id, status, question_hash);
