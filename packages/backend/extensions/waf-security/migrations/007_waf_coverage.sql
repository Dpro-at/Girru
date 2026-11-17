-- Coverage ledger: what was tested, and what came back clean.
--
-- Security tools fail quietly when they only record problems: an empty result reads as "safe"
-- when it may mean "never checked". This ledger records every check that ran against an asset and
-- its outcome, including the negatives (ok / not-tested / error). The UI shows coverage next to an
-- asset so "no issue" is only ever shown together with "and here is what was actually checked".

CREATE TABLE IF NOT EXISTS app_waf_security__coverage (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  asset_id    TEXT,
  scan_id     TEXT,                       -- the run this coverage row belongs to
  check_kind  TEXT NOT NULL,              -- e.g. 'port:443', 'tls', 'header:content-security-policy', 'waf:sql_injection'
  result      TEXT NOT NULL CHECK(result IN ('issue', 'ok', 'not-tested', 'error')),
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_coverage_asset ON app_waf_security__coverage(asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_coverage_scan ON app_waf_security__coverage(scan_id);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_coverage_user ON app_waf_security__coverage(user_id, created_at DESC);
