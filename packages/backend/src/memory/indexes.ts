/**
 * STORE-MAP-01 P9 (D9): indexes for the hot memory queries.
 *
 * Every drawer filter reads a row's drawer through the COALESCE expressions
 * of drawers.ts (an old row without a drawer has a default one), so the plain
 * index on (user_id, drawer_kind, drawer_key) is never used and a project's
 * drawer list or a recall scans the whole table. These expression indexes use
 * the very same expressions, so the planner can use them on both drivers
 * without any change to the queries or to what they return. Migration 179
 * (SQLite) and its PostgreSQL twin create them; this list is the same text,
 * used by the EXPLAIN script.
 */

import { DRAWER_KEY_SQL, DRAWER_KIND_SQL } from './drawers.js';

export const P9_MEMORY_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_memories_drawer_expr ON memories (user_id, ${DRAWER_KIND_SQL}, ${DRAWER_KEY_SQL}, created_at)`,
];
