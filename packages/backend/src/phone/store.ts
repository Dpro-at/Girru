/**
 * Phone link storage (MOB-PAIR-01, migration 164): paired phones, the
 * computer's identity (private key encrypted at rest), settings and which
 * approvals each phone was shown. Both drivers through sql-steps.
 *
 * Secrets (identity private key, notification keys, push tokens) go through
 * the app's encryption service; nothing here logs a value.
 */

import { createPrivateKey, randomBytes, type KeyObject } from 'node:crypto';
import { getEncryptionService } from '../credentials/encryption.js';
import { q } from '../repositories/sql-steps.js';
import { b64url, deviceIdOf, fromB64url, p256PublicKey } from './protocol/encoding.js';
import { PAIRING_LIFETIME_DAYS, createIdentity, publicKeyText, type Identity, type PairingLifetimeDays } from './protocol/e2e.js';

export type PhonePath = 'anywhere' | 'wifi';
export const PHONE_PATHS: readonly PhonePath[] = ['anywhere', 'wifi'];
export const DEFAULT_LIFETIME_DAYS = 90;
export const DEFAULT_RELAY_URL = 'wss://relay.girru.net/v1';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PhoneDevice {
  id: string;
  ownerId: string;
  name: string;
  model: string | null;
  publicKey: KeyObject;
  path: PhonePath;
  lifetimeDays: PairingLifetimeDays;
  lastCounter: number;
  notifyCounter: number;
  createdAt: number;
  lastUsedAt: number;
}

export class PhoneStoreError extends Error {
  constructor(readonly code: string) { super(code); }
}

const n = (v: unknown) => Number(v ?? 0);
const lifetimeOf = (v: unknown): PairingLifetimeDays => (v === null || v === undefined ? null : (n(v) as PairingLifetimeDays));

export const isLifetime = (v: unknown): v is PairingLifetimeDays => (PAIRING_LIFETIME_DAYS as readonly unknown[]).includes(v);
export const isPath = (v: unknown): v is PhonePath => v === 'anywhere' || v === 'wifi';

/** When this pairing runs out (ms), or null for never. Expiry slides from the last use. */
export function expiresAt(d: { lifetimeDays: PairingLifetimeDays; lastUsedAt: number }): number | null {
  return d.lifetimeDays === null ? null : d.lastUsedAt + d.lifetimeDays * DAY_MS;
}

export function isExpired(d: { lifetimeDays: PairingLifetimeDays; lastUsedAt: number }, now = Date.now()): boolean {
  const end = expiresAt(d);
  return end !== null && now > end;
}

function toDevice(r: any): PhoneDevice {
  return {
    id: r.id, ownerId: r.owner_id, name: r.name, model: r.model ?? null,
    publicKey: p256PublicKey(fromB64url(r.public_key)),
    path: r.path === 'wifi' ? 'wifi' : 'anywhere',
    lifetimeDays: lifetimeOf(r.lifetime_days),
    lastCounter: n(r.last_counter), notifyCounter: n(r.notify_counter),
    createdAt: n(r.created_at), lastUsedAt: n(r.last_used_at),
  };
}

const COLS = 'id, owner_id, name, model, public_key, path, lifetime_days, last_counter, notify_counter, created_at, last_used_at';

/** Paired phones that were not forgotten (expired ones included; callers check). */
export async function listDevices(ownerId?: string): Promise<PhoneDevice[]> {
  const rows = ownerId
    ? await q.all(`SELECT ${COLS} FROM phone_devices WHERE revoked_at IS NULL AND owner_id = ? ORDER BY created_at, id`, ownerId)
    : await q.all(`SELECT ${COLS} FROM phone_devices WHERE revoked_at IS NULL ORDER BY created_at, id`);
  return rows.map(toDevice);
}

export async function getDevice(id: string): Promise<PhoneDevice | undefined> {
  const r = await q.one(`SELECT ${COLS} FROM phone_devices WHERE id = ? AND revoked_at IS NULL`, id);
  return r ? toDevice(r) : undefined;
}

async function seal(value: string): Promise<[string, string, string]> {
  const e = await getEncryptionService().encrypt(value);
  return [e.encrypted, e.iv, e.authTag];
}

/** Stores a newly allowed phone (a phone paired again replaces its old row); returns its notification key. */
export async function addDevice(input: {
  id: string; ownerId: string; name: string; model: string | null; publicKey: KeyObject;
  path: PhonePath; lifetimeDays: PairingLifetimeDays; push?: string; now: number;
}): Promise<Buffer> {
  if (deviceIdOf(input.publicKey) !== input.id) throw new PhoneStoreError('wrong_key');
  const notifyKey = randomBytes(32);
  const [ke, ki, kt] = await seal(b64url(notifyKey));
  const push = input.push ? await seal(input.push) : [null, null, null];
  await q.run(
    `INSERT INTO phone_devices (id, owner_id, name, model, public_key, path, lifetime_days, last_counter, notify_counter,
       notify_key_enc, notify_key_iv, notify_key_tag, push_enc, push_iv, push_tag, created_at, last_used_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT (id) DO UPDATE SET owner_id = excluded.owner_id, name = excluded.name, model = excluded.model,
       public_key = excluded.public_key, path = excluded.path, lifetime_days = excluded.lifetime_days,
       last_counter = 0, notify_counter = 0, notify_key_enc = excluded.notify_key_enc, notify_key_iv = excluded.notify_key_iv,
       notify_key_tag = excluded.notify_key_tag, push_enc = excluded.push_enc, push_iv = excluded.push_iv, push_tag = excluded.push_tag,
       created_at = excluded.created_at, last_used_at = excluded.last_used_at, revoked_at = NULL`,
    input.id, input.ownerId, input.name, input.model, publicKeyText(input.publicKey), input.path, input.lifetimeDays,
    ke, ki, kt, push[0], push[1], push[2], input.now, input.now,
  );
  return notifyKey;
}

export async function notifyKeyOf(id: string): Promise<Buffer | null> {
  const r = await q.one<{ notify_key_enc: string | null; notify_key_iv: string | null; notify_key_tag: string | null }>(
    'SELECT notify_key_enc, notify_key_iv, notify_key_tag FROM phone_devices WHERE id = ? AND revoked_at IS NULL', id);
  if (!r?.notify_key_enc || !r.notify_key_iv || !r.notify_key_tag) return null;
  return fromB64url(await getEncryptionService().decrypt(r.notify_key_enc, r.notify_key_iv, r.notify_key_tag));
}

/** The next notice counter for a phone (stored before the notice is sent, so it never repeats). */
export async function nextNotifyCounter(id: string): Promise<number> {
  await q.run('UPDATE phone_devices SET notify_counter = notify_counter + 1 WHERE id = ? AND revoked_at IS NULL', id);
  const r = await q.one<{ notify_counter: unknown }>('SELECT notify_counter FROM phone_devices WHERE id = ?', id);
  return n(r?.notify_counter);
}

/** Records an accepted command (counter) or a finished handshake (time only). Counters and times never go back. */
export async function markUsed(id: string, at: number, counter?: number): Promise<void> {
  if (counter === undefined) await q.run('UPDATE phone_devices SET last_used_at = ? WHERE id = ? AND last_used_at < ?', at, id, at);
  else await q.run(
    'UPDATE phone_devices SET last_counter = ?, last_used_at = CASE WHEN last_used_at < ? THEN ? ELSE last_used_at END WHERE id = ? AND last_counter < ?',
    counter, at, at, id, counter);
}

export async function patchDevice(id: string, patch: { name?: string; path?: PhonePath; lifetimeDays?: PairingLifetimeDays }): Promise<boolean> {
  const sets: string[] = [], args: (string | number | null)[] = [];
  if (patch.name !== undefined) { sets.push('name = ?'); args.push(patch.name); }
  if (patch.path !== undefined) { sets.push('path = ?'); args.push(patch.path); }
  if (patch.lifetimeDays !== undefined) { sets.push('lifetime_days = ?'); args.push(patch.lifetimeDays); }
  if (!sets.length) return !!(await getDevice(id));
  const r = await q.run(`UPDATE phone_devices SET ${sets.join(', ')} WHERE id = ? AND revoked_at IS NULL`, ...args, id);
  return r.changes > 0;
}

/** Forget: the row stays as a record, every key and token is wiped. */
export async function forgetDevice(id: string, at: number): Promise<boolean> {
  const r = await q.run(
    `UPDATE phone_devices SET revoked_at = ?, public_key = '', notify_key_enc = NULL, notify_key_iv = NULL, notify_key_tag = NULL,
       push_enc = NULL, push_iv = NULL, push_tag = NULL WHERE id = ? AND revoked_at IS NULL`, at, id);
  await q.run('DELETE FROM phone_approvals_shown WHERE device_id = ?', id);
  return r.changes > 0;
}

export async function forgetAll(ownerId: string, at: number): Promise<string[]> {
  const ids = (await listDevices(ownerId)).map((d) => d.id);
  for (const id of ids) await forgetDevice(id, at);
  return ids;
}

// ---------- approvals shown to a phone ----------

export async function markShown(deviceId: string, approvalIds: string[], at: number): Promise<void> {
  for (const id of approvalIds) {
    await q.run('INSERT INTO phone_approvals_shown (device_id, approval_id, shown_at) VALUES (?, ?, ?) ON CONFLICT (device_id, approval_id) DO NOTHING', deviceId, id, at);
  }
}

export async function wasShown(deviceId: string, approvalId: string): Promise<boolean> {
  return !!(await q.one('SELECT 1 AS x FROM phone_approvals_shown WHERE device_id = ? AND approval_id = ?', deviceId, approvalId));
}

// ---------- settings ----------

/** A relay name the owner may set: wss://host/v1, or ws:// only to this computer (a relay run locally). */
export function validRelayUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 300) return false;
  if (/^wss:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?\/v1$/.test(v)) return true;
  return /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?\/v1$/.test(v);
}

export async function getSetting(key: string): Promise<string | undefined> {
  return (await q.one<{ value: string }>('SELECT value FROM phone_settings WHERE key = ?', key))?.value;
}

export async function setSetting(key: string, value: string | null, at = Date.now()): Promise<void> {
  if (value === null) { await q.run('DELETE FROM phone_settings WHERE key = ?', key); return; }
  await q.run('INSERT INTO phone_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, value, at);
}

export async function relayUrl(): Promise<string> {
  const v = await getSetting('phone.relayUrl');
  return v && validRelayUrl(v) ? v : DEFAULT_RELAY_URL;
}

/**
 * The Wi-Fi (local network) listener. OFF unless `phone.lanListen` holds
 * {"host","port"}. There is no API to set it yet: binding beyond 127.0.0.1
 * waits for the owner's decision (see src/phone/README.md).
 */
export async function lanListen(): Promise<{ host: string; port: number } | null> {
  const raw = await getSetting('phone.lanListen');
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v.host === 'string' && /^[0-9A-Fa-f.:]{2,45}$/.test(v.host) && Number.isInteger(v.port) && v.port >= 0 && v.port <= 65535) return { host: v.host, port: v.port };
  } catch { /* off */ }
  return null;
}

// ---------- the computer's identity ----------

/** The computer's identity, created on first use. Its private key is decrypted only into memory. */
export async function loadIdentity(create = true): Promise<Identity | null> {
  const row = await q.one<{ device_id: string; public_key: string; private_key_enc: string; private_key_iv: string; private_key_tag: string }>(
    "SELECT device_id, public_key, private_key_enc, private_key_iv, private_key_tag FROM phone_identity WHERE id = 'computer'");
  if (row) {
    let pkcs8: string;
    try { pkcs8 = await getEncryptionService().decrypt(row.private_key_enc, row.private_key_iv, row.private_key_tag); }
    catch { throw new PhoneStoreError('identity_unavailable'); }
    const privateKey = createPrivateKey({ key: fromB64url(pkcs8), format: 'der', type: 'pkcs8' });
    const publicKey = p256PublicKey(fromB64url(row.public_key));
    if (deviceIdOf(publicKey) !== row.device_id) throw new PhoneStoreError('identity_unavailable');
    return { id: row.device_id, publicKey, privateKey };
  }
  if (!create) return null;
  const fresh = createIdentity();
  const [e, i, t] = await seal(b64url(fresh.privateKey.export({ type: 'pkcs8', format: 'der' })));
  await q.run(
    "INSERT INTO phone_identity (id, device_id, public_key, private_key_enc, private_key_iv, private_key_tag, created_at) VALUES ('computer', ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
    fresh.id, publicKeyText(fresh.publicKey), e, i, t, Date.now());
  // Two first uses at once: the row that won is the identity.
  return loadIdentity(false);
}

/** The active owner (the account phones act for). */
export async function activeOwner(): Promise<string | null> {
  const r = await q.one<{ id: string }>("SELECT id FROM users WHERE role = 'owner' AND status = 'active' ORDER BY created_at, id LIMIT 1");
  return r?.id ?? null;
}
