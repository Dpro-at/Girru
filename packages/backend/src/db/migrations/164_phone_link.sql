-- MOB-PAIR-01 / MOB-LINK-01: the phone link on the computer (packages/relay/PROTOCOL.md).
--
-- phone_identity   this computer's long-term P-256 identity. The private key
--                  is stored only encrypted (AES-256-GCM, the app's ENCRYPTION_KEY);
--                  one row, id = 'computer'.
-- phone_devices    paired phones. The computer is the only authority on them:
--                  lifetime (NULL = never expires) counts from last_used_at;
--                  last_counter is the last accepted signed-command counter;
--                  notify_counter the last notice counter sent to it. The
--                  notification key and push token are stored encrypted.
--                  A forgotten phone keeps a row with revoked_at set and no keys.
-- phone_settings   small key/value home (phone.relayUrl, phone.lanListen).
-- phone_approvals_shown  which approvals each phone was shown or notified of:
--                  a phone may decide only those (PROTOCOL.md "Approvals from the phone").
-- Times are epoch milliseconds.

CREATE TABLE IF NOT EXISTS phone_identity (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,
  private_key_iv TEXT NOT NULL,
  private_key_tag TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT,
  public_key TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT 'anywhere' CHECK (path IN ('anywhere', 'wifi')),
  lifetime_days INTEGER CHECK (lifetime_days IS NULL OR lifetime_days IN (30, 60, 90, 120)),
  last_counter BIGINT NOT NULL DEFAULT 0,
  notify_counter BIGINT NOT NULL DEFAULT 0,
  notify_key_enc TEXT,
  notify_key_iv TEXT,
  notify_key_tag TEXT,
  push_enc TEXT,
  push_iv TEXT,
  push_tag TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT NOT NULL,
  revoked_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_phone_devices_owner ON phone_devices(owner_id, revoked_at);

CREATE TABLE IF NOT EXISTS phone_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_approvals_shown (
  device_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  shown_at BIGINT NOT NULL,
  PRIMARY KEY (device_id, approval_id)
);
