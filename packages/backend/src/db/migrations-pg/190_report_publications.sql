-- External prepared results are distinct from provider-run outcomes. Receipts outlive snapshots.
CREATE TABLE display_report_publications (
 owner_id TEXT NOT NULL REFERENCES users(id),
 report_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 payload_hash TEXT NOT NULL,
 snapshot_id TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind = 'external_prepared'),
 published_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,report_id,request_id),
 UNIQUE(snapshot_id)
);
