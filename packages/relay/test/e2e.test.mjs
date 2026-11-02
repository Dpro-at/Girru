// MOB-SEC-01 reference code: session handshake, sealed envelopes and signed commands with replay rejection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIdentity, startHandshake, answerHandshake, finishHandshake, seal, open,
  signCommand, CommandVerifier, ProtocolError, peerKey, publicKeyText,
} from '../src/e2e.ts';

function sessions(now = Date.now()) {
  const computer = createIdentity(), phone = createIdentity();
  const { env, pending } = startHandshake(phone, computer.id, now);
  const answered = answerHandshake(computer, phone.publicKey, env, now);
  const phoneSession = finishHandshake(pending, computer.publicKey, answered.env, now);
  return { computer, phone, phoneSession, computerSession: answered.session };
}

const reason = (r) => (err) => err instanceof ProtocolError && err.reason === r;

test('both sides derive the same session and the keys differ per direction', () => {
  const { phoneSession, computerSession } = sessions();
  assert.equal(phoneSession.id, computerSession.id);
  assert.deepEqual(phoneSession.sendKey, computerSession.recvKey);
  assert.deepEqual(phoneSession.recvKey, computerSession.sendKey);
  assert.notDeepEqual(phoneSession.sendKey, phoneSession.recvKey);
});

test('seal and open round-trip; the plaintext never shows in the envelope', () => {
  const { phoneSession, computerSession } = sessions();
  const env = seal(phoneSession, 'SECRET-PLAINTEXT-MARKER');
  assert.match(env, /^g1\.msg\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.ok(!env.includes('SECRET'));
  assert.ok(!Buffer.from(env.split('.')[3], 'base64url').toString('latin1').includes('SECRET'));
  assert.equal(open(computerSession, env).toString(), 'SECRET-PLAINTEXT-MARKER');
  const bytes = new Uint8Array([0, 1, 2, 255]);
  assert.deepEqual(new Uint8Array(open(phoneSession, seal(computerSession, bytes))), bytes);
});

test('open refuses replays, reordering below the last seen number, tampering and other sessions', () => {
  const { phoneSession, computerSession } = sessions();
  const first = seal(phoneSession, 'one');
  const second = seal(phoneSession, 'two');
  open(computerSession, second);
  assert.throws(() => open(computerSession, second), reason('replay'));
  assert.throws(() => open(computerSession, first), reason('replay'));

  const third = seal(phoneSession, 'three');
  const parts = third.split('.');
  const body = Buffer.from(parts[3], 'base64url'); body[0] ^= 1;
  assert.throws(() => open(computerSession, [parts[0], parts[1], parts[2], body.toString('base64url')].join('.')), reason('bad_tag'));
  // Changing the authenticated header (here: a later sequence number) also fails the tag.
  const header = JSON.parse(Buffer.from(parts[2], 'base64url'));
  header.seq = 99;
  const moved = [parts[0], parts[1], Buffer.from(JSON.stringify(header)).toString('base64url'), parts[3]].join('.');
  assert.throws(() => open(computerSession, moved), reason('bad_tag'));
  assert.equal(open(computerSession, third).toString(), 'three', 'a failed attempt does not move the counter');

  const other = sessions();
  assert.throws(() => open(other.computerSession, seal(phoneSession, 'x')), reason('wrong_session'));
  assert.throws(() => open(computerSession, 'g1.msg.bad'), reason('bad_format'));
});

test('the handshake refuses a key it did not pair, a stale hello and a forged reply', () => {
  const computer = createIdentity(), phone = createIdentity(), intruder = createIdentity();
  const now = Date.now();
  const { env, pending } = startHandshake(phone, computer.id, now);
  assert.throws(() => answerHandshake(computer, intruder.publicKey, env, now), reason('bad_signature'));
  assert.throws(() => answerHandshake(computer, phone.publicKey, env, now + 10 * 60 * 1000), reason('stale'));

  // Someone in the middle (for example a hacked relay) answers with its own key.
  const fake = answerHandshake(intruder, phone.publicKey, startHandshake(phone, intruder.id, now).env, now);
  assert.throws(() => finishHandshake(pending, computer.publicKey, fake.env, now), reason('bad_signature'));
  assert.throws(() => finishHandshake(pending, intruder.publicKey, fake.env, now), reason('wrong_key'));

  // A reply made for a different hello does not finish this one.
  const answeredOther = answerHandshake(computer, phone.publicKey, startHandshake(phone, computer.id, now).env, now);
  assert.throws(() => finishHandshake(pending, computer.publicKey, answeredOther.env, now), reason('bad_format'));
});

test('peerKey checks the key matches the paired device id', () => {
  const phone = createIdentity(), other = createIdentity();
  assert.equal(peerKey(publicKeyText(phone.publicKey), phone.id).asymmetricKeyType, 'ec');
  assert.throws(() => peerKey(publicKeyText(phone.publicKey), other.id), reason('wrong_key'));
  assert.throws(() => peerKey('not-a-key'));
});

test('signed commands: accepted once from a paired device; replay, stale, forged, unknown and misaddressed are refused', () => {
  const computer = createIdentity(), phone = createIdentity(), stranger = createIdentity();
  const gate = new CommandVerifier(computer.id);
  assert.equal(gate.addDevice(phone.publicKey), phone.id);
  const now = Date.now();
  const body = JSON.stringify({ op: 'approve', id: 'req-42' });

  const c1 = signCommand(phone, computer.id, 1, body, now);
  assert.deepEqual(gate.verify(c1, now), { ok: true, device: phone.id, body });
  assert.deepEqual(gate.verify(c1, now), { ok: false, reason: 'replay' });
  assert.equal(gate.lastCounter(phone.id), 1);

  assert.deepEqual(gate.verify(signCommand(phone, computer.id, 1, body, now), now), { ok: false, reason: 'replay' }, 'same counter, new nonce');
  assert.deepEqual(gate.verify(signCommand(phone, computer.id, 2, body, now - 5 * 60 * 1000), now), { ok: false, reason: 'stale' });
  assert.deepEqual(gate.verify({ ...signCommand(phone, computer.id, 3, body, now), body: '{"op":"terminal"}' }, now), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(gate.verify(signCommand(stranger, computer.id, 1, body, now), now), { ok: false, reason: 'unknown_device' });
  assert.deepEqual(gate.verify(signCommand(phone, stranger.id, 4, body, now), now), { ok: false, reason: 'wrong_target' });
  assert.deepEqual(gate.verify({ device: phone.id }, now), { ok: false, reason: 'bad_format' });
  assert.deepEqual(gate.verify(signCommand(phone, computer.id, 0, body, now), now), { ok: false, reason: 'bad_format' });

  assert.equal(gate.verify(signCommand(phone, computer.id, 10, body, now), now).ok, true, 'counters may skip ahead');
  assert.equal(gate.verify(signCommand(phone, computer.id, 9, body, now), now).reason, 'replay');
});

test('revoke one and revoke all stop a device at once', () => {
  const computer = createIdentity(), a = createIdentity(), b = createIdentity();
  const gate = new CommandVerifier(computer.id);
  gate.addDevice(a.publicKey); gate.addDevice(b.publicKey);
  gate.revoke(a.id);
  assert.equal(gate.verify(signCommand(a, computer.id, 1, '{}')).reason, 'unknown_device');
  assert.equal(gate.verify(signCommand(b, computer.id, 1, '{}')).ok, true);
  gate.revokeAll();
  assert.equal(gate.verify(signCommand(b, computer.id, 2, '{}')).reason, 'unknown_device');
});

test('a counter restored from storage keeps old commands out after a restart', () => {
  const computer = createIdentity(), phone = createIdentity();
  const old = signCommand(phone, computer.id, 7, '{}');
  const gate = new CommandVerifier(computer.id);
  gate.addDevice(phone.publicKey, { lastCounter: 7 });
  assert.equal(gate.verify(old).reason, 'replay');
});

test('scan once, stay paired: the lifetime slides from the last use; an unused phone must pair again', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const computer = createIdentity(), phone = createIdentity(), forever = createIdentity();
  const gate = new CommandVerifier(computer.id);
  const t0 = Date.UTC(2026, 10, 2);
  gate.addDevice(phone.publicKey, { lifetimeDays: 30, lastUsed: t0 });
  gate.addDevice(forever.publicKey, { lifetimeDays: null, lastUsed: t0 });
  assert.throws(() => gate.addDevice(createIdentity().publicKey, { lifetimeDays: 45 }), reason('bad_lifetime'));

  // Used on day 29, then a handshake on day 58: each use renews the 30 days.
  assert.equal(gate.verify(signCommand(phone, computer.id, 1, '{}', t0 + 29 * DAY), t0 + 29 * DAY).ok, true);
  assert.equal(gate.touch(phone.id, t0 + 58 * DAY), true);
  assert.equal(gate.record(phone.id).lastUsed, t0 + 58 * DAY);

  // Unused for more than 30 days: refused and forgotten, even with a valid signature.
  const late = t0 + 89 * DAY;
  assert.deepEqual(gate.verify(signCommand(phone, computer.id, 2, '{}', late), late), { ok: false, reason: 'expired' });
  assert.equal(gate.verify(signCommand(phone, computer.id, 3, '{}', late), late).reason, 'unknown_device');

  // "Never" does not run out; the owner can change the lifetime later; revoke works whatever the lifetime.
  const years = t0 + 900 * DAY;
  assert.equal(gate.verify(signCommand(forever, computer.id, 1, '{}', years), years).ok, true);
  gate.setLifetime(forever.id, 60);
  assert.equal(gate.isActive(forever.id, years + 59 * DAY), true);
  assert.equal(gate.isActive(forever.id, years + 61 * DAY), false);
  const again = createIdentity();
  gate.addDevice(again.publicKey, { lifetimeDays: null });
  gate.revokeAll();
  assert.equal(gate.isActive(again.id), false);
});
