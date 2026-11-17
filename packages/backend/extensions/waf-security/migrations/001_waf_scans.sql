-- Scan history: one row per scan of a site (or of this Girru, for a self-audit), per user.

CREATE TABLE IF NOT EXISTS app_waf_security__waf_scans (
  id             TEXT PRIMARY KEY,
  target_url     TEXT NOT NULL,
  scan_type      TEXT NOT NULL DEFAULT 'external',
  waf_detected   INTEGER NOT NULL DEFAULT 0,
  waf_type       TEXT,
  waf_confidence INTEGER NOT NULL DEFAULT 0,
  total_payloads INTEGER NOT NULL DEFAULT 0,
  blocked_count  INTEGER NOT NULL DEFAULT 0,
  passed_count   INTEGER NOT NULL DEFAULT 0,
  bypass_rate    REAL NOT NULL DEFAULT 0,
  risk_level     TEXT,
  results_json   TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  user_id        TEXT
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_scans_created ON app_waf_security__waf_scans(created_at DESC);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_scans_status ON app_waf_security__waf_scans(status);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_scans_user ON app_waf_security__waf_scans(user_id, created_at DESC);
