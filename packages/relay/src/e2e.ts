/**
 * Device-side reference code for the end-to-end layer (PROTOCOL.md sections
 * "Session handshake", "Envelope" and "Signed commands"). The computer uses it
 * as is; the phone apps reimplement the same bytes with CryptoKit / Android
 * Keystore and are tested against vectors made here.
 *
 * Suite g1: ECDSA P-256 with SHA-256 for identity signatures (DER), ECDH P-256
 * for ephemeral key agreement, HKDF-SHA-256, AES-256-GCM. Only Node `crypto`.
 * The relay never runs this code and never holds any of these keys.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { ID_PATTERN, b64url, deviceIdOf, fromB64url, p256PublicKey, relayHelloBytes } from './encoding.js';

export const SUITE = 'g1';
/** Accepted clock difference for handshakes and commands. */
export const DEFAULT_WINDOW_MS = 2 * 60 * 1000;

export interface Identity {
  id: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export interface Session {
  id: string;
  selfId: string;
  peerId: string;
  sendKey: Buffer;
  recvKey: Buffer;
  sendSeq: number;
  recvSeq: number;
}

export interface PendingHandshake {
  self: Identity;
  peerId: string;
  ephemeral: KeyObject;
  hello: string;
}

export interface SignedCommand {
  device: string;
  to: string;
  ctr: number;
  ts: number;
  nonce: string;
  body: string;
  sig: string;
}

export class ProtocolError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

// ---------- identity ----------

export function createIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { id: deviceIdOf(publicKey), publicKey, privateKey };
}

export function publicKeyText(key: KeyObject): string {
  return b64url(key.export({ type: 'spki', format: 'der' }));
}

/** Reads a peer's public key (SPKI, base64url) and checks it matches the expected device id. */
export function peerKey(text: string, expectedId?: string): KeyObject {
  const key = p256PublicKey(fromB64url(text));
  if (expectedId !== undefined && deviceIdOf(key) !== expectedId) throw new ProtocolError('wrong_key');
  return key;
}

/**
 * The relay hello: proves to the relay that this connection owns `identity.id`.
 * `relayUrl` is the relay this device is configured to reach; a challenge that
 * names any other relay is refused, so the signature is only good for that one.
 */
export function relayHello(
  identity: Identity,
  challenge: { relay?: unknown; nonce?: unknown },
  relayUrl: string,
  allow: string[] = [],
  pairing: string[] = [],
) {
  if (challenge.relay !== relayUrl) throw new ProtocolError('wrong_relay');
  if (typeof challenge.nonce !== 'string' || !ID_PATTERN.test(challenge.nonce)) throw new ProtocolError('bad_format');
  const sig = b64url(sign('sha256', relayHelloBytes(relayUrl, challenge.nonce), identity.privateKey));
  return { t: 'hello', v: 1, key: publicKeyText(identity.publicKey), sig, allow, pairing };
}

// ---------- session handshake (hs1 → hs2) ----------

function signedPart(context: string, payload: string, key: KeyObject): string {
  return b64url(sign('sha256', Buffer.from(`girru/v1/${context}\n${payload}`), key));
}

function checkSigned(context: string, payload: string, sig: string, key: KeyObject): void {
  let ok = false;
  try {
    ok = verify('sha256', Buffer.from(`girru/v1/${context}\n${payload}`), key, fromB64url(sig));
  } catch {
    ok = false;
  }
  if (!ok) throw new ProtocolError('bad_signature');
}

function splitEnvelope(env: string, kind: string): [string, string] {
  const parts = typeof env === 'string' ? env.split('.') : [];
  if (parts.length !== 4 || parts[0] !== SUITE || parts[1] !== kind) throw new ProtocolError('bad_format');
  return [parts[2], parts[3]];
}

function readJson(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fromB64url(part).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new ProtocolError('bad_format');
}

function checkTime(ts: unknown, now: number, windowMs: number): void {
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts)) throw new ProtocolError('bad_format');
  if (Math.abs(now - ts) > windowMs) throw new ProtocolError('stale');
}

function newEphemeral(): { privateKey: KeyObject; text: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, text: publicKeyText(publicKey) };
}

function deriveSession(selfId: string, peerId: string, initiator: boolean, shared: Buffer, transcript: Buffer): Session {
  const okm = Buffer.from(hkdfSync('sha256', shared, transcript, 'girru/v1/session', 64));
  const i2r = okm.subarray(0, 32);
  const r2i = okm.subarray(32, 64);
  return {
    id: b64url(transcript.subarray(0, 16)),
    selfId,
    peerId,
    sendKey: Buffer.from(initiator ? i2r : r2i),
    recvKey: Buffer.from(initiator ? r2i : i2r),
    sendSeq: 0,
    recvSeq: 0,
  };
}

function transcriptOf(hello: string, replyPayload: string): Buffer {
  return createHash('sha256').update(`${hello}\n${replyPayload}`).digest();
}

/** Step 1 (the side that opens the session): a signed hello with a fresh ephemeral key. */
export function startHandshake(self: Identity, peerId: string, now = Date.now()): { env: string; pending: PendingHandshake } {
  if (!ID_PATTERN.test(peerId)) throw new ProtocolError('bad_format');
  const eph = newEphemeral();
  const payload = b64url(Buffer.from(JSON.stringify({
    from: self.id, to: peerId, eph: eph.text, ts: now, nonce: b64url(randomBytes(16)),
  })));
  const env = `${SUITE}.hs1.${payload}.${signedPart('hs1', payload, self.privateKey)}`;
  return { env, pending: { self, peerId, ephemeral: eph.privateKey, hello: env } };
}

/** Step 2 (the side that answers): checks the hello against the paired key and returns the reply and the session. */
export function answerHandshake(self: Identity, peer: KeyObject, env: string, now = Date.now(), windowMs = DEFAULT_WINDOW_MS) {
  const [payload, sig] = splitEnvelope(env, 'hs1');
  checkSigned('hs1', payload, sig, peer);
  const hello = readJson(payload);
  const peerId = deviceIdOf(peer);
  if (hello.from !== peerId || hello.to !== self.id || typeof hello.eph !== 'string') throw new ProtocolError('bad_format');
  checkTime(hello.ts, now, windowMs);
  const peerEph = peerKey(hello.eph);
  const eph = newEphemeral();
  const reply = b64url(Buffer.from(JSON.stringify({
    from: self.id, to: peerId, eph: eph.text, ts: now, h1: b64url(createHash('sha256').update(env).digest()),
  })));
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: peerEph });
  const session = deriveSession(self.id, peerId, false, shared, transcriptOf(env, reply));
  return { env: `${SUITE}.hs2.${reply}.${signedPart('hs2', reply, self.privateKey)}`, session };
}

/** Step 3 (the opener): checks the reply and derives the same session. */
export function finishHandshake(pending: PendingHandshake, peer: KeyObject, env: string, now = Date.now(), windowMs = DEFAULT_WINDOW_MS): Session {
  const [payload, sig] = splitEnvelope(env, 'hs2');
  checkSigned('hs2', payload, sig, peer);
  const reply = readJson(payload);
  if (deviceIdOf(peer) !== pending.peerId) throw new ProtocolError('wrong_key');
  if (reply.from !== pending.peerId || reply.to !== pending.self.id || typeof reply.eph !== 'string') throw new ProtocolError('bad_format');
  if (reply.h1 !== b64url(createHash('sha256').update(pending.hello).digest())) throw new ProtocolError('bad_format');
  checkTime(reply.ts, now, windowMs);
  const shared = diffieHellman({ privateKey: pending.ephemeral, publicKey: peerKey(reply.eph) });
  return deriveSession(pending.self.id, pending.peerId, true, shared, transcriptOf(pending.hello, payload));
}

// ---------- envelope (g1.msg) ----------

function nonceFor(seq: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

/** Encrypts one message for the peer of this session. The header is authenticated, not hidden. */
export function seal(session: Session, plaintext: Uint8Array | string): string {
  if (session.sendSeq >= Number.MAX_SAFE_INTEGER) throw new ProtocolError('session_exhausted');
  const seq = ++session.sendSeq;
  const header = b64url(Buffer.from(JSON.stringify({ sid: session.id, seq, from: session.selfId, to: session.peerId })));
  const cipher = createCipheriv('aes-256-gcm', session.sendKey, nonceFor(seq));
  cipher.setAAD(Buffer.from(header));
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  const body = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
  return `${SUITE}.msg.${header}.${b64url(body)}`;
}

/** Decrypts one message; refuses tampering, other sessions and any sequence number not above the last one. */
export function open(session: Session, env: string): Buffer {
  const [header, bodyText] = splitEnvelope(env, 'msg');
  const h = readJson(header);
  if (h.sid !== session.id || h.from !== session.peerId || h.to !== session.selfId) throw new ProtocolError('wrong_session');
  if (typeof h.seq !== 'number' || !Number.isSafeInteger(h.seq) || h.seq < 1) throw new ProtocolError('bad_format');
  if (h.seq <= session.recvSeq) throw new ProtocolError('replay');
  const body = fromB64url(bodyText);
  if (body.length < 16) throw new ProtocolError('bad_format');
  const decipher = createDecipheriv('aes-256-gcm', session.recvKey, nonceFor(h.seq));
  decipher.setAAD(Buffer.from(header));
  decipher.setAuthTag(body.subarray(body.length - 16));
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]);
  } catch {
    throw new ProtocolError('bad_tag');
  }
  session.recvSeq = h.seq; // only after the tag checked out
  return plaintext;
}

// ---------- signed commands ----------

function commandBytes(c: Omit<SignedCommand, 'sig'>): Buffer {
  const bodyHash = b64url(createHash('sha256').update(c.body, 'utf8').digest());
  return Buffer.from(`girru/v1/cmd\n${c.device}\n${c.to}\n${c.ctr}\n${c.ts}\n${c.nonce}\n${bodyHash}`);
}

/** Signs one command for the computer `to`. `counter` must grow by at least one for every command this device sends. */
export function signCommand(self: Identity, to: string, counter: number, body: string, now = Date.now()): SignedCommand {
  const unsigned = { device: self.id, to, ctr: counter, ts: now, nonce: b64url(randomBytes(16)), body };
  return { ...unsigned, sig: b64url(sign('sha256', commandBytes(unsigned), self.privateKey)) };
}

/** Pairing lifetimes the owner can pick, in days; `null` = never expires (shown with a warning). */
export const PAIRING_LIFETIME_DAYS = [30, 60, 90, 120, null] as const;
export type PairingLifetimeDays = (typeof PAIRING_LIFETIME_DAYS)[number];
const DAY_MS = 24 * 60 * 60 * 1000;

export type CommandCheck =
  | { ok: true; device: string; body: string }
  | { ok: false; reason: 'bad_format' | 'unknown_device' | 'wrong_target' | 'bad_signature' | 'expired' | 'stale' | 'replay' };

/** What the computer persists per paired phone. */
export interface PairedDeviceRecord {
  /** Last accepted command counter. */
  lastCounter: number;
  /** Last authenticated use (accepted command or finished handshake), in ms. Expiry counts from here. */
  lastUsed: number;
  /** Lifetime in days, or null for never. */
  lifetimeDays: PairingLifetimeDays;
}

interface PairedDevice extends PairedDeviceRecord {
  key: KeyObject;
  nonces: Map<string, number>;
}

/**
 * The computer's gate for phone commands. It accepts a command only from a
 * device it paired itself and whose pairing has not expired, addressed to this
 * computer, signed by that device's key, inside the time window, with a
 * counter above the last accepted one and a nonce it has not seen.
 *
 * Pairing expiry slides: every authenticated use renews it, so an active phone
 * never scans again; a phone unused for its whole lifetime must pair again.
 * The computer is the only authority on this; the relay knows nothing of it.
 * `record()` is the state to persist per device.
 */
export class CommandVerifier {
  private readonly selfId: string;
  private readonly windowMs: number;
  private readonly devices = new Map<string, PairedDevice>();

  constructor(selfId: string, windowMs = DEFAULT_WINDOW_MS) {
    this.selfId = selfId;
    this.windowMs = windowMs;
  }

  addDevice(publicKey: KeyObject, record: Partial<PairedDeviceRecord> = {}): string {
    const lifetimeDays = record.lifetimeDays === undefined ? 90 : record.lifetimeDays;
    if (!PAIRING_LIFETIME_DAYS.includes(lifetimeDays)) throw new ProtocolError('bad_lifetime');
    const id = deviceIdOf(publicKey);
    this.devices.set(id, {
      key: publicKey,
      lastCounter: record.lastCounter ?? 0,
      lastUsed: record.lastUsed ?? Date.now(),
      lifetimeDays,
      nonces: new Map(),
    });
    return id;
  }

  /** The owner changes a pairing's lifetime on the computer; it still counts from the last use. */
  setLifetime(deviceId: string, lifetimeDays: PairingLifetimeDays): void {
    if (!PAIRING_LIFETIME_DAYS.includes(lifetimeDays)) throw new ProtocolError('bad_lifetime');
    const device = this.devices.get(deviceId);
    if (device) device.lifetimeDays = lifetimeDays;
  }

  /** True when the device is paired and its pairing has not run out. An expired device is forgotten. */
  isActive(deviceId: string, now = Date.now()): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;
    if (device.lifetimeDays !== null && now - device.lastUsed > device.lifetimeDays * DAY_MS) {
      this.devices.delete(deviceId);
      return false;
    }
    return true;
  }

  /** Records an authenticated use outside commands (a finished session handshake). False when expired. */
  touch(deviceId: string, now = Date.now()): boolean {
    if (!this.isActive(deviceId, now)) return false;
    const device = this.devices.get(deviceId) as PairedDevice;
    device.lastUsed = Math.max(device.lastUsed, now);
    return true;
  }

  revoke(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  revokeAll(): void {
    this.devices.clear();
  }

  lastCounter(deviceId: string): number | undefined {
    return this.devices.get(deviceId)?.lastCounter;
  }

  record(deviceId: string): PairedDeviceRecord | undefined {
    const d = this.devices.get(deviceId);
    return d ? { lastCounter: d.lastCounter, lastUsed: d.lastUsed, lifetimeDays: d.lifetimeDays } : undefined;
  }

  verify(command: unknown, now = Date.now()): CommandCheck {
    const c = command as Partial<SignedCommand> | null;
    if (
      !c || typeof c !== 'object' ||
      typeof c.device !== 'string' || typeof c.to !== 'string' || typeof c.body !== 'string' ||
      typeof c.nonce !== 'string' || typeof c.sig !== 'string' ||
      !Number.isSafeInteger(c.ctr) || !Number.isSafeInteger(c.ts) || (c.ctr as number) < 1 ||
      !/^[A-Za-z0-9_-]{22}$/.test(c.nonce)
    ) return { ok: false, reason: 'bad_format' };
    const device = this.devices.get(c.device);
    if (!device) return { ok: false, reason: 'unknown_device' };
    if (c.to !== this.selfId) return { ok: false, reason: 'wrong_target' };
    let signed = false;
    try {
      signed = verify('sha256', commandBytes(c as SignedCommand), device.key, fromB64url(c.sig));
    } catch {
      signed = false;
    }
    if (!signed) return { ok: false, reason: 'bad_signature' };
    if (!this.isActive(c.device, now)) return { ok: false, reason: 'expired' };
    if (Math.abs(now - (c.ts as number)) > this.windowMs) return { ok: false, reason: 'stale' };
    if ((c.ctr as number) <= device.lastCounter || device.nonces.has(c.nonce)) return { ok: false, reason: 'replay' };
    device.lastCounter = c.ctr as number;
    device.lastUsed = Math.max(device.lastUsed, now);
    device.nonces.set(c.nonce, c.ts as number);
    for (const [nonce, ts] of device.nonces) if (Math.abs(now - ts) > this.windowMs) device.nonces.delete(nonce);
    return { ok: true, device: c.device, body: c.body };
  }
}
