-- Local policy acceptance evidence; no Google token, IP address or workspace content.
CREATE TABLE IF NOT EXISTS user_legal_acceptances (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 policy_version TEXT NOT NULL,
 content_sha256 TEXT NOT NULL,
 locale TEXT NOT NULL,
 effective_at TEXT NOT NULL,
 accepted_at TEXT NOT NULL,
 terms_url TEXT NOT NULL,
 privacy_url TEXT NOT NULL,
 PRIMARY KEY (user_id, policy_version, content_sha256)
);
