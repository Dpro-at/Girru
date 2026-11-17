-- Campaigns: a site tested in four stages, now or on a schedule, with each run compared to the one before.

CREATE TABLE IF NOT EXISTS app_waf_security__waf_campaigns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  target_domain TEXT NOT NULL,
  status TEXT DEFAULT 'idle' CHECK(status IN ('idle', 'running', 'completed', 'failed', 'scheduled')),
  schedule_enabled BOOLEAN DEFAULT 0,
  schedule_frequency TEXT CHECK(schedule_frequency IN ('daily', 'weekly', 'monthly', 'custom')),
  schedule_time TEXT,
  schedule_day_of_week INTEGER,
  schedule_day_of_month INTEGER,
  schedule_next_run DATETIME,
  schedule_last_run DATETIME,
  total_runs INTEGER DEFAULT 0,
  successful_runs INTEGER DEFAULT 0,
  failed_runs INTEGER DEFAULT 0,
  avg_security_score REAL DEFAULT 0.0,
  last_security_score REAL DEFAULT 0.0,
  baseline_security_score REAL DEFAULT 0.0,
  scan_mode TEXT DEFAULT 'full' CHECK(scan_mode IN ('quick', 'full')),
  categories TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_run_at DATETIME
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_campaigns_user ON app_waf_security__waf_campaigns(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_campaigns_status ON app_waf_security__waf_campaigns(status);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_campaigns_next_run ON app_waf_security__waf_campaigns(schedule_enabled, schedule_next_run);

CREATE TABLE IF NOT EXISTS app_waf_security__waf_campaign_scans (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  scan_id TEXT NOT NULL,
  run_number INTEGER NOT NULL,
  stage INTEGER DEFAULT 1 CHECK(stage IN (1, 2, 3, 4)),
  stage_name TEXT,
  stage_status TEXT DEFAULT 'pending' CHECK(stage_status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
  security_score REAL DEFAULT 0.0,
  vulnerabilities_found INTEGER DEFAULT 0,
  critical_issues INTEGER DEFAULT 0,
  high_issues INTEGER DEFAULT 0,
  medium_issues INTEGER DEFAULT 0,
  low_issues INTEGER DEFAULT 0,
  started_at DATETIME,
  completed_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES app_waf_security__waf_campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (scan_id) REFERENCES app_waf_security__waf_scans(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_campaign_scans_campaign ON app_waf_security__waf_campaign_scans(campaign_id, run_number DESC);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_campaign_scans_scan ON app_waf_security__waf_campaign_scans(scan_id);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_campaign_scans_stage ON app_waf_security__waf_campaign_scans(campaign_id, stage);

CREATE TABLE IF NOT EXISTS app_waf_security__waf_campaign_comparisons (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  baseline_scan_id TEXT NOT NULL,
  current_scan_id TEXT NOT NULL,
  baseline_run_number INTEGER NOT NULL,
  current_run_number INTEGER NOT NULL,
  security_score_delta REAL DEFAULT 0.0,
  baseline_score REAL DEFAULT 0.0,
  current_score REAL DEFAULT 0.0,
  new_vulnerabilities INTEGER DEFAULT 0,
  fixed_vulnerabilities INTEGER DEFAULT 0,
  persistent_vulnerabilities INTEGER DEFAULT 0,
  regression_detected BOOLEAN DEFAULT 0,
  new_issues_json TEXT,
  fixed_issues_json TEXT,
  regression_issues_json TEXT,
  comparison_type TEXT DEFAULT 'sequential' CHECK(comparison_type IN ('sequential', 'baseline', 'custom')),
  comparison_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES app_waf_security__waf_campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (baseline_scan_id) REFERENCES app_waf_security__waf_scans(id),
  FOREIGN KEY (current_scan_id) REFERENCES app_waf_security__waf_scans(id)
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_comparisons_campaign ON app_waf_security__waf_campaign_comparisons(campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_comparisons_regression ON app_waf_security__waf_campaign_comparisons(regression_detected);

-- The four stages; the app adds their rows itself (src/seed.js).
CREATE TABLE IF NOT EXISTS app_waf_security__waf_campaign_stages (
  stage_number INTEGER PRIMARY KEY,
  stage_name TEXT NOT NULL,
  stage_description TEXT,
  default_mode TEXT DEFAULT 'quick',
  default_categories TEXT,
  default_timeout_s INTEGER DEFAULT 60
);

CREATE TABLE IF NOT EXISTS app_waf_security__waf_campaign_notifications (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  notification_type TEXT NOT NULL CHECK(notification_type IN ('regression', 'improvement', 'completion', 'failure', 'schedule')),
  severity TEXT DEFAULT 'info' CHECK(severity IN ('critical', 'high', 'medium', 'low', 'info')),
  title TEXT NOT NULL,
  message TEXT,
  metadata_json TEXT,
  read BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (campaign_id) REFERENCES app_waf_security__waf_campaigns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_notifications_user ON app_waf_security__waf_campaign_notifications(user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_notifications_campaign ON app_waf_security__waf_campaign_notifications(campaign_id);
