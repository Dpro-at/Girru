-- Scans per user per day, for the daily limit.

CREATE TABLE IF NOT EXISTS app_waf_security__waf_rate_limits (
  user_id TEXT PRIMARY KEY,
  concurrent_scans INTEGER DEFAULT 0,
  last_scan_at DATETIME,
  daily_scan_count INTEGER DEFAULT 0,
  last_reset_date DATE DEFAULT (date('now')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_rate_limits_date ON app_waf_security__waf_rate_limits(last_reset_date);
