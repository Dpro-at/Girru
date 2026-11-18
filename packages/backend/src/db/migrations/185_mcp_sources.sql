-- Migration 185: one MCP place (MCP-ONE-01)
--
--   mcp_server_sources  where a registry server was found: the app (origin: Claude, Codex,
--                       Gemini, Antigravity, Store app, This computer, Girru), its config file
--                       and the entry key inside it (plus the project for per-project
--                       entries, and the Store app id when an app brought it). Several rows
--                       per server when the same command or address is in several apps.
--                       The config file is never changed; only where it is is kept here.
--   mcp_found_hidden    servers found in another app that the owner chose "Don't show again"
--                       for, by their launch key (sha-256 of the command and arguments, or of
--                       the address). Nothing secret is stored.
-- Date: 2026-11-04

CREATE TABLE IF NOT EXISTS mcp_server_sources (
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  file TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  app_id TEXT,
  seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (server_id, file, entry_key, project)
);

CREATE INDEX IF NOT EXISTS idx_mcp_server_sources_server ON mcp_server_sources (server_id);

CREATE TABLE IF NOT EXISTS mcp_found_hidden (
  launch_key TEXT PRIMARY KEY,
  hidden_at TEXT NOT NULL DEFAULT (datetime('now'))
);
