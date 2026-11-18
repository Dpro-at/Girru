-- Migration 184: document memory (KNOW-INDEX-01; GIRRU_DOC_INDEX)
--
--   doc_index_sources  one folder set whose documents are indexed: a project's folders
--                      (kind project, ref_id = chat_projects.id; only when the owner turns
--                      it on) or an agent's knowledge folder (kind agent, ref_id = agent id).
--                      state / counts / scanned_at are the index status; revision goes up
--                      on every change of its chunks (recall reloads on a new revision).
--   doc_index_files    one indexed file of a source: path under its root, sha-256 of the
--                      bytes, revision (+1 per changed content), size and mtime for the quick
--                      "unchanged" check, status ok | unreadable (+ a reason code, e.g. a PDF
--                      that is a scan). The file itself stays where it is.
--   doc_index_chunks   the searchable pieces of a file: page (PDF) or heading (Markdown),
--                      redacted text, lexical tokens, the vector and its model, the file
--                      hash and revision it came from. scope_kind/scope_key say which
--                      recall may read it: a project id or an agent id.
-- Date: 2026-11-04

CREATE TABLE IF NOT EXISTS doc_index_sources (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'agent')),
  ref_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'ready', 'error')),
  revision INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  unreadable INTEGER NOT NULL DEFAULT 0,
  limited INTEGER NOT NULL DEFAULT 0 CHECK (limited IN (0, 1)),
  note TEXT,
  scanned_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_id, kind, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_doc_index_sources_owner ON doc_index_sources (owner_id, enabled);

CREATE TABLE IF NOT EXISTS doc_index_files (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  root TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  display_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  bytes INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'unreadable')),
  reason TEXT,
  pages INTEGER,
  chunks INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL,
  UNIQUE (source_id, root, rel_path)
);

CREATE INDEX IF NOT EXISTS idx_doc_index_files_source ON doc_index_files (source_id);

CREATE TABLE IF NOT EXISTS doc_index_chunks (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('project', 'agent')),
  scope_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  page INTEGER,
  heading TEXT,
  content TEXT NOT NULL,
  lex TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  embedding_model TEXT,
  embedding_vec BLOB,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_doc_index_chunks_scope ON doc_index_chunks (owner_id, scope_kind, scope_key);
CREATE INDEX IF NOT EXISTS idx_doc_index_chunks_file ON doc_index_chunks (file_id);
CREATE INDEX IF NOT EXISTS idx_doc_index_chunks_source ON doc_index_chunks (source_id);
