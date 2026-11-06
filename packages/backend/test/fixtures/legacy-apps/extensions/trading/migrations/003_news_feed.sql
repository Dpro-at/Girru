-- Trading News Feed Migration
-- Adds: News cache, Sentiment analysis, Earnings calendar

-- ============================================================================
-- NEWS ARTICLES CACHE
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_news_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Article Identity
  article_id TEXT UNIQUE NOT NULL, -- Benzinga article ID
  headline TEXT NOT NULL,
  summary TEXT,
  content TEXT,
  author TEXT,

  -- Source & URL
  source TEXT DEFAULT 'Benzinga',
  url TEXT,
  images TEXT, -- JSON array of image URLs

  -- Symbols & Topics
  symbols TEXT, -- JSON array of stock symbols ["AAPL", "TSLA"]

  -- Sentiment (if available from Benzinga or analyzed)
  sentiment TEXT CHECK(sentiment IN ('positive', 'negative', 'neutral', NULL)),
  sentiment_score REAL, -- -1.0 to 1.0

  -- Timestamps
  created_at TEXT NOT NULL, -- Article publication time (from Benzinga)
  updated_at TEXT,
  fetched_at TEXT DEFAULT (datetime('now')) -- When we cached it
);

CREATE INDEX IF NOT EXISTS idx_news_articles_id ON trading_news_articles(article_id);
CREATE INDEX IF NOT EXISTS idx_news_articles_created ON trading_news_articles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_articles_symbols ON trading_news_articles(symbols);
CREATE INDEX IF NOT EXISTS idx_news_articles_sentiment ON trading_news_articles(sentiment);

-- ============================================================================
-- NEWS SYMBOLS INDEX (For Fast Symbol Filtering)
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_news_symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,
  symbol TEXT NOT NULL,

  FOREIGN KEY (article_id) REFERENCES trading_news_articles(article_id) ON DELETE CASCADE,
  UNIQUE(article_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_news_symbols_symbol ON trading_news_symbols(symbol);
CREATE INDEX IF NOT EXISTS idx_news_symbols_article ON trading_news_symbols(article_id);

-- ============================================================================
-- EARNINGS CALENDAR
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_earnings_calendar (
  id TEXT PRIMARY KEY,

  -- Company Info
  symbol TEXT NOT NULL,
  company_name TEXT,

  -- Earnings Details
  fiscal_period TEXT, -- Q1, Q2, Q3, Q4
  fiscal_year INTEGER,

  -- Dates
  report_date DATE NOT NULL, -- Actual/Expected report date
  fiscal_quarter_end DATE,

  -- Estimates & Actuals
  eps_estimate REAL, -- Earnings Per Share estimate
  eps_actual REAL, -- Actual EPS (if reported)
  revenue_estimate REAL, -- Revenue estimate
  revenue_actual REAL, -- Actual revenue (if reported)

  -- Status
  status TEXT DEFAULT 'upcoming' CHECK(status IN ('upcoming', 'reported')),

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_earnings_symbol ON trading_earnings_calendar(symbol);
CREATE INDEX IF NOT EXISTS idx_earnings_date ON trading_earnings_calendar(report_date);
CREATE INDEX IF NOT EXISTS idx_earnings_status ON trading_earnings_calendar(status);

-- ============================================================================
-- USER NEWS PREFERENCES
-- ============================================================================

CREATE TABLE IF NOT EXISTS trading_news_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,

  -- Filter Preferences
  followed_symbols TEXT, -- JSON array of symbols to prioritize
  excluded_sources TEXT, -- JSON array of sources to exclude

  -- Display Preferences
  show_sentiment INTEGER DEFAULT 1,
  auto_refresh INTEGER DEFAULT 1,
  refresh_interval INTEGER DEFAULT 300, -- seconds (5 min default)

  -- Notifications
  notify_on_earnings INTEGER DEFAULT 0,
  notify_on_high_impact INTEGER DEFAULT 0,

  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_news_prefs_user ON trading_news_preferences(user_id);
