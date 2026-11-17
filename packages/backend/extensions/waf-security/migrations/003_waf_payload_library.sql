-- The test library: request patterns by group. The app adds its starting rows itself (src/seed.js).

CREATE TABLE IF NOT EXISTS app_waf_security__waf_payload_library (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  payload TEXT NOT NULL,
  description TEXT,
  severity TEXT DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  evasion_technique TEXT DEFAULT 'none' CHECK(evasion_technique IN ('none', 'encoding', 'obfuscation', 'polymorphic')),
  success_rate REAL DEFAULT 0.0 CHECK(success_rate >= 0 AND success_rate <= 1),
  blocked_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_payload_category ON app_waf_security__waf_payload_library(category);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_payload_severity ON app_waf_security__waf_payload_library(severity);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_payload_evasion ON app_waf_security__waf_payload_library(evasion_technique);
