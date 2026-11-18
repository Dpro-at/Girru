/** Internal ENC-01 foundation. Not an enablement switch or a substitute for authorization. */
import { randomUUID } from 'node:crypto';
import { encryptAES256GCM, decryptAES256GCM, generateKey } from '../../encryption/crypto-utils.js';

export const MAX_MEMORY_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_ENVELOPE_BYTES = Math.ceil(MAX_MEMORY_PLAINTEXT_BYTES / 3) * 4 + 1024;
export interface MemoryCipherContext { ownerId: string; memberId: string; recordId: string; field: string }
export interface WrappedMemoryDataKey { id: string; wrapped: string }
type Envelope = { v: 1; k: string; n: string; t: string; c: string };
type Purpose = 'memory' | 'data-key' | 'recovery-key';
export class MemoryCipherError extends Error {
  constructor() { super('Memory ciphertext or key is unavailable or invalid.'); this.name = 'MemoryCipherError'; }
}
function identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new MemoryCipherError();
}
function keyCheck(key: Buffer) { if (!Buffer.isBuffer(key) || key.length !== 32) throw new MemoryCipherError(); }
function binding(context: MemoryCipherContext, keyId: string, purpose: Purpose): Buffer {
  for (const value of [context.ownerId, context.memberId, context.recordId, context.field, keyId]) identity(value);
  // Canonical, length-unambiguous binding prevents swapping between members, records or fields.
  return Buffer.from(JSON.stringify(['girru-memory', 1, purpose, keyId, context.ownerId, context.memberId, context.recordId, context.field]));
}
function decode(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > MAX_ENVELOPE_BYTES || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new MemoryCipherError();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) throw new MemoryCipherError();
  return bytes;
}
function encryptBytes(plain: Buffer, key: Buffer, keyId: string, context: MemoryCipherContext, purpose: Purpose): string {
  keyCheck(key);
  if (plain.length > MAX_MEMORY_PLAINTEXT_BYTES) throw new MemoryCipherError();
  const encrypted = encryptAES256GCM(plain, key, keyId, binding(context, keyId, purpose));
  return JSON.stringify({ v: 1, k: keyId, n: encrypted.iv, t: encrypted.authTag!, c: encrypted.ciphertext } satisfies Envelope);
}
function decryptBytes(raw: string, key: Buffer, keyId: string, context: MemoryCipherContext, purpose: Purpose): Buffer {
  try {
    keyCheck(key);
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_ENVELOPE_BYTES) throw new MemoryCipherError();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoryCipherError();
    const e = value as Envelope;
    if (Object.keys(e).sort().join(',') !== 'c,k,n,t,v' || e.v !== 1 || e.k !== keyId) throw new MemoryCipherError();
    decode(e.n, 12); decode(e.t, 16);
    if (decode(e.c).length > MAX_MEMORY_PLAINTEXT_BYTES) throw new MemoryCipherError();
    return decryptAES256GCM({ algorithm: 'aes-256-gcm', version: 1, keyId, iv: e.n, authTag: e.t, ciphertext: e.c, encryptedAt: '' }, key, binding(context, keyId, purpose));
  } catch { throw new MemoryCipherError(); }
}
/** Caller supplies a trusted owner/member/record/field context after checking permissions. */
export function sealMemoryText(plaintext: string, key: Buffer, keyId: string, context: MemoryCipherContext): string {
  if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext, 'utf8') > MAX_MEMORY_PLAINTEXT_BYTES) throw new MemoryCipherError();
  const bytes = Buffer.from(plaintext, 'utf8');
  if (bytes.toString('utf8') !== plaintext) { bytes.fill(0); throw new MemoryCipherError(); }
  try { return encryptBytes(bytes, key, keyId, context, 'memory'); } finally { bytes.fill(0); }
}
/** Encrypted mode must use this path exclusively: never fall back to raw plaintext on an error. */
export function openMemoryText(raw: string, key: Buffer, keyId: string, context: MemoryCipherContext): string {
  const plain = decryptBytes(raw, key, keyId, context, 'memory');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(plain); }
  catch { throw new MemoryCipherError(); }
  finally { plain.fill(0); }
}
function keyContext(ownerId: string, memberId: string, id: string): MemoryCipherContext {
  return { ownerId, memberId, recordId: id, field: 'wrapped-data-key' };
}
/** Only the wrapped record may be persisted. Master-key custody is supplied by the host, not generated here. */
export function createMemoryDataKey(masterKey: Buffer, ownerId: string, memberId: string): WrappedMemoryDataKey {
  const id = randomUUID(), key = generateKey();
  try { return { id, wrapped: encryptBytes(key, masterKey, id, keyContext(ownerId, memberId, id), 'data-key') }; }
  finally { key.fill(0); }
}
/** Caller owns and must wipe the returned key buffer after use. */
export function unlockMemoryDataKey(record: WrappedMemoryDataKey, masterKey: Buffer, ownerId: string, memberId: string): Buffer {
  if (!record || typeof record !== 'object' || typeof record.wrapped !== 'string' || typeof record.id !== 'string') throw new MemoryCipherError();
  const key = decryptBytes(record.wrapped, masterKey, record.id, keyContext(ownerId, memberId, record.id), 'data-key');
  if (key.length !== 32) { key.fill(0); throw new MemoryCipherError(); }
  return key;
}

/** Public recovery record contains ciphertext only; the code is shown once and must be kept separately. */
export interface MemoryRecoveryRecord { id: string; wrapped: string }
const RECOVERY_PREFIX = 'girru-recovery-v1.';
function recoveryContext(ownerId: string, id: string): MemoryCipherContext {
  return { ownerId, memberId: ownerId, recordId: id, field: 'recovery-master-key' };
}
export function createMemoryRecoveryRecord(masterKey: Buffer, ownerId: string): { recoveryCode: string; record: MemoryRecoveryRecord } {
  keyCheck(masterKey); identity(ownerId);
  const key = generateKey(), id = randomUUID();
  try {
    return { recoveryCode: RECOVERY_PREFIX + key.toString('base64url'), record: { id, wrapped: encryptBytes(masterKey, key, id, recoveryContext(ownerId, id), 'recovery-key') } };
  } finally { key.fill(0); }
}
/** Does not mutate OS storage or data. Callers must explicitly verify a copy before enrolling a recovered key. */
export function recoverMemoryMasterKey(record: MemoryRecoveryRecord, recoveryCode: string, ownerId: string): Buffer {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || typeof record.wrapped !== 'string'
    || typeof recoveryCode !== 'string' || !recoveryCode.startsWith(RECOVERY_PREFIX)) throw new MemoryCipherError();
  const encoded = recoveryCode.slice(RECOVERY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) throw new MemoryCipherError();
  const key = Buffer.from(encoded, 'base64url');
  try {
    if (key.length !== 32 || key.toString('base64url') !== encoded) throw new MemoryCipherError();
    const recovered = decryptBytes(record.wrapped, key, record.id, recoveryContext(ownerId, record.id), 'recovery-key');
    if (recovered.length !== 32) { recovered.fill(0); throw new MemoryCipherError(); }
    return recovered;
  } finally { key.fill(0); }
}
