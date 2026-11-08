-- Canonical provider identity, never an email-based automatic account merge.
CREATE TABLE user_identity_providers (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL,
 mapping_version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 PRIMARY KEY(issuer,subject),
 UNIQUE(user_id,issuer)
);
