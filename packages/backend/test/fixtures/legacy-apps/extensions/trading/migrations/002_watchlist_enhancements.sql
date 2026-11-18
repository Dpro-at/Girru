-- Trading Watchlist Enhancements Migration
-- Adds: Multiple watchlists, Price alerts, Improved organization

-- ============================================================================
-- WATCHLIST GROUPS (Multiple Named Watchlists)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_watchlist_groups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Group Identity
  name TEXT NOT NULL, -- "Tech Stocks", "Crypto", "Day Trading"
  description TEXT,
  color TEXT DEFAULT '#3B82F6', -- Hex color for UI
  icon TEXT, -- Optional icon name (lucide-react)

  -- Display
  display_order INTEGER DEFAULT 0,
  is_default INTEGER DEFAULT 0, -- Default watchlist

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_watchlist_groups_user ON trading_watchlist_groups(user_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_groups_order ON trading_watchlist_groups(user_id, display_order);

-- ============================================================================
-- UPDATE WATCHLIST TABLE (Add Group Support)
-- ============================================================================

-- Add watchlist_group_id column to existing trading_watchlist
ALTER TABLE trading_watchlist ADD COLUMN watchlist_group_id TEXT REFERENCES trading_watchlist_groups(id) ON DELETE CASCADE;

-- Create index for group lookups
CREATE INDEX IF NOT EXISTS idx_watchlist_group ON trading_watchlist(watchlist_group_id);

-- ============================================================================
-- PRICE ALERTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_price_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Asset Target
  symbol TEXT NOT NULL,
  asset_class TEXT DEFAULT 'us_equity' CHECK(asset_class IN ('us_equity', 'crypto', 'etf', 'option')),

  -- Alert Conditions
  alert_type TEXT NOT NULL CHECK(alert_type IN ('above', 'below', 'percent_change')),
  -- above: trigger when price >= target_price
  -- below: trigger when price <= target_price
  -- percent_change: trigger when |change%| >= target_percent

  target_price REAL, -- For 'above' and 'below' types
  target_percent REAL, -- For 'percent_change' type

  -- Alert Settings
  is_active INTEGER DEFAULT 1,
  repeat_alert INTEGER DEFAULT 0, -- 0=once, 1=repeat on each trigger
  notification_channels TEXT DEFAULT '["in_app"]', -- JSON: ["in_app", "email", "push"]

  -- Execution
  last_triggered_at TEXT,
  trigger_count INTEGER DEFAULT 0,

  -- Optional Actions
  auto_execute_order INTEGER DEFAULT 0, -- Auto place order when triggered
  order_config TEXT, -- JSON: {"side": "buy", "qty": 10, "order_type": "market"}

  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT, -- Optional expiration

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_price_alerts_user ON trading_price_alerts(user_id);
CREATE INDEX IF NOT EXISTS idx_price_alerts_symbol ON trading_price_alerts(symbol);
CREATE INDEX IF NOT EXISTS idx_price_alerts_active ON trading_price_alerts(is_active);

-- ============================================================================
-- WATCHLIST METADATA (For Import/Export)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_watchlist_imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  watchlist_group_id TEXT,

  -- Import Details
  filename TEXT NOT NULL,
  symbols_count INTEGER DEFAULT 0,
  successful_imports INTEGER DEFAULT 0,
  failed_imports INTEGER DEFAULT 0,

  imported_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (watchlist_group_id) REFERENCES trading_watchlist_groups(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_watchlist_imports_user ON trading_watchlist_imports(user_id);

-- ============================================================================
-- DEFAULT DATA (Create Default Watchlist)
-- ============================================================================

-- Create default watchlist group for existing users
-- This will be handled in routes.js when user first accesses watchlist feature
