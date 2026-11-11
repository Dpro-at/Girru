-- Migration 004: Options Trading Tables
-- Created: 2026-02-27
-- Adds support for options trading, Greeks calculations, and strategy builder

-- ============================================================================
-- OPTIONS POSITIONS TABLE
-- ============================================================================
-- Tracks user's open options positions (calls/puts)
CREATE TABLE IF NOT EXISTS trading_options_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_account_id INTEGER NOT NULL,
  symbol TEXT NOT NULL, -- Underlying stock symbol (e.g., AAPL)
  option_symbol TEXT NOT NULL, -- Full option symbol (e.g., AAPL230120C00150000)
  option_type TEXT NOT NULL CHECK(option_type IN ('call', 'put')), -- Call or Put
  strike_price REAL NOT NULL, -- Strike price
  expiration_date TEXT NOT NULL, -- ISO date (YYYY-MM-DD)
  qty INTEGER NOT NULL, -- Number of contracts (negative for short positions)
  side TEXT NOT NULL CHECK(side IN ('long', 'short')), -- Long (buy) or Short (sell)
  avg_entry_price REAL NOT NULL, -- Average entry price per contract
  current_price REAL, -- Current market price (updated from API)
  market_value REAL, -- Current market value (current_price × qty × 100)
  cost_basis REAL, -- Total cost (avg_entry_price × qty × 100)
  unrealized_pl REAL, -- Unrealized P/L in dollars
  unrealized_plpc REAL, -- Unrealized P/L in percent
  -- Greeks (updated from API or calculated)
  delta REAL, -- Option delta
  gamma REAL, -- Option gamma
  theta REAL, -- Option theta (time decay)
  vega REAL, -- Option vega (volatility sensitivity)
  rho REAL, -- Option rho (interest rate sensitivity)
  implied_volatility REAL, -- IV percentage
  -- Metadata
  opened_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_options_positions_account ON trading_options_positions(trading_account_id);
CREATE INDEX idx_options_positions_symbol ON trading_options_positions(symbol);
CREATE INDEX idx_options_positions_expiration ON trading_options_positions(expiration_date);

-- ============================================================================
-- OPTIONS ORDERS TABLE
-- ============================================================================
-- Tracks options orders (pending + filled)
CREATE TABLE IF NOT EXISTS trading_options_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_account_id INTEGER NOT NULL,
  alpaca_order_id TEXT, -- Alpaca's order ID
  symbol TEXT NOT NULL, -- Underlying symbol
  option_symbol TEXT NOT NULL, -- Full option symbol
  option_type TEXT NOT NULL CHECK(option_type IN ('call', 'put')),
  strike_price REAL NOT NULL,
  expiration_date TEXT NOT NULL,
  qty INTEGER NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close')),
  order_type TEXT NOT NULL CHECK(order_type IN ('market', 'limit', 'stop', 'stop_limit')),
  limit_price REAL, -- For limit orders
  stop_price REAL, -- For stop orders
  time_in_force TEXT DEFAULT 'day' CHECK(time_in_force IN ('day', 'gtc', 'ioc', 'fok')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'filled', 'partially_filled', 'cancelled', 'rejected')),
  filled_qty INTEGER DEFAULT 0,
  filled_avg_price REAL,
  commission REAL DEFAULT 0, -- Alpaca charges $0.65 per contract (may vary)
  placed_by TEXT DEFAULT 'user', -- 'user' or agent_id
  placed_at TEXT DEFAULT (datetime('now')),
  filled_at TEXT,
  cancelled_at TEXT,
  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_options_orders_account ON trading_options_orders(trading_account_id);
CREATE INDEX idx_options_orders_alpaca_id ON trading_options_orders(alpaca_order_id);
CREATE INDEX idx_options_orders_status ON trading_options_orders(status);
CREATE INDEX idx_options_orders_symbol ON trading_options_orders(symbol);

-- ============================================================================
-- OPTIONS CHAIN CACHE TABLE
-- ============================================================================
-- Caches options chain data from Alpaca API (reduces API calls)
CREATE TABLE IF NOT EXISTS trading_options_chain_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL, -- Underlying symbol
  expiration_date TEXT NOT NULL, -- Expiration date for this chain
  strike_price REAL NOT NULL,
  option_type TEXT NOT NULL CHECK(option_type IN ('call', 'put')),
  option_symbol TEXT NOT NULL UNIQUE, -- Full option symbol
  -- Pricing
  bid REAL,
  ask REAL,
  last_price REAL,
  open_interest INTEGER,
  volume INTEGER,
  -- Greeks
  delta REAL,
  gamma REAL,
  theta REAL,
  vega REAL,
  rho REAL,
  implied_volatility REAL,
  -- Metadata
  fetched_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT DEFAULT (datetime('now', '+5 minutes')) -- Cache TTL: 5 minutes
);

CREATE INDEX idx_options_chain_symbol ON trading_options_chain_cache(symbol);
CREATE INDEX idx_options_chain_expiration ON trading_options_chain_cache(expiration_date);
CREATE INDEX idx_options_chain_expires ON trading_options_chain_cache(expires_at);
CREATE UNIQUE INDEX idx_options_chain_unique ON trading_options_chain_cache(option_symbol);

-- ============================================================================
-- OPTIONS STRATEGIES TABLE
-- ============================================================================
-- Tracks multi-leg options strategies (spreads, straddles, etc.)
CREATE TABLE IF NOT EXISTS trading_options_strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_account_id INTEGER NOT NULL,
  strategy_name TEXT NOT NULL, -- User-defined name (e.g., "AAPL Bull Call Spread")
  strategy_type TEXT NOT NULL CHECK(strategy_type IN (
    'call_spread', 'put_spread', -- Vertical spreads
    'straddle', 'strangle', -- Volatility strategies
    'butterfly', 'condor', -- Complex spreads
    'covered_call', 'protective_put', -- Basic strategies
    'iron_condor', 'calendar_spread', -- Advanced strategies
    'custom' -- User-defined custom strategy
  )),
  symbol TEXT NOT NULL, -- Underlying symbol
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'partial')),
  -- Legs (stored as JSON array of option_symbols)
  legs TEXT NOT NULL, -- JSON: [{"option_symbol": "...", "qty": 1, "side": "buy"}, ...]
  -- P/L Tracking
  total_cost REAL, -- Total cost to open
  current_value REAL, -- Current market value
  max_profit REAL, -- Theoretical max profit
  max_loss REAL, -- Theoretical max loss
  breakeven_points TEXT, -- JSON array of breakeven prices
  -- Risk Metrics
  total_delta REAL, -- Sum of deltas across all legs
  total_theta REAL, -- Sum of thetas (time decay)
  total_vega REAL, -- Sum of vegas (volatility exposure)
  -- Metadata
  opened_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT,
  notes TEXT, -- User notes
  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE
);

CREATE INDEX idx_options_strategies_account ON trading_options_strategies(trading_account_id);
CREATE INDEX idx_options_strategies_symbol ON trading_options_strategies(symbol);
CREATE INDEX idx_options_strategies_status ON trading_options_strategies(status);

-- ============================================================================
-- OPTIONS ANALYTICS TABLE
-- ============================================================================
-- Stores historical options performance metrics
CREATE TABLE IF NOT EXISTS trading_options_analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_account_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  option_symbol TEXT NOT NULL,
  strategy_id INTEGER, -- NULL for individual positions
  -- Performance Metrics
  win_rate REAL, -- Percentage of profitable trades
  avg_profit REAL, -- Average profit per trade
  avg_loss REAL, -- Average loss per trade
  profit_factor REAL, -- Total profits / Total losses
  sharpe_ratio REAL, -- Risk-adjusted returns
  max_drawdown REAL, -- Largest peak-to-trough decline
  -- Volume Metrics
  total_trades INTEGER DEFAULT 0,
  winning_trades INTEGER DEFAULT 0,
  losing_trades INTEGER DEFAULT 0,
  total_contracts INTEGER DEFAULT 0,
  -- Metadata
  period_start TEXT, -- Start of analysis period
  period_end TEXT, -- End of analysis period
  calculated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (trading_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (strategy_id) REFERENCES trading_options_strategies(id) ON DELETE SET NULL
);

CREATE INDEX idx_options_analytics_account ON trading_options_analytics(trading_account_id);
CREATE INDEX idx_options_analytics_symbol ON trading_options_analytics(symbol);

-- ============================================================================
-- OPTIONS WATCHLIST TABLE
-- ============================================================================
-- Tracks interesting options contracts (separate from stock watchlist)
CREATE TABLE IF NOT EXISTS trading_options_watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL, -- User who owns this watchlist
  symbol TEXT NOT NULL, -- Underlying symbol
  option_symbol TEXT NOT NULL, -- Full option symbol
  option_type TEXT NOT NULL CHECK(option_type IN ('call', 'put')),
  strike_price REAL NOT NULL,
  expiration_date TEXT NOT NULL,
  -- Alert Settings
  target_price REAL, -- Alert when option reaches this price
  target_iv REAL, -- Alert when IV reaches this level
  alert_enabled INTEGER DEFAULT 0, -- 1 = enabled, 0 = disabled
  -- Metadata
  added_at TEXT DEFAULT (datetime('now')),
  notes TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_options_watchlist_user ON trading_options_watchlist(user_id);
CREATE INDEX idx_options_watchlist_symbol ON trading_options_watchlist(symbol);
CREATE INDEX idx_options_watchlist_option_symbol ON trading_options_watchlist(option_symbol);

-- ============================================================================
-- CLEANUP OLD CACHE ENTRIES (for periodic maintenance)
-- ============================================================================
-- Run this via cron job every 10 minutes to clean expired cache
-- DELETE FROM trading_options_chain_cache WHERE expires_at < datetime('now');
