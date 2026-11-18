-- STORE-MAP-01 P3 step 2 (expand): where a memory came from, how far to trust
-- it, and whether it is still true (FD3, D11).
--
--   source         who wrote it: owner, agent, coding_app, import, channel, system
--   source_ref     which one: the agent id, the coding app, the file name, the channel
--   trust          checked (the owner wrote or checked it), unchecked (an agent),
--                  imported (data only until the owner checks it)
--   valid_from     since when the current text is true
--   valid_to       when it stopped being true (a newer fact replaced it)
--   superseded_by  the memory that replaced it; the old row keeps status 'replaced'
--
-- A replaced memory keeps its topic key, so the topic index now covers only
-- rows that are not replaced (a weaker rule than before: nothing that was
-- allowed becomes refused). The backfill fills source, trust and valid_from
-- for existing rows while GIRRU_STORE_P3 is on.

ALTER TABLE memories ADD COLUMN source TEXT;
ALTER TABLE memories ADD COLUMN source_ref TEXT;
ALTER TABLE memories ADD COLUMN trust TEXT;
ALTER TABLE memories ADD COLUMN valid_from TEXT;
ALTER TABLE memories ADD COLUMN valid_to TEXT;
ALTER TABLE memories ADD COLUMN superseded_by TEXT;

DROP INDEX IF EXISTS idx_memories_topic_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_topic_current
  ON memories(user_id, drawer_kind, drawer_key, topic_key) WHERE topic_key IS NOT NULL AND COALESCE(status, 'active') <> 'replaced';
CREATE INDEX IF NOT EXISTS idx_memories_superseded_by ON memories(superseded_by) WHERE superseded_by IS NOT NULL;
