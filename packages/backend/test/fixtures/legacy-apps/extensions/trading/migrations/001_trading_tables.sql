-- Trading Extension Database Schema
-- Complete system: Manual Trading + AI Strategies + Automated Trading

-- ============================================================================
-- TRADING ACCOUNTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Platform & Identification
  platform TEXT NOT NULL DEFAULT 'alpaca', -- 'alpaca', 'binance', 'ibkr' (future)
  account_name TEXT NOT NULL,
  account_mode TEXT NOT NULL CHECK(account_mode IN ('paper', 'live')),

  -- API Credentials (stored via credentials system - only IDs here)
  api_key_credential_id TEXT NOT NULL,
  api_secret_credential_id TEXT NOT NULL,

  -- Account Status
  is_active INTEGER DEFAULT 1,
  is_default INTEGER DEFAULT 0,

  -- Alpaca Account Info (cached)
  alpaca_account_id TEXT,
  account_status TEXT,
  account_blocked INTEGER DEFAULT 0,
  trade_suspended_by_user INTEGER DEFAULT 0,

  -- AI Trading Settings
  allow_autonomous_trading INTEGER DEFAULT 0, -- 0=manual only, 1=allow AI auto trading

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_synced_at TEXT,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trading_accounts_user ON trading_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_trading_accounts_mode ON trading_accounts(user_id, account_mode);
CREATE INDEX IF NOT EXISTS idx_trading_accounts_active ON trading_accounts(user_id, is_active);

-- ============================================================================
-- PORTFOLIO SNAPSHOTS (Historical Data)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_portfolio_snapshots (
  id TEXT PRIMARY KEY,
  trading_account_id TEXT NOT NULL,

  -- Account Balance
  cash REAL NOT NULL,
  portfolio_value REAL NOT NULL,
  equity REAL NOT NULL,
  buying_power REAL NOT NULL,

  -- Performance
  profit_loss REAL,
  profit_loss_percent REAL,

  -- Timestamp
  snapshot_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_account ON trading_portfolio_snapshots(trading_account_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_time ON trading_portfolio_snapshots(snapshot_at);

-- ============================================================================
-- POSITIONS (Current Holdings)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_positions (
  id TEXT PRIMARY KEY,
  trading_account_id TEXT NOT NULL,

  -- Asset Identification
  symbol TEXT NOT NULL,
  asset_class TEXT DEFAULT 'us_equity' CHECK(asset_class IN ('us_equity', 'crypto', 'etf', 'option')),

  -- Position Details
  qty REAL NOT NULL,
  avg_entry_price REAL NOT NULL,
  current_price REAL,
  market_value REAL,

  -- Performance
  unrealized_pl REAL,
  unrealized_plpc REAL,

  -- Position Type
  side TEXT NOT NULL DEFAULT 'long' CHECK(side IN ('long', 'short')),

  -- Timestamps
  opened_at TEXT,
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_positions_account ON trading_positions(trading_account_id);
CREATE INDEX IF NOT EXISTS idx_positions_symbol ON trading_positions(symbol);
CREATE INDEX IF NOT EXISTS idx_positions_asset_class ON trading_positions(asset_class);

-- ============================================================================
-- ORDERS (Historical & Pending)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_orders (
  id TEXT PRIMARY KEY,
  trading_account_id TEXT NOT NULL,

  -- Alpaca Order ID
  alpaca_order_id TEXT UNIQUE,

  -- Order Details
  symbol TEXT NOT NULL,
  asset_class TEXT DEFAULT 'us_equity' CHECK(asset_class IN ('us_equity', 'crypto', 'etf', 'option')),
  qty REAL NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  order_type TEXT NOT NULL CHECK(order_type IN ('market', 'limit', 'stop', 'stop_limit')),
  time_in_force TEXT NOT NULL DEFAULT 'day' CHECK(time_in_force IN ('day', 'gtc', 'ioc', 'fok')),

  -- Pricing
  limit_price REAL,
  stop_price REAL,
  filled_avg_price REAL,

  -- Status
  status TEXT NOT NULL CHECK(status IN ('new', 'pending_new', 'accepted', 'filled', 'partially_filled', 'canceled', 'rejected', 'expired')),
  filled_qty REAL DEFAULT 0,

  -- Source Tracking
  placed_by TEXT, -- 'user', 'agent', 'strategy:{strategy_id}'
  strategy_id TEXT, -- Link to trading_strategies if placed by strategy

  -- Timestamps
  submitted_at TEXT,
  filled_at TEXT,
  canceled_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (strategy_id) REFERENCES trading_strategies(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_account ON trading_orders(trading_account_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON trading_orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_symbol ON trading_orders(symbol);
CREATE INDEX IF NOT EXISTS idx_orders_alpaca ON trading_orders(alpaca_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_time ON trading_orders(submitted_at);
CREATE INDEX IF NOT EXISTS idx_orders_strategy ON trading_orders(strategy_id);

-- ============================================================================
-- TRADE HISTORY (Completed Trades for Analytics)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_history (
  id TEXT PRIMARY KEY,
  trading_account_id TEXT NOT NULL,
  order_id TEXT,
  strategy_id TEXT,

  -- Trade Details
  symbol TEXT NOT NULL,
  asset_class TEXT DEFAULT 'us_equity',
  qty REAL NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  price REAL NOT NULL,

  -- P&L (calculated on sell trades)
  realized_pl REAL,
  realized_plpc REAL,

  -- Timestamps
  executed_at TEXT NOT NULL,

  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES trading_orders(id) ON DELETE SET NULL,
  FOREIGN KEY (strategy_id) REFERENCES trading_strategies(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_history_account ON trading_history(trading_account_id);
CREATE INDEX IF NOT EXISTS idx_history_symbol ON trading_history(symbol);
CREATE INDEX IF NOT EXISTS idx_history_time ON trading_history(executed_at);
CREATE INDEX IF NOT EXISTS idx_history_strategy ON trading_history(strategy_id);

-- ============================================================================
-- WATCHLIST (Favorite Stocks/Crypto)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_watchlist (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Symbol Details
  symbol TEXT NOT NULL,
  asset_class TEXT DEFAULT 'us_equity' CHECK(asset_class IN ('us_equity', 'crypto', 'etf', 'option')),
  name TEXT,
  notes TEXT,

  -- Display Order
  display_order INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_user ON trading_watchlist(user_id);
CREATE INDEX IF NOT EXISTS idx_watchlist_order ON trading_watchlist(user_id, display_order);

-- ============================================================================
-- TRADING STRATEGIES (AI/Automated Trading)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_strategies (
  id TEXT PRIMARY KEY,
  trading_account_id TEXT NOT NULL,

  -- Strategy Identity
  strategy_name TEXT NOT NULL,
  strategy_type TEXT NOT NULL CHECK(strategy_type IN ('ma_crossover', 'rsi', 'breakout', 'ai_powered', 'custom')),

  -- Execution Mode
  execution_mode TEXT NOT NULL DEFAULT 'manual' CHECK(execution_mode IN ('manual', 'semi_auto', 'full_auto')),
  -- manual: AI assistant only (suggestions)
  -- semi_auto: AI generates signals, user approves
  -- full_auto: AI executes trades automatically

  -- Status
  status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN ('active', 'paused', 'stopped')),

  -- Target Assets
  symbols TEXT NOT NULL, -- JSON array: ["AAPL", "TSLA", "BTCUSD"]
  asset_classes TEXT, -- JSON array: ["us_equity", "crypto"]

  -- Risk Management
  max_position_size REAL, -- Max $ per position
  max_daily_trades INTEGER DEFAULT 10, -- Max trades per day
  stop_loss_percent REAL, -- Auto sell if loss > X%
  take_profit_percent REAL, -- Auto sell if profit > X%

  -- Strategy Configuration (JSON)
  config TEXT, -- Strategy-specific parameters
  -- Example for MA Crossover: {"ma_short": 50, "ma_long": 200}
  -- Example for RSI: {"period": 14, "oversold": 30, "overbought": 70}

  -- Performance Tracking
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  total_profit_loss REAL DEFAULT 0,
  win_rate REAL, -- Percentage

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  stopped_at TEXT,
  last_run_at TEXT,

  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_strategies_account ON trading_strategies(trading_account_id);
CREATE INDEX IF NOT EXISTS idx_strategies_status ON trading_strategies(status);
CREATE INDEX IF NOT EXISTS idx_strategies_mode ON trading_strategies(execution_mode);

-- ============================================================================
-- TRADING SIGNALS (AI-Generated Buy/Sell Recommendations)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_signals (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,
  trading_account_id TEXT NOT NULL,

  -- Signal Details
  symbol TEXT NOT NULL,
  asset_class TEXT DEFAULT 'us_equity',
  signal_type TEXT NOT NULL CHECK(signal_type IN ('buy', 'sell', 'hold')),

  -- Analysis
  current_price REAL NOT NULL,
  target_price REAL, -- Expected price
  stop_loss_price REAL, -- Auto-sell if drops below
  confidence REAL CHECK(confidence >= 0 AND confidence <= 1), -- 0-1 (AI confidence)
  reason TEXT, -- Why this signal was generated
  analysis_data TEXT, -- JSON with technical indicators

  -- Recommended Order
  recommended_qty REAL,
  recommended_order_type TEXT DEFAULT 'market' CHECK(recommended_order_type IN ('market', 'limit')),

  -- Execution Status
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected', 'executed', 'expired', 'failed')),

  -- Execution Details
  order_id TEXT, -- Link to trading_orders if executed
  executed_price REAL,
  executed_qty REAL,
  execution_error TEXT,

  -- Approval (for semi-auto mode)
  requires_approval INTEGER DEFAULT 1,
  approved_by TEXT, -- user_id who approved
  approved_at TEXT,
  rejected_at TEXT,
  rejection_reason TEXT,

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  executed_at TEXT,
  expires_at TEXT, -- Signal expires after X hours

  FOREIGN KEY (strategy_id) REFERENCES trading_strategies(id) ON DELETE CASCADE,
  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES trading_orders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_signals_strategy ON trading_signals(strategy_id);
CREATE INDEX IF NOT EXISTS idx_signals_account ON trading_signals(trading_account_id);
CREATE INDEX IF NOT EXISTS idx_signals_status ON trading_signals(status);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON trading_signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_pending ON trading_signals(status, requires_approval);

-- ============================================================================
-- STRATEGY PERFORMANCE (Daily Analytics)
-- ============================================================================

CREATE TABLE IF NOT EXISTS strategy_performance (
  id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL,

  -- Date
  date DATE NOT NULL,

  -- Trading Metrics
  trades_count INTEGER DEFAULT 0,
  wins INTEGER DEFAULT 0,
  losses INTEGER DEFAULT 0,
  profit_loss REAL DEFAULT 0,
  win_rate REAL,

  -- Portfolio Impact
  starting_balance REAL,
  ending_balance REAL,

  FOREIGN KEY (strategy_id) REFERENCES trading_strategies(id) ON DELETE CASCADE,
  UNIQUE(strategy_id, date)
);

CREATE INDEX IF NOT EXISTS idx_performance_strategy ON strategy_performance(strategy_id);
CREATE INDEX IF NOT EXISTS idx_performance_date ON strategy_performance(date);

-- ============================================================================
-- TRADING ACTIVITY LOG (Audit Trail)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_activity_log (
  id TEXT PRIMARY KEY,
  trading_account_id TEXT,
  strategy_id TEXT,

  -- Activity
  action TEXT NOT NULL, -- 'order_placed', 'order_filled', 'strategy_started', 'signal_generated', etc.
  details TEXT, -- JSON details

  -- User/Agent
  triggered_by TEXT, -- 'user', 'agent', 'strategy', 'cron'

  created_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (strategy_id) REFERENCES trading_strategies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_activity_log_account ON trading_activity_log(trading_account_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_strategy ON trading_activity_log(strategy_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_time ON trading_activity_log(created_at);
