-- Assets you watch (servers and sites), and the scope gate.
--
-- An asset is a server or a website the owner declares and confirms they own or may test.
-- The set of declared, in-scope assets is the coverage denominator: a check only ever runs
-- against an asset listed here, and the scope log keeps who declared, confirmed or removed it,
-- so "no issue found" is always read against "what was actually in scope".

CREATE TABLE IF NOT EXISTS app_waf_security__assets (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'site' CHECK(kind IN ('server', 'site')),
  label           TEXT NOT NULL,
  host            TEXT NOT NULL,
  port            INTEGER,
  base_url        TEXT,                 -- for sites: the http(s) address tested
  owner_confirmed INTEGER NOT NULL DEFAULT 0,   -- the owner has stated they own / may test it
  is_private      INTEGER NOT NULL DEFAULT 0,   -- resolves to a local/private address (needs the private-target switch)
  in_scope        INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_assets_user ON app_waf_security__assets(user_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_assets_host ON app_waf_security__assets(host);

-- Scope / target gate log: every declaration, ownership confirmation, removal or private-allow,
-- with who decided it. Owner-gated changes are written here so the gate is auditable.
CREATE TABLE IF NOT EXISTS app_waf_security__scope_log (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  asset_id    TEXT,
  action      TEXT NOT NULL CHECK(action IN ('declared', 'confirmed-owned', 'removed', 'private-allowed', 'out-of-scope-refused')),
  decided_by  TEXT NOT NULL,            -- user id of the active owner/admin who decided
  target      TEXT,                     -- the address involved (for refusals: the refused target)
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_scope_log_user ON app_waf_security__scope_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_scope_log_asset ON app_waf_security__scope_log(asset_id);
