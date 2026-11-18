-- Migration 186: outside projects (REPO-TRUST-01)
--
--   project_trust         one row per project the trust check has seen: outside (1) or trusted (0),
--                         why (auto: the folder's git remote owner is not one of the owner's;
--                         owner: the owner put it on the list or took it off — an owner choice is
--                         kept until he changes it), the remote host and owner it was judged by,
--                         and when. No row = trusted (a project made in Girru, or not checked yet).
--   project_trust_owners  remote owners the owner counts as his own besides the built-in ones
--                         (e.g. a GitHub organisation he works in), per host or any host.
-- Date: 2026-11-04

CREATE TABLE IF NOT EXISTS project_trust (
  owner_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  outside INTEGER NOT NULL DEFAULT 0 CHECK (outside IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('auto', 'owner')),
  remote_host TEXT,
  remote_owner TEXT,
  config_mtime INTEGER,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_trust_outside ON project_trust (owner_id, outside);

CREATE TABLE IF NOT EXISTS project_trust_owners (
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  host TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, name, host)
);
