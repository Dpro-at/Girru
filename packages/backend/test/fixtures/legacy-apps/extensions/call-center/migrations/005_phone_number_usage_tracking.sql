-- Migration 005: Phone Number Usage Tracking
-- Adds usage statistics columns to phone_numbers table

-- ════════════════════════════════════════════════════════════════════════════
-- ADD USAGE TRACKING COLUMNS
-- ════════════════════════════════════════════════════════════════════════════

-- Call statistics
ALTER TABLE phone_numbers ADD COLUMN total_calls INTEGER DEFAULT 0;
ALTER TABLE phone_numbers ADD COLUMN total_inbound_calls INTEGER DEFAULT 0;
ALTER TABLE phone_numbers ADD COLUMN total_outbound_calls INTEGER DEFAULT 0;

-- Duration statistics (in seconds)
ALTER TABLE phone_numbers ADD COLUMN total_duration_seconds INTEGER DEFAULT 0;
ALTER TABLE phone_numbers ADD COLUMN total_inbound_duration_seconds INTEGER DEFAULT 0;
ALTER TABLE phone_numbers ADD COLUMN total_outbound_duration_seconds INTEGER DEFAULT 0;

-- Cost tracking (USD)
ALTER TABLE phone_numbers ADD COLUMN total_cost_spent REAL DEFAULT 0.0;
ALTER TABLE phone_numbers ADD COLUMN estimated_monthly_cost REAL DEFAULT 0.0; -- Projected based on usage

-- Usage timestamps
ALTER TABLE phone_numbers ADD COLUMN last_used_at TEXT;
ALTER TABLE phone_numbers ADD COLUMN last_sync_at TEXT;

-- ════════════════════════════════════════════════════════════════════════════
-- USAGE ANALYTICS TABLE (Daily breakdown)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS phone_number_usage (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  phone_number_id TEXT NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD

  -- Call counts
  total_calls INTEGER DEFAULT 0,
  inbound_calls INTEGER DEFAULT 0,
  outbound_calls INTEGER DEFAULT 0,

  -- Duration (seconds)
  total_duration_seconds INTEGER DEFAULT 0,
  inbound_duration_seconds INTEGER DEFAULT 0,
  outbound_duration_seconds INTEGER DEFAULT 0,

  -- Cost (USD)
  cost_spent REAL DEFAULT 0.0,

  created_at TEXT DEFAULT (datetime('now')),

  UNIQUE(phone_number_id, date),
  FOREIGN KEY (phone_number_id) REFERENCES phone_numbers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_phone_usage_number ON phone_number_usage(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_phone_usage_date ON phone_number_usage(date);

-- ════════════════════════════════════════════════════════════════════════════
-- INITIALIZE EXISTING NUMBERS WITH ZERO USAGE
-- ════════════════════════════════════════════════════════════════════════════

UPDATE phone_numbers
SET
  total_calls = 0,
  total_inbound_calls = 0,
  total_outbound_calls = 0,
  total_duration_seconds = 0,
  total_inbound_duration_seconds = 0,
  total_outbound_duration_seconds = 0,
  total_cost_spent = 0.0,
  estimated_monthly_cost = 0.0
WHERE total_calls IS NULL;
