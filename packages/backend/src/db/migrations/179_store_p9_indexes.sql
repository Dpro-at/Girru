-- STORE-MAP-01 P9 (D9): an index for the drawer filter of the hot memory queries.
--
-- Every drawer filter (recall, a project's drawer list, drawer counts, the
-- current fact of a topic) reads a row's drawer through the same COALESCE
-- expressions (memory/drawers.ts DRAWER_KIND_SQL / DRAWER_KEY_SQL), so the
-- plain idx_memories_drawer was never used and each of them scanned the whole
-- table. This index has the very same expressions, so the planner uses it on
-- both drivers with no change to any query or to what it returns
-- (scripts/memory-baseline/explain.mjs shows the plans).
CREATE INDEX IF NOT EXISTS idx_memories_drawer_expr ON memories (
  user_id,
  COALESCE(drawer_kind, CASE WHEN type IN ('skill', 'insight') THEN 'experience' ELSE 'owner' END),
  COALESCE(drawer_key, ''),
  created_at
);
