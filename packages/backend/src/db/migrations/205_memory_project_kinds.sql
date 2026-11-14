-- MEM-READ-01 MR3: library folders are never projects.
-- kind = 'library': a project found in downloaded code (the Go module folder, node_modules, vendor, …);
--   it is listed under "Not projects", hidden from the Memory sidebar and never loaded into a reply.
-- kind = 'project': the owner said "It's a project"; automatic detection never changes it again.
CREATE TABLE IF NOT EXISTS memory_project_kinds (
  owner_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('library','project')),
  reason TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, slug)
);
CREATE INDEX IF NOT EXISTS memory_project_kinds_kind ON memory_project_kinds(owner_id, kind);
