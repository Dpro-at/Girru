/**
 * Pairing and notice formats (PROTOCOL.md "QR code", "Pairing key", "Pairing
 * request", "Check challenge", "Check code", "Welcome" and "Notice format"). The relay reference
 * code has no copy of these yet; this file follows the text byte for byte.
 * Both sides are here (the phone side is used by tests and as a reference).
 *
 * Only Node `crypto`. Nothing here logs or keeps a secret.
 */

import { createCipheriv, createDecipheriv, createHash, diffieHellman, hkdfSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { ID_PATTERN, PAIRING_PATTERN, RELAY_NAME_PATTERN, b64url, deviceIdOf, fromB64url, p256PublicKey } from './encoding.js';
import { PAIRING_LIFETIME_DAYS, ProtocolError, publicKeyText, type Identity, type PairingLifetimeDays } from './e2e.js';

const SUITE = 'g1';
/** Longest QR text and the furthest `exp` a code may carry. */
export const QR_MAX_BYTES = 1024;
export const QR_MAX_AHEAD_MS = 10 * 60 * 1000;
export const NOTICE_MAX_BYTES = 3500;
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const LAN_RE = /^[A-Za-z0-9.:[\]-]{1,253}:\d{1,5}$/;

export function newPairingId(): string {
  return `p_${b64url(randomBytes(32))}`;
}

export function newPairingSecret(): Buffer {
  return randomBytes(32);
}

/** HKDF-SHA-256(secret, salt = pairing id text, info = "girru/v1/pair", 32 bytes). */
export function pairingKey(secret: Uint8Array, pairingId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from(pairingId, 'utf8'), 'girru/v1/pair', 32));
}

/** A display name as the protocol allows it: up to 64 characters, no control characters. */
export function cleanName(text: unknown, fallback = ''): string {
  const s = typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : '';
  return s || fallback;
}

export interface QrFields {
  computer: Identity;
  pairingId: string;
  secret: Uint8Array;
  /** Expiry in ms; written as unix seconds. */
  expiresAt: number;
  relay?: string;
  lan?: string[];
  name?: string;
}

/** The `girru://pair?...` text shown as a QR code. */
export function qrText(f: QrFields, now = Date.now()): string {
  if (!PAIRING_PATTERN.test(f.pairingId) || f.secret.length !== 32) throw new ProtocolError('bad_format');
  if (f.expiresAt <= now || f.expiresAt - now > QR_MAX_AHEAD_MS) throw new ProtocolError('bad_expiry');
  if (f.relay !== undefined && !RELAY_NAME_PATTERN.test(f.relay)) throw new ProtocolError('bad_relay');
  const lan = (f.lan ?? []).slice(0, 4);
  if (lan.some((a) => !LAN_RE.test(a))) throw new ProtocolError('bad_lan');
  if (!f.relay && !lan.length) throw new ProtocolError('no_path');
  const p = new URLSearchParams();
  p.set('v', '1');
  p.set('cid', f.computer.id);
  p.set('ck', publicKeyText(f.computer.publicKey));
  p.set('pid', f.pairingId);
  p.set('ps', b64url(f.secret));
  p.set('exp', String(Math.floor(f.expiresAt / 1000)));
  if (f.relay) p.set('relay', f.relay);
  if (lan.length) p.set('lan', lan.join(','));
  const name = cleanName(f.name);
  if (name) p.set('name', name);
  const text = `girru://pair?${p.toString()}`;
  if (Buffer.byteLength(text) > QR_MAX_BYTES) throw new ProtocolError('too_large');
  return text;
}

export interface ScannedQr {
  computerId: string;
  computerKey: KeyObject;
  pairingId: string;
  secret: Buffer;
  expiresAt: number;
  relay?: string;
  lan: string[];
  name?: string;
}

/** The phone side: reads and checks a scanned code. */
export function readQr(text: string, now = Date.now()): ScannedQr {
  if (typeof text !== 'string' || Buffer.byteLength(text) > QR_MAX_BYTES || !text.startsWith('girru://pair?')) throw new ProtocolError('bad_format');
  const p = new URLSearchParams(text.slice('girru://pair?'.length));
  const seen = new Set<string>();
  for (const k of p.keys()) { if (seen.has(k)) throw new ProtocolError('bad_format'); seen.add(k); }
  const get = (k: string) => p.get(k) ?? undefined;
  if (get('v') !== '1') throw new ProtocolError('bad_format');
  const cid = get('cid'), ck = get('ck'), pid = get('pid'), ps = get('ps'), exp = Number(get('exp'));
  if (!cid || !ID_PATTERN.test(cid) || !ck || !pid || !PAIRING_PATTERN.test(pid) || !ps) throw new ProtocolError('bad_format');
  const key = p256PublicKey(fromB64url(ck));
  if (deviceIdOf(key) !== cid) throw new ProtocolError('wrong_key');
  const secret = fromB64url(ps);
  if (secret.length !== 32 || !Number.isSafeInteger(exp)) throw new ProtocolError('bad_format');
  if (exp * 1000 <= now || exp * 1000 - now > QR_MAX_AHEAD_MS + 1000) throw new ProtocolError('expired');
  const relay = get('relay');
  if (relay !== undefined && !RELAY_NAME_PATTERN.test(relay)) throw new ProtocolError('bad_format');
  const lan = (get('lan') ?? '').split(',').filter(Boolean);
  if (lan.length > 4 || lan.some((a) => !LAN_RE.test(a))) throw new ProtocolError('bad_format');
  if (!relay && !lan.length) throw new ProtocolError('bad_format');
  const name = get('name');
  if (name !== undefined && !NAME_RE.test(name)) throw new ProtocolError('bad_format');
  return { computerId: cid, computerKey: key, pairingId: pid, secret, expiresAt: exp * 1000, relay, lan, ...(name ? { name } : {}) };
}

// ---------- pairing request (g1.preq) ----------

export interface PairingRequest {
  /** The phone's identity key and its device id. */
  key: KeyObject;
  phoneId: string;
  name: string;
  platform: string;
  push?: string;
  lifetimeDays?: Exclude<PairingLifetimeDays, null>;
}

function preqSignedText(pairingId: string, phoneId: string, nonce: string): Buffer {
  return Buffer.from(`girru/v1/preq-sig\n${pairingId}\n${phoneId}\n${nonce}`, 'utf8');
}

function gcmSeal(key: Buffer, nonce: Buffer, aad: string, plaintext: Buffer): Buffer {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

function gcmOpen(key: Buffer, nonce: Buffer, aad: string, box: Buffer): Buffer {
  if (box.length < 16) throw new ProtocolError('bad_format');
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(box.subarray(box.length - 16));
  try {
    return Buffer.concat([d.update(box.subarray(0, box.length - 16)), d.final()]);
  } catch {
    throw new ProtocolError('bad_tag');
  }
}

function decodePart(text: string): Buffer {
  try { return fromB64url(text); } catch { throw new ProtocolError('bad_format'); }
}

/** The phone side: builds a signed, sealed pairing request. */
export function sealPairingRequest(
  phone: Identity, pairingId: string, secret: Uint8Array,
  info: { name: string; platform: string; push?: string; lifetimeDays?: number },
): string {
  const nonceBytes = randomBytes(12);
  const nonce = b64url(nonceBytes);
  const sig = b64url(sign('sha256', preqSignedText(pairingId, phone.id, nonce), phone.privateKey));
  const body = {
    key: publicKeyText(phone.publicKey), name: info.name, platform: info.platform,
    ...(info.push ? { push: info.push } : {}), ...(info.lifetimeDays !== undefined ? { lifetimeDays: info.lifetimeDays } : {}), sig,
  };
  const box = gcmSeal(pairingKey(secret, pairingId), nonceBytes, `girru/v1/preq\n${pairingId}`, Buffer.from(JSON.stringify(body), 'utf8'));
  return `${SUITE}.preq.${nonce}.${b64url(box)}`;
}

/**
 * The computer side: opens a pairing request, checks the phone's signature and
 * that `from` (the id the relay or the local link proved) is the key's id.
 */
export function openPairingRequest(env: string, pairingId: string, secret: Uint8Array, from: string): PairingRequest {
  const parts = typeof env === 'string' ? env.split('.') : [];
  if (parts.length !== 4 || parts[0] !== SUITE || parts[1] !== 'preq') throw new ProtocolError('bad_format');
  const nonce = parts[2];
  const nonceBytes = decodePart(nonce);
  if (nonceBytes.length !== 12) throw new ProtocolError('bad_format');
  const plain = gcmOpen(pairingKey(secret, pairingId), nonceBytes, `girru/v1/preq\n${pairingId}`, decodePart(parts[3]));
  let body: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(plain.toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    body = v as Record<string, unknown>;
  } catch {
    throw new ProtocolError('bad_format');
  }
  if (typeof body.key !== 'string' || typeof body.sig !== 'string') throw new ProtocolError('bad_format');
  let key: KeyObject;
  try { key = p256PublicKey(fromB64url(body.key)); } catch { throw new ProtocolError('bad_format'); }
  const phoneId = deviceIdOf(key);
  let ok = false;
  try { ok = verify('sha256', preqSignedText(pairingId, phoneId, nonce), key, fromB64url(body.sig)); } catch { ok = false; }
  if (!ok) throw new ProtocolError('bad_signature');
  if (from !== phoneId) throw new ProtocolError('wrong_key');
  const name = cleanName(body.name);
  const platform = typeof body.platform === 'string' && /^[a-z0-9_-]{1,32}$/.test(body.platform) ? body.platform : '';
  if (!name || !platform) throw new ProtocolError('bad_format');
  const push = body.push === undefined ? undefined : typeof body.push === 'string' && /^[A-Za-z0-9:_.-]{1,4096}$/.test(body.push) ? body.push : null;
  if (push === null) throw new ProtocolError('bad_format');
  const lifetime = body.lifetimeDays;
  if (lifetime !== undefined && (lifetime === null || !(PAIRING_LIFETIME_DAYS as readonly unknown[]).includes(lifetime))) throw new ProtocolError('bad_lifetime');
  return { key, phoneId, name, platform, ...(push ? { push } : {}), ...(lifetime !== undefined ? { lifetimeDays: lifetime as 30 | 60 | 90 | 120 } : {}) };
}

// ---------- check challenge (g1.pchal) and check code ----------

export const CHALLENGE_BYTES = 32;

/**
 * The computer side: once it has taken a request, a fresh random challenge for
 * that phone, sealed under the pairing key and signed. The phone's key is fixed
 * (in the request) before the challenge exists, so a key cannot be ground to
 * match a check code.
 */
export function sealChallenge(computer: Identity, pairingId: string, secret: Uint8Array, phoneId: string): { env: string; challenge: Buffer } {
  const challenge = randomBytes(CHALLENGE_BYTES);
  const nonce = randomBytes(12);
  const body = { computer: computer.id, phone: phoneId, challenge: b64url(challenge) };
  const box = gcmSeal(pairingKey(secret, pairingId), nonce, `girru/v1/pchal\n${pairingId}`, Buffer.from(JSON.stringify(body), 'utf8'));
  const payload = b64url(Buffer.concat([nonce, box]));
  const sig = b64url(sign('sha256', Buffer.from(`girru/v1/pchal\n${payload}`, 'utf8'), computer.privateKey));
  return { env: `${SUITE}.pchal.${payload}.${sig}`, challenge };
}

/** The phone side: signature first (against `ck`), then the box, then the ids; returns the challenge bytes. */
export function openChallenge(env: string, computerKey: KeyObject, pairingId: string, secret: Uint8Array, phoneId: string): Buffer {
  const parts = typeof env === 'string' ? env.split('.') : [];
  if (parts.length !== 4 || parts[0] !== SUITE || parts[1] !== 'pchal') throw new ProtocolError('bad_format');
  let ok = false;
  try { ok = verify('sha256', Buffer.from(`girru/v1/pchal\n${parts[2]}`, 'utf8'), computerKey, fromB64url(parts[3])); } catch { ok = false; }
  if (!ok) throw new ProtocolError('bad_signature');
  const raw = decodePart(parts[2]);
  if (raw.length < 12 + 16) throw new ProtocolError('bad_format');
  const plain = gcmOpen(pairingKey(secret, pairingId), raw.subarray(0, 12), `girru/v1/pchal\n${pairingId}`, raw.subarray(12));
  let c: Record<string, unknown>;
  try { c = JSON.parse(plain.toString('utf8')); } catch { throw new ProtocolError('bad_format'); }
  if (!c || c.computer !== deviceIdOf(computerKey) || c.phone !== phoneId) throw new ProtocolError('wrong_key');
  const challenge = typeof c.challenge === 'string' ? decodePart(c.challenge) : Buffer.alloc(0);
  if (challenge.length !== CHALLENGE_BYTES) throw new ProtocolError('bad_format');
  return challenge;
}

/**
 * SHA-256("girru/v1/check\n" || secret || computer SPKI || phone SPKI || challenge):
 * first 4 bytes mod 1 000 000, 6 digits. The challenge is the computer's g1.pchal.
 */
export function checkCode(secret: Uint8Array, computerKey: KeyObject, phoneKey: KeyObject, challenge: Uint8Array): string {
  if (!challenge || challenge.length !== CHALLENGE_BYTES) throw new ProtocolError('bad_format');
  const digest = createHash('sha256')
    .update(Buffer.from('girru/v1/check\n', 'utf8'))
    .update(secret)
    .update(computerKey.export({ type: 'spki', format: 'der' }))
    .update(phoneKey.export({ type: 'spki', format: 'der' }))
    .update(challenge)
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

// ---------- welcome (g1.pwel) ----------

export interface Welcome {
  computer: string;
  phone: string;
  /** The raw 32-byte notification key, base64url (wrapped on the wire, see notifyWrapKey). */
  notifyKey: string;
  lifetimeDays: PairingLifetimeDays;
  name?: string;
}

/**
 * The key that wraps the notification key inside the welcome: HKDF-SHA-256(
 * ECDH(computer identity, phone identity), salt = pairing key, info =
 * "girru/v1/nkey", 32 bytes). Someone who saw only the QR code (the pairing
 * key) cannot unwrap it.
 */
function notifyWrapKey(own: KeyObject, peer: KeyObject, pairingId: string, secret: Uint8Array): Buffer {
  let shared: Buffer;
  try { shared = diffieHellman({ privateKey: own, publicKey: peer }); } catch { throw new ProtocolError('bad_key'); }
  return Buffer.from(hkdfSync('sha256', shared, pairingKey(secret, pairingId), 'girru/v1/nkey', 32));
}

const nkeyAad = (computerId: string, phoneId: string) => `girru/v1/nkey\n${computerId}\n${phoneId}`;

/** The computer side: the sealed and signed welcome. `phoneKey` is the key from the request. */
export function sealWelcome(computer: Identity, pairingId: string, secret: Uint8Array, phoneKey: KeyObject, w: Welcome): string {
  if (!(PAIRING_LIFETIME_DAYS as readonly unknown[]).includes(w.lifetimeDays)) throw new ProtocolError('bad_lifetime');
  if (deviceIdOf(phoneKey) !== w.phone) throw new ProtocolError('wrong_key');
  const raw = decodePart(w.notifyKey);
  if (raw.length !== 32) throw new ProtocolError('bad_format');
  const kn = randomBytes(12);
  const wrapped = b64url(Buffer.concat([kn, gcmSeal(notifyWrapKey(computer.privateKey, phoneKey, pairingId, secret), kn, nkeyAad(w.computer, w.phone), raw)]));
  const nonce = randomBytes(12);
  const body = { computer: w.computer, phone: w.phone, notifyKey: wrapped, ...(w.lifetimeDays === null ? {} : { lifetimeDays: w.lifetimeDays }), ...(w.name ? { name: w.name } : {}) };
  const box = gcmSeal(pairingKey(secret, pairingId), nonce, `girru/v1/pwel\n${pairingId}`, Buffer.from(JSON.stringify(body), 'utf8'));
  const payload = b64url(Buffer.concat([nonce, box]));
  const sig = b64url(sign('sha256', Buffer.from(`girru/v1/pwel\n${payload}`, 'utf8'), computer.privateKey));
  return `${SUITE}.pwel.${payload}.${sig}`;
}

/** The phone side: signature first (against `ck` from the QR code), then the box, then every field; unwraps the notification key. */
export function openWelcome(env: string, computerKey: KeyObject, pairingId: string, secret: Uint8Array, phone: Identity): Welcome {
  const parts = typeof env === 'string' ? env.split('.') : [];
  if (parts.length !== 4 || parts[0] !== SUITE || parts[1] !== 'pwel') throw new ProtocolError('bad_format');
  let ok = false;
  try { ok = verify('sha256', Buffer.from(`girru/v1/pwel\n${parts[2]}`, 'utf8'), computerKey, fromB64url(parts[3])); } catch { ok = false; }
  if (!ok) throw new ProtocolError('bad_signature');
  const raw = decodePart(parts[2]);
  if (raw.length < 12 + 16) throw new ProtocolError('bad_format');
  const plain = gcmOpen(pairingKey(secret, pairingId), raw.subarray(0, 12), `girru/v1/pwel\n${pairingId}`, raw.subarray(12));
  let w: Record<string, unknown>;
  try { w = JSON.parse(plain.toString('utf8')); } catch { throw new ProtocolError('bad_format'); }
  const lifetime = w.lifetimeDays === undefined ? null : w.lifetimeDays;
  if (w.computer !== deviceIdOf(computerKey) || w.phone !== phone.id) throw new ProtocolError('wrong_key');
  const wrapped = typeof w.notifyKey === 'string' ? decodePart(w.notifyKey) : Buffer.alloc(0);
  if (wrapped.length !== 12 + 32 + 16) throw new ProtocolError('bad_format');
  if (!(PAIRING_LIFETIME_DAYS as readonly unknown[]).includes(lifetime)) throw new ProtocolError('bad_lifetime');
  const notifyKey = gcmOpen(notifyWrapKey(phone.privateKey, computerKey, pairingId, secret), wrapped.subarray(0, 12), nkeyAad(w.computer as string, phone.id), wrapped.subarray(12));
  return { computer: w.computer as string, phone: phone.id, notifyKey: b64url(notifyKey), lifetimeDays: lifetime as PairingLifetimeDays, ...(typeof w.name === 'string' ? { name: w.name } : {}) };
}

// ---------- notice (g1.ntf) ----------

export type NoticeKind = 'approval' | 'approval.sensitive' | 'task.failed' | 'summary' | 'security';
export interface NoticeContent {
  kind: NoticeKind;
  title: string;
  body: string;
  approvalId?: string;
  group?: string;
}

const TEXT_RE = /^[^\u0000-\u0009\u000b-\u001f\u007f]*$/;

/** The computer side: one sealed, signed notice for one phone. `ctr` must grow per phone. */
export function sealNotice(computer: Identity, phoneId: string, notifyKey: Uint8Array, ctr: number, content: NoticeContent, now = Date.now()): string {
  if (notifyKey.length !== 32 || !Number.isSafeInteger(ctr) || ctr < 1) throw new ProtocolError('bad_format');
  const title = content.title.slice(0, 120), body = content.body.slice(0, 600);
  if (!TEXT_RE.test(title) || !TEXT_RE.test(body)) throw new ProtocolError('bad_format');
  const inner = JSON.stringify({ kind: content.kind, title, body, ...(content.approvalId ? { approvalId: content.approvalId } : {}), ...(content.group ? { group: content.group } : {}) });
  const nonce = randomBytes(12);
  const aad = `girru/v1/ntf\n${computer.id}\n${phoneId}\n${ctr}`;
  const box = b64url(Buffer.concat([nonce, gcmSeal(Buffer.from(notifyKey), nonce, aad, Buffer.from(inner, 'utf8'))]));
  const payload = b64url(Buffer.from(JSON.stringify({ from: computer.id, to: phoneId, ctr, ts: now, box }), 'utf8'));
  const sig = b64url(sign('sha256', Buffer.from(`girru/v1/ntf\n${payload}`, 'utf8'), computer.privateKey));
  const env = `${SUITE}.ntf.${payload}.${sig}`;
  if (Buffer.byteLength(env) > NOTICE_MAX_BYTES) throw new ProtocolError('too_large');
  return env;
}

/** The phone side (tests): signature, ids, then the box. The replay window is the phone's job. */
export function openNotice(env: string, computerKey: KeyObject, phoneId: string, notifyKey: Uint8Array): { ctr: number; ts: number; content: NoticeContent } {
  const parts = typeof env === 'string' ? env.split('.') : [];
  if (parts.length !== 4 || parts[0] !== SUITE || parts[1] !== 'ntf') throw new ProtocolError('bad_format');
  let ok = false;
  try { ok = verify('sha256', Buffer.from(`girru/v1/ntf\n${parts[2]}`, 'utf8'), computerKey, fromB64url(parts[3])); } catch { ok = false; }
  if (!ok) throw new ProtocolError('bad_signature');
  const head = JSON.parse(decodePart(parts[2]).toString('utf8'));
  if (head.from !== deviceIdOf(computerKey) || head.to !== phoneId) throw new ProtocolError('wrong_key');
  const raw = decodePart(head.box);
  const plain = gcmOpen(Buffer.from(notifyKey), raw.subarray(0, 12), `girru/v1/ntf\n${head.from}\n${head.to}\n${head.ctr}`, raw.subarray(12));
  return { ctr: head.ctr, ts: head.ts, content: JSON.parse(plain.toString('utf8')) };
}
