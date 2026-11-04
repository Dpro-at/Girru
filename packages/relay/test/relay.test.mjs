// MOB-RELAY-01: the relay forwards opaque envelopes between paired devices on 127.0.0.1,
// drops what it cannot deliver, and refuses oversized and flooded input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRelay } from '../src/relay.ts';
import { createIdentity, relayHello, startHandshake, answerHandshake, finishHandshake, seal, open } from '../src/e2e.ts';
import { b64url } from '../src/encoding.ts';
import { connect, openClient } from './helpers.mjs';

const newPairingId = () => `p_${b64url(randomBytes(32))}`;

async function startRelay(options = {}) {
  const relay = createRelay({ port: 0, ...options });
  const { host, port } = await relay.listen();
  return { relay, host, url: `ws://127.0.0.1:${port}/v1`, port };
}

async function pair(url) {
  const computer = createIdentity(), phone = createIdentity();
  const a = await connect(url, { identity: computer, allow: [phone.id] });
  const b = await connect(url, { identity: phone, allow: [computer.id] });
  return { computer, phone, a, b };
}

test('binds to 127.0.0.1 by default and answers the health check', async () => {
  const { relay, host, port } = await startRelay();
  try {
    assert.equal(host, '127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/anything`)).status, 404);
  } finally { await relay.close(); }
});

test('two paired clients run the handshake and exchange sealed envelopes through the relay', async () => {
  const { relay, url } = await startRelay();
  try {
    const { computer, phone, a, b } = await pair(url);
    assert.equal(a.ready.id, computer.id);
    assert.equal(b.ready.id, phone.id);

    const { env: hs1, pending } = startHandshake(phone, computer.id);
    b.send(computer.id, hs1);
    const got1 = await a.next((f) => f.t === 'msg');
    assert.equal(got1.from, phone.id, 'the relay stamps the proven sender id');
    const answered = answerHandshake(computer, phone.publicKey, got1.env);
    a.send(phone.id, answered.env);
    const got2 = await b.next((f) => f.t === 'msg');
    const phoneSession = finishHandshake(pending, computer.publicKey, got2.env);

    b.send(computer.id, seal(phoneSession, 'approve request 42'));
    const m1 = await a.next((f) => f.t === 'msg');
    assert.equal(open(answered.session, m1.env).toString(), 'approve request 42');

    a.send(phone.id, seal(answered.session, 'done'));
    const m2 = await b.next((f) => f.t === 'msg');
    assert.equal(open(phoneSession, m2.env).toString(), 'done');

    assert.deepEqual(relay.stats(), { connections: 2, devices: 2, pairings: 0 });
    await a.close(); await b.close();
  } finally { await relay.close(); }
});

test('an envelope to an unknown, offline or not-allowing device is dropped and reported, never stored', async () => {
  const { relay, url } = await startRelay();
  try {
    const { computer, phone, a, b } = await pair(url);
    const stranger = await connect(url, { allow: [computer.id] });

    a.send(b64url(randomBytes(32)), 'g1.msg.unknown.x', 'r1');
    assert.deepEqual(await a.next((f) => f.t === 'drop'), { t: 'drop', reason: 'offline', ref: 'r1' });

    // The computer does not allow the stranger: it looks exactly like offline.
    stranger.send(computer.id, 'g1.msg.spam.x', 'r2');
    assert.deepEqual(await stranger.next((f) => f.t === 'drop'), { t: 'drop', reason: 'offline', ref: 'r2' });

    await b.close();
    await new Promise((r) => setTimeout(r, 50));
    a.send(phone.id, 'g1.msg.later.x', 'r3');
    assert.deepEqual(await a.next((f) => f.t === 'drop'), { t: 'drop', reason: 'offline', ref: 'r3' });

    // When the phone comes back nothing old is waiting for it.
    const back = await connect(url, { identity: phone, allow: [computer.id] });
    await assert.rejects(back.next((f) => f.t === 'msg', 200), /timed out/);

    // Revoke from the computer: an empty allow list stops the phone at the relay too.
    a.sendFrame({ t: 'allow', allow: [] });
    await a.next((f) => f.t === 'allowed');
    back.send(computer.id, 'g1.msg.after-revoke.x', 'r4');
    assert.equal((await back.next((f) => f.t === 'drop')).reason, 'offline');
    await a.close(); await back.close(); await stranger.close();
  } finally { await relay.close(); }
});

test('a pairing id lets a new phone reach the computer once, for a short time, without being allowed yet', async () => {
  const { relay, url } = await startRelay({ pairingMessages: 1 });
  try {
    const pairingId = newPairingId(), held = newPairingId();
    const computer = await connect(url, { pairing: [pairingId, held] });
    const phone = await connect(url, { allow: [computer.id] });
    phone.sendPairing(pairingId, 'g1.pair.request.x');
    const got = await computer.next((f) => f.t === 'msg');
    assert.deepEqual(got, { t: 'msg', from: phone.id, via: pairingId, env: 'g1.pair.request.x' });
    phone.sendPairing(pairingId, 'g1.pair.again.x', 'again');
    assert.equal((await phone.next((f) => f.t === 'drop')).ref, 'again', 'the pairing id is used up');

    // Another connection cannot take an open pairing id.
    const other = await connect(url, { pairing: [newPairingId()] });
    other.sendFrame({ t: 'pairing', open: [held] });
    const reply = await other.next((f) => f.t === 'paired');
    assert.deepEqual(reply.refused, [held]);
    await computer.close(); await phone.close(); await other.close();
  } finally { await relay.close(); }
});

test('the hello must be signed by the key behind the device id', async () => {
  const { relay, url } = await startRelay();
  try {
    const client = await openClient(url);
    const challenge = await client.next((f) => f.t === 'challenge');
    const forged = relayHello(createIdentity(), challenge, url);
    forged.key = relayHello(client.identity, challenge, url).key; // someone else's key, wrong signature
    client.sendFrame(forged);
    assert.equal(await client.closed, 1008);

    const early = await openClient(url);
    await early.next((f) => f.t === 'challenge');
    early.send(createIdentity().id, 'g1.msg.x.y');
    assert.equal(await early.closed, 1008, 'nothing is forwarded before the hello');
    assert.equal(relay.stats().devices, 0);
  } finally { await relay.close(); }
});

test('a reconnecting device replaces its old connection', async () => {
  const { relay, url } = await startRelay();
  try {
    const identity = createIdentity();
    const first = await connect(url, { identity });
    const second = await connect(url, { identity });
    assert.equal(await first.closed, 4001);
    assert.equal(relay.stats().devices, 1);
    await second.close();
  } finally { await relay.close(); }
});

test('an oversized envelope or frame is refused', async () => {
  const { relay, url } = await startRelay({ maxEnvelopeBytes: 4096 });
  try {
    const { phone, a } = await pair(url);
    a.send(phone.id, 'x'.repeat(4097), 'big');
    assert.deepEqual(await a.next((f) => f.t === 'error'), { t: 'error', code: 'too_large', ref: 'big' });
    a.sendFrame({ t: 'send', to: phone.id, env: 'x'.repeat(64 * 1024) });
    assert.equal(await a.closed, 1009, 'a frame above the limit closes the connection before it is buffered');
  } finally { await relay.close(); }
});

test('flooded input is refused and a flooding connection is closed', async () => {
  const { relay, url } = await startRelay({ messagesPerSecond: 1, burstMessages: 5, maxStrikes: 20 });
  try {
    const { phone, a, b } = await pair(url);
    for (let i = 0; i < 40; i++) a.send(phone.id, `g1.msg.flood${i}.x`);
    assert.equal((await a.next((f) => f.t === 'error')).code, 'rate_limited');
    assert.equal(await a.closed, 1008);
    const delivered = [];
    while (true) {
      try { delivered.push(await b.next((f) => f.t === 'msg', 200)); } catch { break; }
    }
    assert.ok(delivered.length <= 6, `only the burst got through (${delivered.length})`);
    await b.close();
  } finally { await relay.close(); }
});

test('malformed frames are refused without being forwarded', async () => {
  const { relay, url } = await startRelay();
  try {
    const { phone, a, b } = await pair(url);
    for (const bad of ['not json', '[]', { t: 'send', to: 'short', env: 'x' }, { t: 'send', to: phone.id, env: 'has spaces' }, { t: 'send', to: phone.id, env: '' }, { t: 'nope' }, { t: 'allow', allow: ['x'] }]) {
      a.sendFrame(bad);
      assert.equal((await a.next((f) => f.t === 'error')).t, 'error', JSON.stringify(bad));
    }
    await assert.rejects(b.next((f) => f.t === 'msg', 200), /timed out/);
    await a.close(); await b.close();
  } finally { await relay.close(); }
});

test('a connection that never says hello is closed', async () => {
  const { relay, url } = await startRelay({ helloTimeoutMs: 100 });
  try {
    const client = await openClient(url);
    assert.equal(await client.closed, 1008);
    assert.equal(relay.stats().connections, 0);
  } finally { await relay.close(); }
});
