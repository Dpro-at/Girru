/**
 * Small shared pieces of the wire format (PROTOCOL.md): base64url, device ids
 * and the relay hello text. Used by the relay and by the device-side reference
 * code, so both sides agree byte for byte.
 */

import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

/** A device id or pairing id: 32 bytes as unpadded base64url (43 characters). */
export const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** What the relay signs over in the hello: this text, a newline, then the relay's nonce. */
export const RELAY_HELLO_CONTEXT = 'girru/relay/v1/hello';

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Strict decode: refuses anything that is not canonical unpadded base64url. */
export function fromB64url(text: string): Buffer {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('bad_base64url');
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) throw new Error('bad_base64url');
  return bytes;
}

/** Reads a P-256 public key from SPKI DER bytes; refuses any other key type or curve. */
export function p256PublicKey(spki: Uint8Array): KeyObject {
  const key = createPublicKey({ key: Buffer.from(spki), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('not_p256');
  }
  return key;
}

/** Device id = SHA-256 of the identity public key in canonical SPKI DER form. */
export function deviceIdOf(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return b64url(createHash('sha256').update(spki).digest());
}

/**
 * A pairing id: `p_` then 32 random bytes as base64url. The prefix keeps pairing
 * ids and device ids apart, so one can never be mistaken for the other.
 */
export const PAIRING_PATTERN = /^p_[A-Za-z0-9_-]{43}$/;

/** A relay's name: the WebSocket URL devices are configured to reach (ws:// or wss://, path /v1). */
export const RELAY_NAME_PATTERN = /^wss?:\/\/[A-Za-z0-9.:[\]-]{1,253}\/v1$/;

/**
 * The bytes a device signs in its relay hello: the context, the relay's name and
 * the per-connection nonce. The name binds the hello to one relay, so a hello
 * captured by one relay cannot be replayed to another.
 */
export function relayHelloBytes(relay: string, nonce: string): Buffer {
  return Buffer.from(`${RELAY_HELLO_CONTEXT}\n${relay}\n${nonce}`, 'utf8');
}
