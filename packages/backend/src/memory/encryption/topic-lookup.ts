/** Internal ENC-01 equality lookup. Not wired to live queries or an authorization mechanism. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeDrawer, type DrawerRef } from '../drawers.js';
import { isTopicKey } from '../topic-key.js';
import { MemoryCipherError } from './envelope.js';
function validKey(key: Buffer) { if (!Buffer.isBuffer(key) || key.length !== 32) throw new MemoryCipherError(); }
function owner(value: string) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new MemoryCipherError();
}
/** Derive a distinct owner lookup key; never reuse an encryption key as a raw equality token. */
export function deriveMemoryLookupKey(masterKey: Buffer, ownerId: string): Buffer {
  validKey(masterKey); owner(ownerId);
  return createHmac('sha256', masterKey).update(JSON.stringify(['girru-memory', 1, 'owner-lookup-key', ownerId])).digest();
}
/** Equality patterns within one owner/drawer remain visible; token contents are not plaintext. */
export function memoryTopicLookupToken(topicKey: string | null, lookupKey: Buffer, ownerId: string, drawer: DrawerRef): string | null {
  validKey(lookupKey); owner(ownerId);
  let d: DrawerRef;
  try { d = normalizeDrawer(drawer); } catch { throw new MemoryCipherError(); }
  if (topicKey === null) return null;
  if (!isTopicKey(topicKey)) throw new MemoryCipherError();
  return 'enc-topic-v1:' + createHmac('sha256', lookupKey).update(JSON.stringify(['girru-memory', 1, 'topic-equality', ownerId, d.kind, d.key ?? '', topicKey])).digest('base64url');
}
/** After decrypting a candidate, verify its topic against the token used by the query. */
export function verifyMemoryTopicLookup(decryptedTopic: string | null, expectedToken: string | null, lookupKey: Buffer, ownerId: string, drawer: DrawerRef): void {
  const actual = memoryTopicLookupToken(decryptedTopic, lookupKey, ownerId, drawer);
  if (actual === null || expectedToken === null) { if (actual !== expectedToken) throw new MemoryCipherError(); return; }
  if (typeof expectedToken !== 'string' || !/^enc-topic-v1:[A-Za-z0-9_-]{43}$/.test(expectedToken) || expectedToken.length !== actual.length
    || !timingSafeEqual(Buffer.from(actual, 'utf8'), Buffer.from(expectedToken, 'utf8'))) throw new MemoryCipherError();
}
