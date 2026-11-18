-- Migration 026: Telephony System (Assistant Center / Call Center)
-- Complete phone call handling infrastructure with Twilio/Google Voice integration

-- ══════════════════════════════════════════════════════════════════════════════
-- PHONE NUMBERS TABLE
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS phone_numbers (
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
);

CREATE INDEX IF NOT EXISTS idx_phone_numbers_status ON phone_numbers(status);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_provider ON phone_numbers(provider);

-- ══════════════════════════════════════════════════════════════════════════════
-- CALL POINTS TABLE
-- ══════════════════════════════════════════════════════════════════════════════
-- Each call point is like a virtual call center employee
CREATE TABLE IF NOT EXISTS call_points (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  description TEXT,
  phone_number_id TEXT,  -- FK to phone_numbers.id
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
  updated_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (phone_number_id) REFERENCES phone_numbers(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE SET NULL,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_call_points_phone ON call_points(phone_number_id);
CREATE INDEX IF NOT EXISTS idx_call_points_agent ON call_points(agent_id);
CREATE INDEX IF NOT EXISTS idx_call_points_workflow ON call_points(workflow_id);
CREATE INDEX IF NOT EXISTS idx_call_points_enabled ON call_points(enabled);

-- ══════════════════════════════════════════════════════════════════════════════
-- CALL SESSIONS TABLE
-- ══════════════════════════════════════════════════════════════════════════════
-- Complete record of every phone call (inbound + outbound)
CREATE TABLE IF NOT EXISTS call_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  call_point_id TEXT,  -- FK to call_points.id
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

  created_at TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (call_point_id) REFERENCES call_points(id) ON DELETE SET NULL,
  FOREIGN KEY (agent_id) REFERENCES agents_config(id) ON DELETE SET NULL,
  FOREIGN KEY (workflow_execution_id) REFERENCES workflow_executions(id) ON DELETE SET NULL,
  FOREIGN KEY (recording_file_id) REFERENCES storage_files(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_call_point ON call_sessions(call_point_id);
CREATE INDEX IF NOT EXISTS idx_call_sessions_direction ON call_sessions(direction);
CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status);
CREATE INDEX IF NOT EXISTS idx_call_sessions_created ON call_sessions(created_at);
CREATE INDEX IF NOT EXISTS idx_call_sessions_call_sid ON call_sessions(call_sid);
CREATE INDEX IF NOT EXISTS idx_call_sessions_from ON call_sessions(from_number);
CREATE INDEX IF NOT EXISTS idx_call_sessions_to ON call_sessions(to_number);

-- ══════════════════════════════════════════════════════════════════════════════
-- CALL MESSAGES TABLE
-- ══════════════════════════════════════════════════════════════════════════════
-- Individual messages within a call (caller <-> agent conversation)
CREATE TABLE IF NOT EXISTS call_messages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  call_session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('caller', 'agent', 'system')),  -- Who said this
  content TEXT NOT NULL,  -- Message text
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  audio_url TEXT,  -- Individual message audio chunk (optional)

  FOREIGN KEY (call_session_id) REFERENCES call_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_call_messages_session ON call_messages(call_session_id);
CREATE INDEX IF NOT EXISTS idx_call_messages_role ON call_messages(role);
CREATE INDEX IF NOT EXISTS idx_call_messages_timestamp ON call_messages(timestamp);
