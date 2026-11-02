// Relay hardening: pairing ids and device ids never mix, WebSocket-level floods are cut off,
// and a signed hello is good for one relay only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect as tcpConnect } from 'node:net';
import { Duplex } from 'node:stream';
import { randomBytes, sign } from 'node:crypto';
import { createRelay } from '../src/relay.ts';
import { WsConnection, MAX_FRAGMENTS } from '../src/websocket.ts';
import { createIdentity, relayHello, publicKeyText, ProtocolError } from '../src/e2e.ts';
import { b64url, relayHelloBytes } from '../src/encoding.ts';
import { connect, openClient } from './helpers.mjs';

const newPairingId = () => `p_${b64url(randomBytes(32))}`;

async function startRelay(options = {}) {
  const relay = createRelay({ port: 0, ...options });
  const { port } = await relay.listen();
  return { relay, port, url: `ws://127.0.0.1:${port}/v1` };
}

/** A raw TCP WebSocket client, so tests can send frames a normal client never would. */
function rawClient(port) {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect(port, '127.0.0.1');
    let buf = Buffer.alloc(0), upgraded = false;
    const closed = new Promise((done) => {
      socket.on('close', () => done(closeCode()));
    });
    function closeCode() {
      // Walk the server's frames and return the code of its close frame, if any.
      let b = buf;
      while (b.length >= 2) {
        const op = b[0] & 0x0f; let len = b[1] & 0x7f, off = 2;
        if (len === 126) { len = b.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(b.readBigUInt64BE(2)); off = 10; }
        if (b.length < off + len) break;
        if (op === 0x8) return b.readUInt16BE(off);
        b = b.subarray(off + len);
      }
      return null;
    }
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!buf.subarray(0, end).toString().startsWith('HTTP/1.1 101')) return reject(new Error('no upgrade'));
        upgraded = true;
        buf = buf.subarray(end + 4);
        resolve({ socket, closed, frame });
      }
    });
    socket.write(`GET /v1 HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n\r\n`);
  });
}

/** A masked client frame (mask key 0, so the payload goes as is). */
function frame(opcode, payload = Buffer.alloc(0), fin = true) {
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | payload.length, 0, 0, 0, 0]), payload]);
}

// ---------- 1. pairing ids and device ids are separate namespaces ----------

test('pairing targets use their own field and their own prefixed id format; no fallback between the two', async () => {
  const { relay, url } = await startRelay();
  try {
    const pid = newPairingId();
    const computer = await connect(url, { pairing: [pid] });
    const phone = await connect(url, { allow: [computer.id] });

    // A pairing id in `to`, a device id in `pairing`, both fields, or neither: refused, nothing forwarded.
    for (const bad of [
      { t: 'send', to: pid, env: 'g1.x.y' },
      { t: 'send', pairing: computer.id, env: 'g1.x.y' },
      { t: 'send', to: computer.id, pairing: pid, env: 'g1.x.y' },
      { t: 'send', env: 'g1.x.y' },
    ]) {
      phone.sendFrame(bad);
      assert.equal((await phone.next((f) => f.t === 'error')).code, 'bad_frame', JSON.stringify(bad));
    }
    await assert.rejects(computer.next((f) => f.t === 'msg', 150), /timed out/);

    // `to` naming a device that does not allow the sender is dropped, never routed to a pairing.
    phone.send(computer.id, 'g1.x.y', 'dev');
    assert.equal((await phone.next((f) => f.t === 'drop')).ref, 'dev');
    await assert.rejects(computer.next((f) => f.t === 'msg', 150), /timed out/);

    // The pairing field reaches only the pairing id.
    phone.sendPairing(pid, 'g1.pair.ok');
    assert.equal((await computer.next((f) => f.t === 'msg')).via, pid);
    await computer.close(); await phone.close();
  } finally { await relay.close(); }
});

test('a pairing id that could collide with a device id cannot be opened', async () => {
  const { relay, url } = await startRelay();
  try {
    const victim = await connect(url);
    // In the hello: a device-id-shaped pairing id closes the connection.
    const client = await openClient(url);
    const challenge = await client.next((f) => f.t === 'challenge');
    client.sendFrame(relayHello(client.identity, challenge, url, [], [victim.id]));
    assert.equal(await client.closed, 1008);
    // Later: the same is refused as a bad frame.
    const computer = await connect(url);
    computer.sendFrame({ t: 'pairing', open: [victim.id] });
    assert.equal((await computer.next((f) => f.t === 'error')).code, 'bad_frame');
    assert.equal(relay.stats().pairings, 0);
    await victim.close(); await computer.close();
  } finally { await relay.close(); }
});

// ---------- 2. WebSocket-level limits ----------

test('a message split into too many fragments is refused', async () => {
  const { relay, port } = await startRelay({ controlFramesPerSecond: 1_000_000 });
  try {
    const c = await rawClient(port);
    const parts = [frame(0x1, Buffer.from('{'), false)];
    for (let i = 0; i < MAX_FRAGMENTS + 10; i++) parts.push(frame(0x0, Buffer.alloc(0), false));
    c.socket.write(Buffer.concat(parts));
    assert.equal(await c.closed, 1009);
  } finally { await relay.close(); }
});

test('control and continuation floods are rate limited', async () => {
  const { relay, port } = await startRelay({ controlFramesPerSecond: 10 });
  try {
    const pings = await rawClient(port);
    pings.socket.write(Buffer.concat(Array.from({ length: 100 }, () => frame(0x9))));
    assert.equal(await pings.closed, 1008);

    const continuations = await rawClient(port);
    const parts = [frame(0x1, Buffer.from('{'), false)];
    for (let i = 0; i < 100; i++) parts.push(frame(0x0, Buffer.alloc(0), false));
    continuations.socket.write(Buffer.concat(parts));
    assert.equal(await continuations.closed, 1008);
  } finally { await relay.close(); }
});

test('a peer that never reads is dropped once its queue passes the limit, even if it is only pongs', () => {
  // A socket whose writes never complete, like a peer that stopped reading.
  const stuck = new Duplex({ read() {}, write(_chunk, _enc, _cb) { /* never acknowledged */ } });
  let closed = false;
  const ws = new WsConnection(stuck, { maxMessageBytes: 1024, maxQueuedBytes: 1000, controlFramesPerSecond: 1_000_000 },
    { onText() {}, onPong() {}, onClose() { closed = true; } });
  const ping = frame(0x9, Buffer.alloc(100, 1));
  for (let i = 0; i < 20 && !closed; i++) stuck.emit('data', ping); // each ping queues a 102-byte pong
  assert.equal(closed, true);
  assert.equal(ws.isOpen, false);
  assert.equal(stuck.destroyed, true);
});

// ---------- 3. the hello is bound to one relay ----------

test('the challenge names the relay and the device refuses a challenge from a relay it did not dial', async () => {
  const { relay, url } = await startRelay();
  try {
    const client = await openClient(url);
    const challenge = await client.next((f) => f.t === 'challenge');
    assert.equal(challenge.relay, url);
    assert.throws(() => relayHello(client.identity, challenge, 'wss://other.example.org/v1'),
      (e) => e instanceof ProtocolError && e.reason === 'wrong_relay');
    await client.close();
  } finally { await relay.close(); }
});

test('a hello signed for another relay, or without the relay name, is refused', async () => {
  const a = await startRelay({ relayUrl: 'wss://relay-a.example.org/v1' });
  const b = await startRelay();
  try {
    // Relay A uses its configured name in the challenge.
    const atA = await openClient(a.url);
    assert.equal((await atA.next((f) => f.t === 'challenge')).relay, 'wss://relay-a.example.org/v1');
    await atA.close();

    const identity = createIdentity();
    for (const bytesFor of [
      (nonce) => relayHelloBytes('wss://relay-a.example.org/v1', nonce), // made for relay A, replayed at B
      (nonce) => Buffer.from(`girru/relay/v1/hello\n${nonce}`),            // the old form without a relay name
    ]) {
      const client = await openClient(b.url, identity);
      const challenge = await client.next((f) => f.t === 'challenge');
      const sig = b64url(sign('sha256', bytesFor(challenge.nonce), identity.privateKey));
      client.sendFrame({ t: 'hello', v: 1, key: publicKeyText(identity.publicKey), sig, allow: [], pairing: [] });
      assert.equal(await client.closed, 1008);
    }
    assert.equal(b.relay.stats().devices, 0);
  } finally { await a.relay.close(); await b.relay.close(); }
});

test('a relay name that is not a ws(s) URL ending in /v1 is refused at start', () => {
  assert.throws(() => createRelay({ relayUrl: 'https://relay.example.org' }));
});
