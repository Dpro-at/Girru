-- Public ownership index for the exact encrypted device-owned control projection.
CREATE TABLE IF NOT EXISTS computer_operation_projection(local_device_id TEXT NOT NULL,operation_id TEXT NOT NULL,PRIMARY KEY(local_device_id,operation_id));
