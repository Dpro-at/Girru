-- ═══════════════════════════════════════════════════════════════════════════
-- Call Center Professional - Migration 002
-- Professional features: Templates, Knowledge Base, Analytics, Queue
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Table 1: Industry Templates ────────────────────────────────────────────
-- Pre-configured setups for different business types
CREATE TABLE IF NOT EXISTS call_point_templates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('support', 'sales', 'restaurant', 'medical', 'ecommerce', 'generic')),
  description TEXT,

  -- Pre-configured settings
  default_system_prompt TEXT,
  default_ivr_menu TEXT,              -- JSON: [{"digit":"1","action":"continue","label":"Support"}]
  default_business_hours TEXT,        -- JSON: {"monday":{"open":"09:00","close":"17:00"}}
  default_knowledge_base TEXT,        -- JSON: [{question, answer, keywords}]

  -- Voice settings
  default_voice_provider TEXT DEFAULT 'edge-tts' CHECK(default_voice_provider IN ('edge-tts', 'openai')),
  default_voice_id TEXT DEFAULT 'en-US-JennyNeural',
  default_language TEXT DEFAULT 'en' CHECK(default_language IN ('en', 'ar', 'auto')),

  -- Metadata
  icon TEXT,
  is_system BOOLEAN DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ── Table 2: Call Point Knowledge Base ─────────────────────────────────────
-- FAQ, scripts, policies per Call Point
CREATE TABLE IF NOT EXISTS call_point_knowledge (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  call_point_id TEXT NOT NULL,

  category TEXT NOT NULL CHECK(category IN ('faq', 'product', 'policy', 'script')),
  question TEXT,
  answer TEXT NOT NULL,
  keywords TEXT,                      -- comma-separated for search

  priority INTEGER DEFAULT 0,         -- higher = more important
  is_active BOOLEAN DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (call_point_id) REFERENCES call_points(id) ON DELETE CASCADE
);

-- ── Table 3: Call Analytics ────────────────────────────────────────────────
-- Sentiment, CSAT, cost per call
CREATE TABLE IF NOT EXISTS call_analytics (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  call_session_id TEXT NOT NULL UNIQUE,
  call_point_id TEXT NOT NULL,
  agent_id TEXT,

  -- Conversation metrics
  total_messages INTEGER DEFAULT 0,
  avg_response_time_ms INTEGER,
  total_duration_seconds INTEGER,

  -- Sentiment analysis (keyword-based)
  sentiment_score REAL,               -- -1.0 (very negative) to 1.0 (very positive)
  sentiment_label TEXT CHECK(sentiment_label IN ('positive', 'neutral', 'negative')),
  detected_emotions TEXT,             -- JSON: ["frustrated", "satisfied", "urgent"]

  -- Quality metrics
  agent_interruptions INTEGER DEFAULT 0,
  silence_periods INTEGER DEFAULT 0,
  language_detected TEXT,

  -- Outcomes
  issue_resolved BOOLEAN,
  transfer_occurred BOOLEAN DEFAULT 0,
  csat_score INTEGER CHECK(csat_score BETWEEN 1 AND 5),
  csat_feedback TEXT,

  -- Cost tracking
  model_used TEXT,
  estimated_cost REAL,
  input_tokens INTEGER,
  output_tokens INTEGER,

  created_at TEXT DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (call_session_id) REFERENCES call_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (call_point_id) REFERENCES call_points(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE SET NULL
);

-- ── Table 4: Call Queue ─────────────────────────────────────────────────────
-- Overflow management when agents are busy
CREATE TABLE IF NOT EXISTS call_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  call_point_id TEXT NOT NULL,

  -- Caller info
  from_number TEXT NOT NULL,
  caller_name TEXT,

  -- Queue state
  status TEXT DEFAULT 'waiting' CHECK(status IN ('waiting', 'connected', 'abandoned', 'completed')),
  position INTEGER,
  estimated_wait_seconds INTEGER,

  -- Priority (VIP callers)
  priority INTEGER DEFAULT 0,
  callback_requested BOOLEAN DEFAULT 0,
  callback_number TEXT,

  -- Timestamps
  queued_at TEXT DEFAULT CURRENT_TIMESTAMP,
  connected_at TEXT,
  completed_at TEXT,
  wait_duration_seconds INTEGER,

  -- Context preservation for handoff from chat
  initial_message TEXT,
  context_data TEXT,                  -- JSON: previous chat messages, extracted info

  FOREIGN KEY (call_point_id) REFERENCES call_points(id) ON DELETE CASCADE
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_call_knowledge_point ON call_point_knowledge(call_point_id, is_active);
CREATE INDEX IF NOT EXISTS idx_call_knowledge_category ON call_point_knowledge(category);
CREATE INDEX IF NOT EXISTS idx_call_analytics_point ON call_analytics(call_point_id, created_at);
CREATE INDEX IF NOT EXISTS idx_call_analytics_sentiment ON call_analytics(sentiment_label);
CREATE INDEX IF NOT EXISTS idx_call_analytics_csat ON call_analytics(csat_score);
CREATE INDEX IF NOT EXISTS idx_call_queue_status ON call_queue(call_point_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_call_queue_queued ON call_queue(queued_at);

-- ── Extend call_points table ────────────────────────────────────────────────
ALTER TABLE call_points ADD COLUMN template_id TEXT;
ALTER TABLE call_points ADD COLUMN linked_chat_room_id TEXT;
ALTER TABLE call_points ADD COLUMN max_concurrent_calls INTEGER DEFAULT 5;
ALTER TABLE call_points ADD COLUMN queue_enabled BOOLEAN DEFAULT 1;
ALTER TABLE call_points ADD COLUMN queue_music_url TEXT;
ALTER TABLE call_points ADD COLUMN queue_announcement_interval INTEGER DEFAULT 30;

-- ── Extend public_chat_rooms table (bidirectional linking) ─────────────────
-- Note: This may fail if public_chat_rooms doesn't exist yet (extension disabled)
-- We'll handle this gracefully in the application code
-- ALTER TABLE public_chat_rooms ADD COLUMN linked_call_point_id TEXT;

-- ── Extend call_sessions table ──────────────────────────────────────────────
ALTER TABLE call_sessions ADD COLUMN transcript_file_id TEXT;
ALTER TABLE call_sessions ADD COLUMN analytics_id TEXT;
ALTER TABLE call_sessions ADD COLUMN post_call_workflow_id TEXT;

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 002 Complete
-- ═══════════════════════════════════════════════════════════════════════════
