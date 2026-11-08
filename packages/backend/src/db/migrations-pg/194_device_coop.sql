-- Device-local delivery coordination only; task/session/run content uses existing services.
CREATE TABLE computer_peers (
 local_device_id TEXT NOT NULL,
 peer_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id),
 public_key TEXT NOT NULL,
 name TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),
 PRIMARY KEY(local_device_id,peer_id)
);
CREATE TABLE computer_delivery (
 local_device_id TEXT NOT NULL,
 peer_id TEXT NOT NULL,
 direction TEXT NOT NULL CHECK(direction IN ('in','out')),
 event_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 envelope_json TEXT NOT NULL,
 acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)),
 PRIMARY KEY(local_device_id,direction,event_id)
);
CREATE TABLE computer_attempts (
 local_device_id TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id),
 source_id TEXT NOT NULL,
 target_id TEXT NOT NULL,
 task_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 epoch INTEGER NOT NULL,
 state TEXT NOT NULL,
 fence TEXT NOT NULL,
 session_id TEXT,
 run_id TEXT,
 approval_id TEXT,
 status_sequence INTEGER NOT NULL DEFAULT 0,
 detail TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(local_device_id,task_id),
 UNIQUE(local_device_id,attempt_id),
 UNIQUE(local_device_id,run_id)
);

CREATE TABLE computer_counters (local_device_id TEXT PRIMARY KEY, next_sequence INTEGER NOT NULL);
