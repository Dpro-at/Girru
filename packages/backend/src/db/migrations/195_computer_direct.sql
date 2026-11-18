-- Owner-reviewed direct connection metadata stays on the device, never on the relay.
CREATE TABLE computer_direct_endpoints (
 local_device_id TEXT NOT NULL,
 peer_id TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES users(id),
 epoch INTEGER NOT NULL,
 public_key TEXT NOT NULL,
 endpoint_url TEXT NOT NULL,
 binding_hash TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 PRIMARY KEY(local_device_id,peer_id),
 FOREIGN KEY(local_device_id,peer_id) REFERENCES computer_peers(local_device_id,peer_id)
);
