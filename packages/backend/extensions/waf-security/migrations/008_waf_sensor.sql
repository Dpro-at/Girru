-- The optional server sensor: pairing, and the alerts it pushes.
--
-- The owner installs a small sensor on a server they own. It is paired with a signed token; Dpro
-- stores only the hash of that token, never the secret, and never any server credential. The link
-- is outbound-only: the sensor pushes alerts to Dpro over its public API. Dpro never connects to,
-- logs into, or runs anything on the server; it cannot control it. Alerts land here and flow into
-- Dpro's own notification system.

CREATE TABLE IF NOT EXISTS app_waf_security__sensors (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,              -- the owner/admin who paired it
  asset_id     TEXT,                        -- the server asset this sensor reports for
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,               -- sha256 of the pairing token; the token itself is never stored
  token_prefix TEXT NOT NULL,               -- first few chars, to tell sensors apart in the UI
  status       TEXT NOT NULL DEFAULT 'paired' CHECK(status IN ('paired', 'offline', 'revoked')),
  paired_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS app_waf_security__idx_sensors_token ON app_waf_security__sensors(token_hash);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_sensors_user ON app_waf_security__sensors(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_waf_security__sensor_alerts (
  id          TEXT PRIMARY KEY,
  sensor_id   TEXT NOT NULL,
  asset_id    TEXT,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('open-port-change', 'cert-expiry', 'failed-login-spike', 'config-drift', 'new-listener', 'heartbeat')),
  severity    TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'low', 'medium', 'high', 'critical')),
  title       TEXT NOT NULL,
  detail_json TEXT,                          -- the alert payload the sensor sent (data, not commands)
  notified    INTEGER NOT NULL DEFAULT 0,    -- whether a Dpro notification was created for it
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (sensor_id) REFERENCES app_waf_security__sensors(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS app_waf_security__idx_sensor_alerts_user ON app_waf_security__sensor_alerts(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS app_waf_security__idx_sensor_alerts_sensor ON app_waf_security__sensor_alerts(sensor_id, received_at DESC);
