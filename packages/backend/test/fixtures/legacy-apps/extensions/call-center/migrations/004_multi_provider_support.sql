-- Migration 004: Multi-Provider Support (Twilio + Microsoft Teams Phone)
-- Adds provider abstraction layer for telephony services

-- ════════════════════════════════════════════════════════════════════════════
-- PROVIDER CONFIGURATION
-- ════════════════════════════════════════════════════════════════════════════

-- Provider configurations (credentials stored in encrypted credentials table)
CREATE TABLE IF NOT EXISTS telephony_providers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  provider_name TEXT NOT NULL UNIQUE CHECK(provider_name IN ('twilio', 'microsoft_teams', 'vonage', 'plivo')),
  display_name TEXT NOT NULL,
  enabled INTEGER DEFAULT 0, -- 0=disabled, 1=enabled
  is_default INTEGER DEFAULT 0, -- 0=no, 1=default provider

  -- Provider-specific configuration (JSON)
  config TEXT, -- {"region": "us1", "features": [...]}

  -- Pricing information (for UI display)
  pricing_info TEXT, -- JSON: {"base": "$8/user/month", "perMinute": "$0.03", "setup": "$0"}

  -- Capabilities (JSON array)
  capabilities TEXT, -- ["voice", "sms", "video", "recording", "transcription"]

  -- Status
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'maintenance', 'deprecated')),
  last_health_check TEXT,
  health_status TEXT, -- "healthy", "degraded", "down"

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Insert default providers
INSERT INTO telephony_providers (
  id, provider_name, display_name, enabled, is_default, pricing_info, capabilities, status
) VALUES
  (
    'provider_twilio',
    'twilio',
    'Twilio',
    1, -- enabled by default
    1, -- default provider
    json('{"base": "$0", "perMinute": "$0.0085", "setup": "$1.00", "monthly": "$1.15/number", "currency": "USD"}'),
    json('["voice", "sms", "video", "recording", "transcription", "conference", "ivr"]'),
    'active'
  ),
  (
    'provider_teams',
    'microsoft_teams',
    'Microsoft Teams Phone',
    0, -- disabled by default (requires setup)
    0,
    json('{"base": "$8-12/user/month", "perMinute": "$0.03-0.04", "setup": "Free", "domestic": "$12/user/month (3000 min)", "international": "$24/user/month (1200 min)", "currency": "USD"}'),
    json('["voice", "video", "recording", "conference", "screen_share", "transfer", "hold", "pstn"]'),
    'active'
  ),
  (
    'provider_vonage',
    'vonage',
    'Vonage (Nexmo)',
    0, -- disabled by default
    0,
    json('{"base": "$0", "perMinute": "$0.004", "setup": "$0.90", "monthly": "$0.90/number", "currency": "USD"}'),
    json('["voice", "sms", "recording", "conference", "ivr", "transfer", "hold"]'),
    'active'
  );

-- ════════════════════════════════════════════════════════════════════════════
-- UPDATE EXISTING TABLES
-- ════════════════════════════════════════════════════════════════════════════

-- Add provider field to phone_numbers
ALTER TABLE phone_numbers ADD COLUMN provider_type TEXT DEFAULT 'twilio' CHECK(provider_type IN ('twilio', 'microsoft_teams', 'vonage', 'plivo'));

-- Add Teams-specific fields to phone_numbers
ALTER TABLE phone_numbers ADD COLUMN teams_user_id TEXT; -- Microsoft Graph user ID
ALTER TABLE phone_numbers ADD COLUMN teams_resource_account_id TEXT; -- Resource account ID
ALTER TABLE phone_numbers ADD COLUMN sip_uri TEXT; -- SIP format: sip:user@domain.com

-- Add provider field to call_sessions
ALTER TABLE call_sessions ADD COLUMN provider_type TEXT DEFAULT 'twilio';

-- Add Teams-specific fields to call_sessions
ALTER TABLE call_sessions ADD COLUMN teams_call_id TEXT; -- Graph API call ID
ALTER TABLE call_sessions ADD COLUMN sip_from TEXT; -- SIP URI
ALTER TABLE call_sessions ADD COLUMN sip_to TEXT; -- SIP URI

-- ════════════════════════════════════════════════════════════════════════════
-- PROVIDER HEALTH MONITORING
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS provider_health_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  provider_id TEXT NOT NULL,
  check_type TEXT CHECK(check_type IN ('api', 'connectivity', 'auth', 'webhook')),
  status TEXT CHECK(status IN ('success', 'failure', 'timeout')),
  response_time_ms INTEGER,
  error_message TEXT,
  checked_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES telephony_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_provider_health_provider ON provider_health_log(provider_id);
CREATE INDEX IF NOT EXISTS idx_provider_health_checked ON provider_health_log(checked_at);

-- ════════════════════════════════════════════════════════════════════════════
-- PROVIDER USAGE ANALYTICS
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS provider_usage_stats (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  provider_id TEXT NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD

  -- Call metrics
  total_calls INTEGER DEFAULT 0,
  successful_calls INTEGER DEFAULT 0,
  failed_calls INTEGER DEFAULT 0,

  -- Duration metrics
  total_minutes INTEGER DEFAULT 0,

  -- Cost estimates
  estimated_cost REAL DEFAULT 0.0,

  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(provider_id, date),
  FOREIGN KEY (provider_id) REFERENCES telephony_providers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_provider_usage_date ON provider_usage_stats(date);
CREATE INDEX IF NOT EXISTS idx_provider_usage_provider ON provider_usage_stats(provider_id);

-- ════════════════════════════════════════════════════════════════════════════
-- INDEXES FOR TEAMS PHONE
-- ════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_phone_numbers_teams_user ON phone_numbers(teams_user_id);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_teams_resource ON phone_numbers(teams_resource_account_id);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_sip ON phone_numbers(sip_uri);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_provider ON phone_numbers(provider_type);

CREATE INDEX IF NOT EXISTS idx_call_sessions_teams_call ON call_sessions(teams_call_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_provider ON call_sessions(provider_type);
