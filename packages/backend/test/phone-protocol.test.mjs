// MOB-PAIR-01: the backend's copy of the phone protocol.
//  - src/phone/protocol/{e2e,encoding,websocket}.ts are copies of packages/relay/src (the reference the
//    phone apps match byte for byte); this test fails as soon as a copy drifts;
//  - the pairing formats (QR, g1.preq, g1.pchal, check code, g1.pwel, g1.ntf) follow PROTOCOL.md and work with the
//    relay's own reference identity code.
// No network, no database.
// Run: node --import tsx --import ../../scripts/test-temp-root.mjs --test test/phone-protocol.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as nodeCrypto from 'node:crypto';
import { createHash } from 'node:crypto';

const backendDir = process.cwd();
const relayDir = join(backendDir, '..', 'relay');
const P = await import(join(backendDir, 'src/phone/protocol/pairing.ts'));
const ref = await import(join(relayDir, 'src/e2e.ts'));
const copy = await import(join(backendDir, 'src/phone/protocol/e2e.ts'));

const normal = (text) => text.replace(/\r\n/g, '\n').trimEnd();

test('the protocol copies are the relay originals, unchanged', () => {
  for (const f of ['e2e.ts', 'encoding.ts', 'websocket.ts']) {
    const original = normal(readFileSync(join(relayDir, 'src', f), 'utf8'));
    const ours = normal(readFileSync(join(backendDir, 'src/phone/protocol', f), 'utf8'));
    assert.equal(ours, original, `src/phone/protocol/${f} drifted from packages/relay/src/${f}: copy it again`);
  }
});

test('sessions and commands made by the reference code open with the copy', () => {
  const computer = copy.createIdentity(), phone = ref.createIdentity();
  const { env, pending } = ref.startHandshake(phone, computer.id);
  const answered = copy.answerHandshake(computer, phone.publicKey, env);
  const phoneSession = ref.finishHandshake(pending, computer.publicKey, answered.env);
  assert.equal(copy.open(answered.session, ref.seal(phoneSession, 'hello')).toString(), 'hello');
  const v = new copy.CommandVerifier(computer.id);
  v.addDevice(phone.publicKey);
  const cmd = ref.signCommand(phone, computer.id, 1, '{"type":"chat.list"}');
  assert.deepEqual(v.verify(cmd), { ok: true, device: phone.id, body: '{"type":"chat.list"}' });
  assert.equal(v.verify(cmd).reason, 'replay');
});

test('QR code: fields, limits, and the phone reads back what the computer wrote', () => {
  const computer = ref.createIdentity();
  const pid = P.newPairingId(), secret = P.newPairingSecret(), now = Date.now();
  assert.match(pid, /^p_[A-Za-z0-9_-]{43}$/);
  const text = P.qrText({ computer, pairingId: pid, secret, expiresAt: now + 120_000, relay: 'wss://relay.example.org/v1', name: 'Work Mac\u0007' }, now);
  assert.ok(text.startsWith('girru://pair?v=1&cid='));
  assert.ok(Buffer.byteLength(text) <= 1024);
  const read = P.readQr(text, now);
  assert.equal(read.computerId, computer.id);
  assert.equal(read.pairingId, pid);
  assert.deepEqual(read.secret, secret);
  assert.equal(read.relay, 'wss://relay.example.org/v1');
  assert.equal(read.name, 'Work Mac', 'control characters are removed');
  assert.equal(read.expiresAt, Math.floor((now + 120_000) / 1000) * 1000);
  assert.throws(() => P.qrText({ computer, pairingId: pid, secret, expiresAt: now + 11 * 60_000, relay: 'wss://r.example/v1' }, now), /bad_expiry/);
  assert.throws(() => P.qrText({ computer, pairingId: pid, secret, expiresAt: now + 60_000 }, now), /no_path/);
  assert.throws(() => P.readQr(text + '&v=1', now), /bad_format/, 'a repeated field makes the code invalid');
  assert.throws(() => P.readQr(text, now + 5 * 60_000), /expired/);
  const other = ref.createIdentity();
  const swapped = text.replace(/ck=[^&]+/, `ck=${ref.publicKeyText(other.publicKey)}`);
  assert.throws(() => P.readQr(swapped, now), /wrong_key/, 'cid must be the hash of ck');
});

test('pairing request: sealed under the pairing key, signed by the phone, bound to the proven sender', () => {
  const phone = ref.createIdentity(), intruder = ref.createIdentity();
  const pid = P.newPairingId(), secret = P.newPairingSecret();
  const env = P.sealPairingRequest(phone, pid, secret, { name: 'Work iPhone', platform: 'ios', lifetimeDays: 60, push: 'abcdef0123' });
  assert.match(env, /^g1\.preq\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.ok(!env.includes('iPhone'));
  const req = P.openPairingRequest(env, pid, secret, phone.id);
  assert.equal(req.phoneId, phone.id);
  assert.equal(req.name, 'Work iPhone');
  assert.equal(req.platform, 'ios');
  assert.equal(req.lifetimeDays, 60);
  assert.equal(req.push, 'abcdef0123');
  assert.throws(() => P.openPairingRequest(env, pid, secret, intruder.id), /wrong_key/, 'the relay-stamped from must be the key in the request');
  assert.throws(() => P.openPairingRequest(env, pid, P.newPairingSecret(), phone.id), /bad_tag/, 'only someone who saw the QR code can make one');
  assert.throws(() => P.openPairingRequest(env, P.newPairingId(), secret, phone.id), /bad_tag/, 'the pairing id is in the AAD and the key');
  // A signature lifted into another request (other nonce) does not verify.
  const pkey = P.pairingKey(secret, pid);
  const [, , nonce, box] = env.split('.');
  const { createDecipheriv, createCipheriv, randomBytes } = nodeCrypto;
  const d = createDecipheriv('aes-256-gcm', pkey, Buffer.from(nonce, 'base64url'));
  d.setAAD(Buffer.from(`girru/v1/preq\n${pid}`));
  const raw = Buffer.from(box, 'base64url');
  d.setAuthTag(raw.subarray(raw.length - 16));
  const json = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]);
  const n2 = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', pkey, n2);
  c.setAAD(Buffer.from(`girru/v1/preq\n${pid}`));
  const moved = `g1.preq.${n2.toString('base64url')}.${Buffer.concat([c.update(json), c.final(), c.getAuthTag()]).toString('base64url')}`;
  assert.throws(() => P.openPairingRequest(moved, pid, secret, phone.id), /bad_signature/);
  assert.throws(() => P.openPairingRequest(P.sealPairingRequest(phone, pid, secret, { name: 'x', platform: 'ios', lifetimeDays: 45 }), pid, secret, phone.id), /bad_lifetime/);
});
test('check challenge: signed by the computer, sealed under the pairing key, for one phone only', () => {
  const computer = ref.createIdentity(), phone = ref.createIdentity(), pid = P.newPairingId(), secret = P.newPairingSecret();
  const { env, challenge } = P.sealChallenge(computer, pid, secret, phone.id);
  assert.match(env, /^g1\.pchal\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(challenge.length, 32);
  assert.deepEqual(P.openChallenge(env, computer.publicKey, pid, secret, phone.id), challenge);
  assert.throws(() => P.openChallenge(env, ref.createIdentity().publicKey, pid, secret, phone.id), /bad_signature/);
  assert.throws(() => P.openChallenge(env, computer.publicKey, pid, secret, ref.createIdentity().id), /wrong_key/, 'a challenge for another phone is refused');
  assert.throws(() => P.openChallenge(env, computer.publicKey, pid, P.newPairingSecret(), phone.id), /bad_tag/);
  assert.notDeepEqual(P.sealChallenge(computer, pid, secret, phone.id).challenge, challenge, 'fresh every time');
});

test('check code: the PROTOCOL.md formula with the challenge; a key chosen before the challenge cannot be ground', () => {
  const computer = ref.createIdentity(), phone = ref.createIdentity(), secret = P.newPairingSecret();
  const challenge = nodeCrypto.randomBytes(32);
  const code = P.checkCode(secret, computer.publicKey, phone.publicKey, challenge);
  assert.match(code, /^\d{6}$/);
  const digest = createHash('sha256').update('girru/v1/check\n').update(secret)
    .update(computer.publicKey.export({ type: 'spki', format: 'der' })).update(phone.publicKey.export({ type: 'spki', format: 'der' })).update(challenge).digest();
  assert.equal(code, String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0'));
  assert.notEqual(code, P.checkCode(secret, computer.publicKey, ref.createIdentity().publicKey, challenge));
  assert.throws(() => P.checkCode(secret, computer.publicKey, phone.publicKey), /bad_format/, 'no code without a challenge');
  assert.throws(() => P.checkCode(secret, computer.publicKey, phone.publicKey, Buffer.alloc(16)), /bad_format/);
  // The same key under a new challenge gives an unrelated code: grinding a key against one challenge is useless.
  const codes = new Set(Array.from({ length: 20 }, () => P.checkCode(secret, computer.publicKey, phone.publicKey, nodeCrypto.randomBytes(32))));
  assert.ok(codes.size > 15);
});

test('welcome: signed by the computer, sealed under the pairing key; the notification key also needs the phone key', () => {
  const computer = ref.createIdentity(), phone = ref.createIdentity(), pid = P.newPairingId(), secret = P.newPairingSecret();
  const notifyKey = Buffer.alloc(32, 7).toString('base64url');
  const env = P.sealWelcome(computer, pid, secret, phone.publicKey, { computer: computer.id, phone: phone.id, notifyKey, lifetimeDays: 120, name: 'Mac' });
  assert.deepEqual(P.openWelcome(env, computer.publicKey, pid, secret, phone), { computer: computer.id, phone: phone.id, notifyKey, lifetimeDays: 120, name: 'Mac' });
  assert.throws(() => P.openWelcome(env, ref.createIdentity().publicKey, pid, secret, phone), /bad_signature/);
  assert.throws(() => P.openWelcome(env, computer.publicKey, pid, secret, ref.createIdentity()), /wrong_key/);
  // Someone with only the QR code (the pairing key) reads the welcome but not the notification key.
  const raw = Buffer.from(env.split('.')[2], 'base64url');
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', P.pairingKey(secret, pid), raw.subarray(0, 12));
  d.setAAD(Buffer.from(`girru/v1/pwel\n${pid}`));
  d.setAuthTag(raw.subarray(raw.length - 16));
  const inner = JSON.parse(Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString());
  assert.notEqual(inner.notifyKey, notifyKey);
  assert.equal(Buffer.from(inner.notifyKey, 'base64url').length, 60, 'nonce, wrapped key and tag');
  assert.ok(!Buffer.from(inner.notifyKey, 'base64url').includes(Buffer.alloc(32, 7)));
  const imposter = { ...ref.createIdentity(), id: phone.id };
  assert.throws(() => P.openWelcome(env, computer.publicKey, pid, secret, imposter), /bad_tag/, 'the wrong private key cannot unwrap it');
  const never = P.sealWelcome(computer, pid, secret, phone.publicKey, { computer: computer.id, phone: phone.id, notifyKey, lifetimeDays: null });
  assert.equal(P.openWelcome(never, computer.publicKey, pid, secret, phone).lifetimeDays, null);
  assert.throws(() => P.sealWelcome(computer, pid, secret, phone.publicKey, { computer: computer.id, phone: phone.id, notifyKey, lifetimeDays: 7 }), /bad_lifetime/);
  assert.throws(() => P.sealWelcome(computer, pid, secret, ref.createIdentity().publicKey, { computer: computer.id, phone: phone.id, notifyKey, lifetimeDays: 30 }), /wrong_key/);
});

test('notice: signed, sealed under the per-phone key, counter in the AAD, at most 3500 bytes', () => {
  const computer = ref.createIdentity(), phone = ref.createIdentity(), key = nodeCrypto.randomBytes(32);
  const env = P.sealNotice(computer, phone.id, key, 3, { kind: 'security', title: 'New phone paired', body: 'Work iPhone was paired.' });
  assert.match(env, /^g1\.ntf\./);
  assert.ok(Buffer.byteLength(env) <= 3500);
  const n = P.openNotice(env, computer.publicKey, phone.id, key);
  assert.equal(n.ctr, 3);
  assert.deepEqual(n.content, { kind: 'security', title: 'New phone paired', body: 'Work iPhone was paired.' });
  assert.throws(() => P.openNotice(env, computer.publicKey, phone.id, nodeCrypto.randomBytes(32)), /bad_tag/);
  assert.throws(() => P.sealNotice(computer, phone.id, key, 4, { kind: 'summary', title: 'a\u0000b', body: '' }), /bad_format/);
});
