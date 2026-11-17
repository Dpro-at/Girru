-- Findings, their evidence, and the retest/verdict loop.
--
-- A finding is informational: what was seen, where, how serious, and a fix hint. It is never an
-- exploit and never an action against the target. Every finding is backed by evidence that is
-- stored by its own content hash (sha256 of the exact bytes), so the evidence a finding points to
-- cannot be silently changed; a read checks the hash. Each piece of evidence carries a role
-- (baseline / proof / supporting / verification) so the reasoning behind a finding is auditable.

-- Content-addressed evidence store. `sha256` is computed from `body`; readers re-check it.
CREATE TABLE IF NOT EXISTS app_waf_security__evidence (
  id          TEXT PRIMARY KEY,
  sha256      TEXT NOT NULL,                 -- hex sha256 of body; identity + tamper check
  kind        TEXT NOT NULL CHECK(kind IN ('request', 'response', 'banner', 'cert', 'header-set', 'port-list', 'note')),
  body        TEXT NOT NULL,                 -- the exact captured text (request line+headers, response head, banner, cert summary...)
  meta_json   TEXT,                          -- small structured context (status, host, port, timing)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_evidence_sha ON app_waf_security__evidence(sha256);

CREATE TABLE IF NOT EXISTS app_waf_security__findings (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  asset_id        TEXT,
  scan_id         TEXT,                       -- the scan/check run that first raised it (nullable)
  category        TEXT NOT NULL,              -- 'open-port' | 'tls' | 'security-header' | 'cors' | 'waf-bypass' | 'cve-hint' | 'self-audit'
  title           TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'low' CHECK(severity IN ('info', 'low', 'medium', 'high', 'critical')),
  summary         TEXT,
  fix_hint        TEXT,
  where_url       TEXT,                       -- the exact place (url/host:port) the finding is about
  dedup_key       TEXT NOT NULL,              -- program-owned identity: (asset,category,where,signature); de-dupes re-runs
  status          TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'reproduced', 'fixed', 'inconclusive', 'ignored')),
  verdict_note    TEXT,
  is_informational INTEGER NOT NULL DEFAULT 1,
  first_seen_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One open finding per identity: re-running a scan updates last_seen_at instead of piling up rows.
CREATE UNIQUE INDEX IF NOT EXISTS app_waf_security__idx_findings_dedup ON app_waf_security__findings(user_id, dedup_key);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_findings_user ON app_waf_security__findings(user_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_findings_asset ON app_waf_security__findings(asset_id);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_findings_status ON app_waf_security__findings(user_id, status);

-- Role-tagged binding of evidence to a finding (an evidence row can back more than one finding).
CREATE TABLE IF NOT EXISTS app_waf_security__finding_evidence (
  finding_id  TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  role        TEXT NOT NULL CHECK(role IN ('baseline', 'proof', 'supporting', 'verification')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (finding_id, evidence_id),
  FOREIGN KEY (finding_id) REFERENCES app_waf_security__findings(id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES app_waf_security__evidence(id)
);

-- Retest / verdict loop. Re-running a finding records reproduced / fixed / inconclusive, with an
-- "argue the opposite" note: what would have to be true for the opposite verdict, checked before
-- the verdict is accepted. Original evidence is always kept; a retest adds verification evidence.
CREATE TABLE IF NOT EXISTS app_waf_security__finding_retests (
  id             TEXT PRIMARY KEY,
  finding_id     TEXT NOT NULL,
  verdict        TEXT NOT NULL CHECK(verdict IN ('reproduced', 'fixed', 'inconclusive')),
  opposite_check TEXT,                        -- the "argue the opposite" reasoning recorded for the verdict
  evidence_id    TEXT,                        -- verification evidence captured by the retest (nullable)
  decided_by     TEXT NOT NULL,               -- 'engine' or a user id
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (finding_id) REFERENCES app_waf_security__findings(id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_id) REFERENCES app_waf_security__evidence(id)
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_retests_finding ON app_waf_security__finding_retests(finding_id, created_at DESC);
