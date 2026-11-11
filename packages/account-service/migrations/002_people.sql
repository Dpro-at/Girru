-- People (CP17): a fixed public ID and an optional nickname per account, and links between
-- accounts that only exchange tasks. Metadata only: no task, message or file content.
CREATE TABLE IF NOT EXISTS people_profiles(account_id TEXT PRIMARY KEY REFERENCES accounts(id),public_id TEXT NOT NULL UNIQUE,nickname TEXT UNIQUE,nickname_at INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS people_links(id TEXT PRIMARY KEY,from_account TEXT NOT NULL REFERENCES accounts(id),to_account TEXT NOT NULL REFERENCES accounts(id),status TEXT NOT NULL CHECK(status IN ('pending','linked','blocked')),code_seed TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,linked_at INTEGER,UNIQUE(from_account,to_account));
CREATE INDEX IF NOT EXISTS people_links_to ON people_links(to_account,status);
