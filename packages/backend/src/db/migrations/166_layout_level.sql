-- STORE-MAP-01 P3 step 3 (OPS2): which Girru last opened this data.
--
-- One row. `level` is the highest migration this data has; `written_by` the
-- Girru version that wrote it. An older Girru that finds migrations it does
-- not know (or a higher level) opens nothing and writes nothing while
-- GIRRU_STORE_P3 is on; its start-up page says which version is needed.

CREATE TABLE IF NOT EXISTS schema_layout (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  level TEXT NOT NULL,
  written_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
