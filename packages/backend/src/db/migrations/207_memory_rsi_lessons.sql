-- Migration 207: evidence-gated, self-retiring lessons (MEM-RSI-01)
--
-- A lessons layer on top of memory. A lesson exists only with a cue, an
-- action and at least one piece of evidence; it records what closed tasks
-- PROVED, never what a model guessed. It never edits a prompt by itself.
--
--   rsi_lessons           one lesson per (user, cue, action, polarity)
--     cue         MATCH KEY only — derived from (untrusted) run output and
--                 never rendered into a prompt; used to retrieve a lesson
--     action      the text that may be rendered into a prompt; for run
--                 extraction it is a fixed system template (never run text)
--     polarity    positive (confirmed/reproduced) | negative (do not repeat
--                 without a new approach) | caution (recheck before acting)
--     reason_code bounded, SYSTEM-written code behind the action (audit), or
--                 NULL; never free text (see src/memory/rsi/derive.ts)
--     support     number of evidence rows currently confirming it (cached from
--                 rsi_lesson_evidence; a lesson with support 0 is 'retired')
--     status      active (support > 0) | retired (support hit 0; a later
--                 confirmation restores it)
--
--   rsi_lesson_evidence   the proof a lesson stands on, one row per
--                         (lesson, source_kind, source_id) so re-running
--                         extraction can never inflate support (idempotent)
--     disposition  confirmed (counts toward support) | reversed (the finding
--                  was retracted; kept so a re-confirmation restores it)
--
--   rsi_lesson_usage      a log of lessons SELECTED for a prompt: in shadow
--                         mode what WOULD be injected, in inject mode what was
--                         injected. Never written in off mode.
-- Date: 2026-11-17

CREATE TABLE IF NOT EXISTS rsi_lessons (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  cue TEXT NOT NULL,
  action TEXT NOT NULL,
  polarity TEXT NOT NULL CHECK (polarity IN ('positive', 'negative', 'caution')),
  reason_code TEXT,
  support INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, cue, action, polarity)
);
CREATE INDEX IF NOT EXISTS idx_rsi_lessons_user ON rsi_lessons (user_id, status);

CREATE TABLE IF NOT EXISTS rsi_lesson_evidence (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'confirmed' CHECK (disposition IN ('confirmed', 'reversed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lesson_id, source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_rsi_lesson_evidence_lesson ON rsi_lesson_evidence (lesson_id);
CREATE INDEX IF NOT EXISTS idx_rsi_lesson_evidence_source ON rsi_lesson_evidence (user_id, source_kind, source_id);

CREATE TABLE IF NOT EXISTS rsi_lesson_usage (
  id TEXT PRIMARY KEY,
  lesson_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'inject')),
  context TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rsi_lesson_usage_lesson ON rsi_lesson_usage (lesson_id, created_at);
