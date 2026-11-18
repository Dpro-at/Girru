-- Logical delivery/review/provenance only; application domains remain their existing stores.
CREATE TABLE computer_sync_records (
 local_device_id TEXT NOT NULL,record_id TEXT NOT NULL,peer_id TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(id),
 epoch INTEGER NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('in','out')),category TEXT NOT NULL,logical_id TEXT NOT NULL,
 revision INTEGER NOT NULL,parent_hash TEXT,content_hash TEXT NOT NULL,payload_json TEXT NOT NULL,
 state TEXT NOT NULL,review_json TEXT,approval_id TEXT,operation_id TEXT,result_json TEXT,
 PRIMARY KEY(local_device_id,record_id)
);
CREATE TABLE computer_sync_bindings (
 local_device_id TEXT NOT NULL,peer_id TEXT NOT NULL,category TEXT NOT NULL,logical_id TEXT NOT NULL,
 local_binding_json TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,content_hash TEXT,
 PRIMARY KEY(local_device_id,peer_id,category,logical_id)
);
CREATE TABLE computer_execution_leases (
 local_device_id TEXT NOT NULL,task_id TEXT NOT NULL,fence TEXT NOT NULL,epoch INTEGER NOT NULL,
 expires_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(local_device_id,task_id)
);
CREATE TABLE computer_sync_selections (
 local_device_id TEXT NOT NULL,peer_id TEXT NOT NULL,category TEXT NOT NULL,logical_id TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id),selection_json TEXT NOT NULL,revision INTEGER NOT NULL,content_hash TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 PRIMARY KEY(local_device_id,peer_id,category,logical_id)
);
ALTER TABLE workspace_control_operations ADD COLUMN admission_guard_json TEXT;

ALTER TABLE computer_attempts ADD COLUMN source_session_id TEXT;
ALTER TABLE computer_attempts ADD COLUMN source_card_id TEXT;
CREATE TABLE computer_sync_effect_locks (
 local_device_id TEXT NOT NULL,peer_id TEXT NOT NULL,category TEXT NOT NULL,logical_id TEXT NOT NULL,
 record_id TEXT NOT NULL,state TEXT NOT NULL,
 PRIMARY KEY(local_device_id,peer_id,category,logical_id)
);
