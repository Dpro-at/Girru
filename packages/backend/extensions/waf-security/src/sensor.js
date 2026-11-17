/**
 * The optional server sensor: pairing and alert ingestion.
 *
 * The owner installs a small sensor on a server they own. Pairing creates a random token shown to
 * the owner once; Dpro keeps only its sha256 hash and a short prefix — never the token itself and
 * never any server credential. The link is outbound-only: the sensor POSTs alerts to Dpro's public
 * API, authenticated by its token. Dpro never connects to the server, never logs in, never runs
 * anything on it, and cannot control it. Alerts are stored and raised as Dpro notifications.
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { sha256Hex } from './evidence.js';
import { getAsset } from './scope.js';

export class SensorError extends Error {}

const ALERT_KINDS = ['open-port-change', 'cert-expiry', 'failed-login-spike', 'config-drift', 'new-listener', 'heartbeat'];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

/**
 * Pair a new sensor. Owner/admin only (route-checked). Returns { sensor, token } — the token is
 * returned ONCE and never stored in clear; the caller shows it to the owner to put on the server.
 */
export function pairSensor(db, userId, { assetId = null, name }) {
  if (!name || typeof name !== 'string') throw new SensorError('A name is required');
  // Ownership gate: a sensor may only be attached to an asset this same user owns (no IDOR on write).
  if (assetId != null) {
    if (!getAsset(db, userId, assetId)) throw new SensorError('That server is not in your list');
  }
  const token = `gss_${randomBytes(24).toString('base64url')}`; // Girru Server Sensor token
  const tokenHash = sha256Hex(token);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO app_waf_security__sensors (id, user_id, asset_id, name, token_hash, token_prefix, status)
     VALUES (?, ?, ?, ?, ?, ?, 'paired')`
  ).run(id, userId, assetId, name, tokenHash, token.slice(0, 12));
  return { sensor: getSensor(db, userId, id), token };
}

export function getSensor(db, userId, id) {
  const s = db.prepare('SELECT id, user_id, asset_id, name, token_prefix, status, paired_at, last_seen_at FROM app_waf_security__sensors WHERE id = ? AND user_id = ?').get(id, userId);
  return s || null;
}

export function listSensors(db, userId) {
  return db.prepare('SELECT id, user_id, asset_id, name, token_prefix, status, paired_at, last_seen_at FROM app_waf_security__sensors WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

/** Revoke a sensor so its token stops working. Reversible only by re-pairing (new token). */
export function revokeSensor(db, userId, id) {
  const r = db.prepare("UPDATE app_waf_security__sensors SET status = 'revoked' WHERE id = ? AND user_id = ?").run(id, userId);
  if (r.changes === 0) throw new SensorError('Sensor not found');
  return { revoked: true };
}

/** Find the sensor a token belongs to (constant-time-ish via hash lookup). Null if none/revoked. */
export function sensorForToken(db, token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
  const s = db.prepare("SELECT * FROM app_waf_security__sensors WHERE token_hash = ? AND status != 'revoked'").get(sha256Hex(token));
  return s || null;
}

/**
 * Ingest one alert pushed by a paired sensor and raise a Dpro notification for its owner.
 * `payload` is data the sensor sent — treated as data, never as instructions. Returns the stored
 * alert id. Called from the inbound (outbound-from-server) push route after the token is verified.
 */
export async function ingestAlert(db, api, sensor, payload = {}) {
  const kind = ALERT_KINDS.includes(payload.kind) ? payload.kind : 'config-drift';
  const severity = SEVERITIES.includes(payload.severity) ? payload.severity : 'info';
  const title = String(payload.title || `Sensor alert: ${kind}`).slice(0, 200);
  const detail = payload.detail != null ? JSON.stringify(payload.detail).slice(0, 8192) : null;

  db.prepare("UPDATE app_waf_security__sensors SET last_seen_at = datetime('now'), status = 'paired' WHERE id = ?").run(sensor.id);

  if (kind === 'heartbeat') return { stored: false, heartbeat: true }; // keep-alive only, no alert row

  const id = randomUUID();
  db.prepare(
    `INSERT INTO app_waf_security__sensor_alerts (id, sensor_id, asset_id, user_id, kind, severity, title, detail_json, notified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(id, sensor.id, sensor.asset_id, sensor.user_id, kind, severity, title, detail);

  // Raise it in Dpro's own notification system.
  try {
    const type = severity === 'critical' || severity === 'high' ? 'warning' : 'info';
    await api.notifications.create({
      userId: sensor.user_id,
      title: `${sensor.name}: ${title}`,
      body: detail ? String(detail).slice(0, 500) : undefined,
      type,
      channel: 'in_app',
      actionUrl: '/dashboard/ext/waf-security',
      meta: { source: 'waf-security-sensor', sensorId: sensor.id, kind, severity },
    });
    db.prepare('UPDATE app_waf_security__sensor_alerts SET notified = 1 WHERE id = ?').run(id);
  } catch (err) {
    api.log('warn', `Could not raise notification for sensor alert: ${err.message}`);
  }
  return { stored: true, id };
}

export function listAlerts(db, userId, limit = 100) {
  return db.prepare('SELECT * FROM app_waf_security__sensor_alerts WHERE user_id = ? ORDER BY received_at DESC LIMIT ?').all(userId, limit);
}
