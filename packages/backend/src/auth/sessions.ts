/**
 * Signed-in devices (Settings › Account › Signed in).
 *
 * Every sign-in token carries a random id (jti). At sign-in a row is kept with
 * only a hash of that id, a short device label (never the raw browser text),
 * and the times. Signing out one device marks its row revoked; the token check
 * (auth/jwt.ts) then refuses that token. "Sign out everywhere" still bumps the
 * account's token_version, which ends tokens that have no row too.
 */
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { sql, one, all, run } from '../repositories/sql-steps.js';
import { getDatabase } from '../db/index.js';
import { dbDriver } from '../db/pg/config.js';

const tokenHash = (jti: string) => createHash('sha256').update(JSON.stringify(['auth-session-v1', jti])).digest('hex');
const TOUCH_GAP_MS = 5 * 60_000;
const KEEP_PER_USER = 50;
const touched = new Map<string, number>();

export type DeviceSession = { id: string; label: string; createdAt: number; lastSeenAt: number; current: boolean };

/** A short, plain device name from the browser's own description. */
export function deviceLabel(userAgent: unknown): string {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 400) : '';
  const system = /iPhone|iPad/.test(ua) ? (ua.includes('iPad') ? 'iPad' : 'iPhone') : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const app = /Electron|Girru/i.test(ua) ? 'Girru app' : /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : (/^node/i.test(ua) || /undici|curl/i.test(ua)) ? 'A program' : '';
  if (!app && !system) return 'Unknown device';
  return app && system ? `${app} on ${system}` : app || system;
}

const LABEL = /^(?:Unknown device|(?:Girru app|Edge|Firefox|Chrome|Safari|A program)(?: on (?:iPhone|iPad|Android|Mac|Windows|Linux))?|iPhone|iPad|Android|Mac|Windows|Linux)$/;
/**
 * The device name for a sign-in: the local bridge sends only a short label it
 * worked out itself (header x-dpro-device-label, never the raw browser text);
 * a direct caller is named from its own browser text.
 */
export function signInLabel(headers: Record<string, unknown>): string {
  const sent = headers['x-dpro-device-label'];
  return typeof sent === 'string' && LABEL.test(sent) ? sent : deviceLabel(headers['user-agent']);
}

/** Called once a sign-in token is made. */
export async function recordSession(token: string, device: unknown, now = Date.now()): Promise<void> {
  // A ready label (from signInLabel) is kept; anything else is treated as browser text.
  const label = typeof device === 'string' && LABEL.test(device) ? device : deviceLabel(device);
  const decoded = jwt.decode(token) as { jti?: unknown; userId?: unknown; tokenVersion?: unknown; exp?: unknown } | null;
  if (!decoded || typeof decoded.jti !== 'string' || typeof decoded.userId !== 'string' || typeof decoded.exp !== 'number') return;
  const userId = decoded.userId, version = Number(decoded.tokenVersion ?? 1);
  await sql().tx(function* () {
    // A row is deleted only once its token has expired: a signed-out row must outlive its token.
    yield* run('DELETE FROM auth_sessions WHERE user_id=? AND expires_at<?', userId, now);
    yield* run('INSERT INTO auth_sessions(id,user_id,token_hash,token_version,label,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      randomBytes(12).toString('hex'), userId, tokenHash(decoded.jti as string), version, label, now, now, Math.round((decoded.exp as number) * 1000));
    // At most 50 devices stay signed in: older ones are signed out (never deleted before they expire).
    yield* run(`UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id NOT IN (SELECT id FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT ${KEEP_PER_USER})`, now, userId, userId);
  });
}

/** True when this token's device was signed out. Tokens without a row are not refused here. */
export async function sessionRevoked(jti: string | undefined, now = Date.now()): Promise<boolean> {
  if (!jti) return false;
  const row = await sql().read(one<{ id: string; revoked_at: number | null }>('SELECT id,revoked_at FROM auth_sessions WHERE token_hash=?', tokenHash(jti)));
  if (!row) return false;
  if (row.revoked_at !== null && row.revoked_at !== undefined) return true;
  const last = touched.get(row.id) ?? 0;
  if (now - last > TOUCH_GAP_MS) { touched.set(row.id, now); await sql().read(run('UPDATE auth_sessions SET last_seen_at=? WHERE id=? AND revoked_at IS NULL', now, row.id)); }
  return false;
}

/** Synchronous form for the SQLite-only path of verifyRequestToken. */
export function sessionRevokedSync(jti: string | undefined): boolean {
  if (!jti || dbDriver() === 'postgres') return false;
  const row = getDatabase().prepare('SELECT revoked_at FROM auth_sessions WHERE token_hash=?').get(tokenHash(jti)) as { revoked_at: number | null } | undefined;
  return !!row && row.revoked_at !== null && row.revoked_at !== undefined;
}

/** The account's devices that can still use their sign-in, newest first. */
export async function listSessions(userId: string, currentJti: string | undefined, now = Date.now()): Promise<DeviceSession[]> {
  const rows = await sql().read(all<{ id: string; token_hash: string; label: string; created_at: number; last_seen_at: number }>(
    'SELECT s.id,s.token_hash,s.label,s.created_at,s.last_seen_at FROM auth_sessions s JOIN users u ON u.id=s.user_id WHERE s.user_id=? AND s.revoked_at IS NULL AND s.expires_at>? AND s.token_version=u.token_version ORDER BY s.last_seen_at DESC', userId, now));
  const mine = currentJti ? tokenHash(currentJti) : '';
  return rows.map(r => ({ id: r.id, label: r.label, createdAt: Number(r.created_at), lastSeenAt: Number(r.last_seen_at), current: r.token_hash === mine }));
}

/** Signs out one device of this account. Returns false when there is no such live device. */
export async function revokeSession(userId: string, id: string, now = Date.now()): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/.test(id)) return false;
  return (await sql().read(run('UPDATE auth_sessions SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL', now, id, userId))).changes === 1;
}

/** Shared one-way token identity for internal authenticated database checkpoints. */
export {tokenHash as authSessionTokenHash};
