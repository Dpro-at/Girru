CREATE TABLE display_reports (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id),
 request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 session_id TEXT NOT NULL UNIQUE REFERENCES chat_sessions(id),
 title TEXT NOT NULL,
 instructions TEXT NOT NULL,
 agent_id TEXT NOT NULL REFERENCES agents_config(id),
 project_id TEXT,
 revision INTEGER NOT NULL DEFAULT 1,
 presentation_json TEXT NOT NULL,
 latest_snapshot_id TEXT,
 status TEXT NOT NULL DEFAULT 'idle',
 last_error TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(owner_id,request_id)
);
CREATE INDEX display_reports_owner ON display_reports(owner_id,updated_at);
CREATE TABLE display_report_attempts (
 report_id TEXT NOT NULL REFERENCES display_reports(id),
 run_id TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id),
 definition_revision INTEGER NOT NULL,
 parent_run_id TEXT,
 approval_baseline_json TEXT NOT NULL DEFAULT '[]',
 state TEXT NOT NULL,
 started_at TEXT NOT NULL,
 finished_at TEXT,
 error TEXT,
 PRIMARY KEY(report_id,run_id)
);
CREATE TABLE display_report_snapshots (
 id TEXT PRIMARY KEY,
 report_id TEXT NOT NULL REFERENCES display_reports(id),
 owner_id TEXT NOT NULL REFERENCES users(id),
 run_id TEXT NOT NULL,
 definition_revision INTEGER NOT NULL,
 presentation_json TEXT NOT NULL,
 sections_json TEXT NOT NULL,
 captured_at TEXT NOT NULL,
 UNIQUE(report_id,run_id)
);
CREATE INDEX display_report_history ON display_report_snapshots(owner_id,report_id,captured_at);

CREATE TABLE display_report_approval_decisions (
 approval_id TEXT PRIMARY KEY REFERENCES tool_approvals(id),
 report_id TEXT NOT NULL REFERENCES display_reports(id),
 run_id TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id),
 session_id TEXT NOT NULL REFERENCES chat_sessions(id)
);
