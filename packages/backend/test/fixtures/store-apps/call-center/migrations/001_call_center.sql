CREATE TABLE IF NOT EXISTS app_call_center__call_analytics (
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

  FOREIGN KEY (call_session_id) REFERENCES app_call_center__call_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (call_point_id) REFERENCES app_call_center__call_points(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS app_call_center__call_campaigns (
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

  FOREIGN KEY (call_point_id) REFERENCES app_call_center__call_points(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS app_call_center__call_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  call_session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('caller', 'agent', 'system')),  -- Who said this
  content TEXT NOT NULL,  -- Message text
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  audio_url TEXT,  -- Individual message audio chunk (optional)

  FOREIGN KEY (call_session_id) REFERENCES app_call_center__call_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_call_center__call_point_knowledge (
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

  FOREIGN KEY (call_point_id) REFERENCES app_call_center__call_points(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_call_center__call_point_templates (
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

CREATE TABLE IF NOT EXISTS app_call_center__call_points (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  description TEXT,
  phone_number_id TEXT,  -- FK to app_call_center__phone_numbers.id
  agent_id TEXT,  -- FK to agents_config.id
  workflow_id TEXT,  -- FK to workflows.id (optional)

  -- Voice Settings (can override user's avatar settings)
  voice_provider TEXT DEFAULT 'openai',  -- openai, local
  voice_id TEXT DEFAULT 'alloy',  -- alloy, echo, fable, onyx, nova, shimmer
  language_preference TEXT DEFAULT 'auto',  -- auto, ar, en

  -- Call Routing Settings
  greeting_message TEXT DEFAULT 'Hello, how can I help you?',
  ivr_menu TEXT,  -- JSON: IVR menu tree structure
  max_call_duration INTEGER DEFAULT 600,  -- seconds (10 min default)
  record_calls INTEGER DEFAULT 1,  -- 0=no, 1=yes
  transcription_provider TEXT DEFAULT 'whisper',  -- whisper, twilio, both, none

  -- Business Hours & Routing
  business_hours TEXT,  -- JSON: {"mon":{"start":"09:00","end":"17:00"},"tue":{...},...}
  after_hours_message TEXT DEFAULT 'We are currently closed. Please call back during business hours.',
  transfer_number TEXT,  -- Fallback number if agent fails

  -- Status
  enabled INTEGER DEFAULT 1,  -- 0=disabled, 1=enabled
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')), template_id TEXT, linked_chat_room_id TEXT, max_concurrent_calls INTEGER DEFAULT 5, queue_enabled BOOLEAN DEFAULT 1, queue_music_url TEXT, queue_announcement_interval INTEGER DEFAULT 30,

  FOREIGN KEY (phone_number_id) REFERENCES app_call_center__phone_numbers(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE SET NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS app_call_center__call_queue (
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

  FOREIGN KEY (call_point_id) REFERENCES app_call_center__call_points(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_call_center__call_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  call_point_id TEXT,  -- FK to app_call_center__call_points.id
  direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),

  -- Call Participants
  from_number TEXT NOT NULL,  -- E.164 format
  to_number TEXT NOT NULL,    -- E.164 format
  caller_name TEXT,            -- Caller ID name (if available)

  -- Provider Metadata
  call_sid TEXT UNIQUE,  -- Twilio/Google Call SID
  provider TEXT DEFAULT 'twilio',  -- Which provider handled this call
  status TEXT DEFAULT 'queued',  -- queued, ringing, in-progress, completed, failed, busy, no-answer, cancelled

  -- Timing
  started_at TEXT,   -- Call initiated
  answered_at TEXT,  -- Call answered
  ended_at TEXT,     -- Call ended
  duration_seconds INTEGER,  -- Total call duration

  -- Content
  recording_url TEXT,  -- Provider's cloud recording URL (temporary)
  recording_file_id TEXT,  -- FK to storage_files.id (local permanent copy)
  transcript TEXT,  -- Full conversation transcript (post-call)

  -- AI Interaction
  agent_id TEXT,  -- Which agent handled this call
  workflow_execution_id TEXT,  -- FK to workflow_executions.id (if workflow triggered)
  conversation_summary TEXT,  -- AI-generated summary

  created_at TEXT DEFAULT (datetime('now')), transcript_file_id TEXT, analytics_id TEXT, post_call_workflow_id TEXT, provider_type TEXT DEFAULT 'twilio', teams_call_id TEXT, sip_from TEXT, sip_to TEXT,

  FOREIGN KEY (call_point_id) REFERENCES app_call_center__call_points(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE SET NULL,
  FOREIGN KEY (workflow_execution_id) REFERENCES workflow_executions(id) ON DELETE SET NULL,
  FOREIGN KEY (recording_file_id) REFERENCES storage_files(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS app_call_center__campaign_analytics (
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

  FOREIGN KEY (campaign_id) REFERENCES app_call_center__call_campaigns(id) ON DELETE CASCADE,
  UNIQUE(campaign_id, date)              -- One record per campaign per day
);

CREATE TABLE IF NOT EXISTS app_call_center__campaign_contacts (
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
  call_session_id TEXT,                  -- Link to app_call_center__call_sessions table

  -- Metadata
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (campaign_id) REFERENCES app_call_center__call_campaigns(id) ON DELETE CASCADE,
  FOREIGN KEY (call_session_id) REFERENCES app_call_center__call_sessions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS app_call_center__phone_number_usage (
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
  FOREIGN KEY (phone_number_id) REFERENCES app_call_center__phone_numbers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_call_center__phone_numbers (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  phone_number TEXT NOT NULL UNIQUE,  -- E.164 format: +14155552671
  friendly_name TEXT,
  country_code TEXT,  -- US, SA, GB, etc.
  capabilities TEXT,  -- JSON: {"voice":true,"sms":true,"mms":false}
  provider TEXT DEFAULT 'twilio',  -- twilio, google, vonage
  provider_sid TEXT,  -- Provider's unique identifier (e.g. Twilio number SID)
  status TEXT DEFAULT 'active',  -- active, suspended, released
  monthly_cost REAL,  -- USD cost per month
  purchased_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
, provider_type TEXT DEFAULT 'twilio' CHECK(provider_type IN ('twilio', 'microsoft_teams', 'vonage', 'plivo')), teams_user_id TEXT, teams_resource_account_id TEXT, sip_uri TEXT, total_calls INTEGER DEFAULT 0, total_inbound_calls INTEGER DEFAULT 0, total_outbound_calls INTEGER DEFAULT 0, total_duration_seconds INTEGER DEFAULT 0, total_inbound_duration_seconds INTEGER DEFAULT 0, total_outbound_duration_seconds INTEGER DEFAULT 0, total_cost_spent REAL DEFAULT 0.0, estimated_monthly_cost REAL DEFAULT 0.0, last_used_at TEXT, last_sync_at TEXT, voice TEXT DEFAULT 'Polly.Joanna', language TEXT DEFAULT 'en-US', tts_provider TEXT DEFAULT 'twilio', provider_api_key TEXT, stt_provider TEXT DEFAULT 'twilio', stt_provider_api_key TEXT);

CREATE TABLE IF NOT EXISTS app_call_center__provider_health_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  provider_id TEXT NOT NULL,
  check_type TEXT CHECK(check_type IN ('api', 'connectivity', 'auth', 'webhook')),
  status TEXT CHECK(status IN ('success', 'failure', 'timeout')),
  response_time_ms INTEGER,
  error_message TEXT,
  checked_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES app_call_center__telephony_providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_call_center__provider_usage_stats (
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
  FOREIGN KEY (provider_id) REFERENCES app_call_center__telephony_providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_call_center__telephony_providers (
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

CREATE INDEX IF NOT EXISTS app_call_center__idx_analytics_campaign_date ON app_call_center__campaign_analytics(campaign_id, date DESC);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_analytics_csat ON app_call_center__call_analytics(csat_score);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_analytics_point ON app_call_center__call_analytics(call_point_id, created_at);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_analytics_sentiment ON app_call_center__call_analytics(sentiment_label);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_knowledge_category ON app_call_center__call_point_knowledge(category);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_knowledge_point ON app_call_center__call_point_knowledge(call_point_id, is_active);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_messages_role ON app_call_center__call_messages(role);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_messages_session ON app_call_center__call_messages(call_session_id);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_messages_timestamp ON app_call_center__call_messages(timestamp);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_points_agent ON app_call_center__call_points(agent_id);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_points_enabled ON app_call_center__call_points(enabled);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_points_phone ON app_call_center__call_points(phone_number_id);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_points_workflow ON app_call_center__call_points(workflow_id);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_queue_queued ON app_call_center__call_queue(queued_at);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_queue_status ON app_call_center__call_queue(call_point_id, status, priority DESC);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_sessions_call_point ON app_call_center__call_sessions(call_point_id);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_sessions_call_sid ON app_call_center__call_sessions(call_sid);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_sessions_created ON app_call_center__call_sessions(created_at);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_sessions_direction ON app_call_center__call_sessions(direction);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_sessions_from ON app_call_center__call_sessions(from_number);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_sessions_provider ON app_call_center__call_sessions(provider_type);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_sessions_status ON app_call_center__call_sessions(status);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_sessions_teams_call ON app_call_center__call_sessions(teams_call_id);

CREATE INDEX IF NOT EXISTS app_call_center__idx_call_sessions_to ON app_call_center__call_sessions(to_number);

CREATE INDEX IF NOT EXISTS app_call_center__idx_campaign_point ON app_call_center__call_campaigns(call_point_id, status);

CREATE INDEX IF NOT EXISTS app_call_center__idx_campaign_status ON app_call_center__call_campaigns(status, start_at);

CREATE INDEX IF NOT EXISTS app_call_center__idx_contact_campaign_status ON app_call_center__campaign_contacts(campaign_id, status);

CREATE INDEX IF NOT EXISTS app_call_center__idx_contact_next_retry ON app_call_center__campaign_contacts(next_retry_at, status);

CREATE INDEX IF NOT EXISTS app_call_center__idx_contact_result ON app_call_center__campaign_contacts(campaign_id, call_result);

CREATE INDEX IF NOT EXISTS app_call_center__idx_phone_numbers_provider ON app_call_center__phone_numbers(provider);

CREATE INDEX IF NOT EXISTS app_call_center__idx_phone_numbers_sip ON app_call_center__phone_numbers(sip_uri);

CREATE INDEX IF NOT EXISTS app_call_center__idx_phone_numbers_status ON app_call_center__phone_numbers(status);

CREATE INDEX IF NOT EXISTS app_call_center__idx_phone_numbers_stt_provider ON app_call_center__phone_numbers(stt_provider);

CREATE INDEX IF NOT EXISTS app_call_center__idx_phone_numbers_teams_resource ON app_call_center__phone_numbers(teams_resource_account_id);

CREATE INDEX IF NOT EXISTS app_call_center__idx_phone_numbers_teams_user ON app_call_center__phone_numbers(teams_user_id);

CREATE INDEX IF NOT EXISTS app_call_center__idx_phone_usage_date ON app_call_center__phone_number_usage(date);

CREATE INDEX IF NOT EXISTS app_call_center__idx_phone_usage_number ON app_call_center__phone_number_usage(phone_number_id);

CREATE INDEX IF NOT EXISTS app_call_center__idx_provider_health_checked ON app_call_center__provider_health_log(checked_at);

CREATE INDEX IF NOT EXISTS app_call_center__idx_provider_health_provider ON app_call_center__provider_health_log(provider_id);

CREATE INDEX IF NOT EXISTS app_call_center__idx_provider_usage_date ON app_call_center__provider_usage_stats(date);

CREATE INDEX IF NOT EXISTS app_call_center__idx_provider_usage_provider ON app_call_center__provider_usage_stats(provider_id);
