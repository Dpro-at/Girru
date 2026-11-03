-- STORE-MAP-01 P4 step T7: one personality record per agent.
--
-- An agent's personality text joins its trait versions: each
-- agent_personality_versions row may point (text_hash) at one text in
-- personality_texts, stored once by its sha256 (content-addressed). A version
-- that does not set a text keeps the one of the version before it, so the
-- text and the adjustments share one history. While GIRRU_STORE_P4 is on,
-- PERSONALITY.md is written from the record (a view) and every reader takes
-- the text from here; personality_file_state remembers what Girru wrote, so a
-- change made to the file outside Girru becomes a proposal instead of being
-- used silently.
--
-- personality_proposals gains the text part of a suggestion:
--   base_text_hash / proposed_text_hash  the text before / after (NULL = the
--                                        suggestion leaves the text alone)
--   origin   'file' (PERSONALITY.md changed outside Girru), 'evolution_text'
--            or NULL (a trait drift, as before)

CREATE TABLE IF NOT EXISTS personality_texts (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE agent_personality_versions ADD COLUMN text_hash TEXT;

ALTER TABLE personality_proposals ADD COLUMN base_text_hash TEXT;
ALTER TABLE personality_proposals ADD COLUMN proposed_text_hash TEXT;
ALTER TABLE personality_proposals ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('file', 'evolution_text'));

CREATE TABLE IF NOT EXISTS personality_file_state (
  agent_id TEXT PRIMARY KEY,
  written_hash TEXT NOT NULL,
  written_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE CASCADE
);
