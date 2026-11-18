-- ═══════════════════════════════════════════════════════════════════════════
-- Outbound Call Campaigns - Migration 003
-- Auto-dialer, bulk calling, campaign management
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Table 1: Call Campaigns ────────────────────────────────────────────────
-- Campaign configuration and management
CREATE TABLE IF NOT EXISTS call_campaigns (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  call_point_id TEXT NOT NULL,

  -- Campaign type and message
  type TEXT NOT NULL CHECK(type IN ('sales', 'notification', 'survey', 'followup')),
  message_template TEXT NOT NULL,        -- "مرحباً {name}، عندنا عرض..."
  agent_id TEXT,                         -- AI Agent for interactive conversations

  -- Status and scheduling
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'scheduled', 'running', 'paused', 'completed', 'cancelled')),
  start_at TEXT,                         -- When to start (ISO timestamp)
  end_at TEXT,                           -- Auto-stop time (optional)

  -- Execution settings
  max_concurrent_calls INTEGER DEFAULT 3 CHECK(max_concurrent_calls BETWEEN 1 AND 10),
  business_hours_only BOOLEAN DEFAULT 1,
  retry_attempts INTEGER DEFAULT 2 CHECK(retry_attempts BETWEEN 0 AND 5),
  retry_delay_minutes INTEGER DEFAULT 30 CHECK(retry_delay_minutes BETWEEN 5 AND 1440),

  -- Response handling (IVR or AI)
  response_mode TEXT DEFAULT 'ivr' CHECK(response_mode IN ('ivr', 'ai')),
  ivr_options TEXT,                      -- JSON: [{"digit":"1","label":"Interested","action":"..."}]

  -- Statistics (updated in real-time)
  total_contacts INTEGER DEFAULT 0,
  completed_calls INTEGER DEFAULT 0,
  successful_calls INTEGER DEFAULT 0,    -- Calls where contact answered
  interested_count INTEGER DEFAULT 0,
  not_interested_count INTEGER DEFAULT 0,
  callback_requested INTEGER DEFAULT 0,

  -- Cost tracking
  total_cost REAL DEFAULT 0.0,

  -- Metadata
  created_by TEXT,                       -- User ID who created campaign
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,                       -- Actual start time
  completed_at TEXT,                     -- Actual completion time

  FOREIGN KEY (call_point_id) REFERENCES call_points(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE SET NULL
);

-- ── Table 2: Campaign Contacts ─────────────────────────────────────────────
-- Individual contacts in each campaign
CREATE TABLE IF NOT EXISTS campaign_contacts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_id TEXT NOT NULL,

  -- Contact information
  phone_number TEXT NOT NULL,
  name TEXT,
  email TEXT,
  custom_data TEXT,                      -- JSON: {discount: "50%", product: "iPhone", ...}

  -- Call status
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'calling', 'completed', 'failed', 'no_answer', 'busy', 'skipped')),
  call_attempts INTEGER DEFAULT 0,
  last_call_at TEXT,
  next_retry_at TEXT,

  -- Call result
  call_result TEXT CHECK(call_result IN ('interested', 'not_interested', 'requested_callback', 'wrong_number', 'voicemail', 'no_response', NULL)),
  call_duration_seconds INTEGER,
  notes TEXT,

  -- References
  call_session_id TEXT,                  -- Link to call_sessions table

  -- Metadata
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (campaign_id) REFERENCES call_campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (call_session_id) REFERENCES call_sessions(id) ON DELETE SET NULL
);

-- ── Table 3: Campaign Daily Analytics ──────────────────────────────────────
-- Daily breakdown for reporting
CREATE TABLE IF NOT EXISTS campaign_analytics (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  campaign_id TEXT NOT NULL,
  date TEXT NOT NULL,                    -- YYYY-MM-DD

  -- Call statistics
  total_calls INTEGER DEFAULT 0,
  answered_calls INTEGER DEFAULT 0,
  no_answer_calls INTEGER DEFAULT 0,
  busy_calls INTEGER DEFAULT 0,
  failed_calls INTEGER DEFAULT 0,

  -- Results breakdown
  interested_count INTEGER DEFAULT 0,
  not_interested_count INTEGER DEFAULT 0,
  callback_requested INTEGER DEFAULT 0,
  wrong_number_count INTEGER DEFAULT 0,
  voicemail_count INTEGER DEFAULT 0,

  -- Performance metrics
  avg_call_duration_seconds INTEGER,
  total_call_minutes INTEGER DEFAULT 0,
  success_rate REAL,                     -- (answered / total) * 100
  interest_rate REAL,                    -- (interested / answered) * 100

  -- Cost tracking
  total_cost REAL DEFAULT 0.0,
  cost_per_lead REAL,                    -- total_cost / interested_count

  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (campaign_id) REFERENCES call_campaigns(id) ON DELETE CASCADE,
  UNIQUE(campaign_id, date)              -- One record per campaign per day
);

-- ── Indexes for Performance ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_campaign_status ON call_campaigns(status, start_at);
CREATE INDEX IF NOT EXISTS idx_campaign_point ON call_campaigns(call_point_id, status);

CREATE INDEX IF NOT EXISTS idx_contact_campaign_status ON campaign_contacts(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_contact_next_retry ON campaign_contacts(next_retry_at, status);
CREATE INDEX IF NOT EXISTS idx_contact_result ON campaign_contacts(campaign_id, call_result);

CREATE INDEX IF NOT EXISTS idx_analytics_campaign_date ON campaign_analytics(campaign_id, date DESC);

-- ── Triggers for Auto-update Statistics ────────────────────────────────────
-- Update campaign stats when contact status changes
CREATE TRIGGER IF NOT EXISTS update_campaign_stats_on_contact_update
AFTER UPDATE ON campaign_contacts
FOR EACH ROW
WHEN NEW.status = 'completed' AND OLD.status != 'completed'
BEGIN
  UPDATE call_campaigns SET
    completed_calls = completed_calls + 1,
    successful_calls = CASE WHEN NEW.call_result IS NOT NULL THEN successful_calls + 1 ELSE successful_calls END,
    interested_count = CASE WHEN NEW.call_result = 'interested' THEN interested_count + 1 ELSE interested_count END,
    not_interested_count = CASE WHEN NEW.call_result = 'not_interested' THEN not_interested_count + 1 ELSE not_interested_count END,
    callback_requested = CASE WHEN NEW.call_result = 'requested_callback' THEN callback_requested + 1 ELSE callback_requested END
  WHERE id = NEW.campaign_id;
END;

-- Update campaign total_contacts when contact added
CREATE TRIGGER IF NOT EXISTS update_campaign_total_contacts
AFTER INSERT ON campaign_contacts
FOR EACH ROW
BEGIN
  UPDATE call_campaigns SET
    total_contacts = total_contacts + 1
  WHERE id = NEW.campaign_id;
END;

-- Auto-update updated_at timestamp
CREATE TRIGGER IF NOT EXISTS update_campaign_contacts_timestamp
AFTER UPDATE ON campaign_contacts
FOR EACH ROW
BEGIN
  UPDATE campaign_contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration Complete
-- ═══════════════════════════════════════════════════════════════════════════
