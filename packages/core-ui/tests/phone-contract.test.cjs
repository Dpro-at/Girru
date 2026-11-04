// MOB-PAIR-01: the phone routes pass only with exact bodies, and only known
// fields and fixed codes come back, in the page client and in the bridge.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { allowedRequest, createSameOriginTransport } = require('../src/session.ts');
const { allowedPhone, phoneResponse, phoneRoute } = require('../src/phone-contract.js');
const { createApplicationServer, allowed, project } = require('../scripts/application-server.cjs');

const PID = 'ps_' + 'a'.repeat(22), DID = 'D'.repeat(43);
const QR = 'girru://pair?v=1&cid=' + 'C'.repeat(43) + '&pid=pr_x&ps=abc&exp=1793000000&relay=wss%3A%2F%2Frelay.girru.net%2Fv1&name=Mac';
const device = { id: DID, name: "Mohamed's iPhone", model: 'ios', path: 'anywhere', lifetimeDays: 90, status: 'active', pairedAt: '2026-11-03T10:00:00.000Z', lastUsedAt: '2026-11-03T10:05:00.000Z', expiresAt: '2027-02-01T10:05:00.000Z' };
const both = (m, p, b) => [allowedPhone(m, p, b), allowedRequest(m, p, b), allowed(m, p, b)];

test('routes: exact paths and ids only', () => {
  for (const p of ['/api/phone', '/api/phone/pairing', `/api/phone/pairing/${PID}`, `/api/phone/pairing/${PID}/allow`, `/api/phone/pairing/${PID}/deny`, `/api/phone/devices/${DID}`, '/api/phone/devices/forget-all', '/api/phone/settings']) assert.equal(phoneRoute(p), true, p);
  for (const p of ['/api/phone/', '/api/phone?x=1', '/api/phone/pairing/ps_short', `/api/phone/pairing/${PID}/other`, '/api/phone/devices/abc', `/api/phone/devices/${DID}/x`, '/api/phone/other']) assert.equal(phoneRoute(p), false, p);
});

test('requests: exact bodies in the page client and the bridge', () => {
  const ok = [['GET', '/api/phone', undefined], ['POST', '/api/phone/pairing', { path: 'anywhere' }], ['POST', '/api/phone/pairing', { path: 'wifi' }],
    ['GET', `/api/phone/pairing/${PID}`, undefined], ['DELETE', `/api/phone/pairing/${PID}`, undefined],
    ['POST', `/api/phone/pairing/${PID}/allow`, { lifetimeDays: 90, path: 'anywhere' }], ['POST', `/api/phone/pairing/${PID}/allow`, { lifetimeDays: null, path: 'wifi' }],
    ['POST', `/api/phone/pairing/${PID}/deny`, undefined], ['PATCH', `/api/phone/devices/${DID}`, { name: 'Work phone' }], ['PATCH', `/api/phone/devices/${DID}`, { path: 'wifi', lifetimeDays: 30 }],
    ['DELETE', `/api/phone/devices/${DID}`, undefined], ['POST', '/api/phone/devices/forget-all', undefined],
    ['PUT', '/api/phone/settings', { relayUrl: 'wss://relay.example.com/v1' }], ['PUT', '/api/phone/settings', { relayUrl: 'ws://127.0.0.1:8080/v1' }]];
  for (const [m, p, b] of ok) assert.deepEqual(both(m, p, b), [true, true, true], `${m} ${p}`);
  const bad = [['POST', '/api/phone', undefined], ['POST', '/api/phone/pairing', { path: 'lan' }], ['POST', '/api/phone/pairing', { path: 'wifi', extra: 1 }], ['POST', '/api/phone/pairing', undefined],
    ['POST', `/api/phone/pairing/${PID}/allow`, { lifetimeDays: 45, path: 'anywhere' }], ['POST', `/api/phone/pairing/${PID}/allow`, { lifetimeDays: 90 }],
    ['POST', `/api/phone/pairing/${PID}/deny`, {}], ['PATCH', `/api/phone/devices/${DID}`, {}], ['PATCH', `/api/phone/devices/${DID}`, { name: 'x‮' }], ['PATCH', `/api/phone/devices/${DID}`, { name: 'x'.repeat(65) }],
    ['PATCH', `/api/phone/devices/${DID}`, { publicKey: 'x' }], ['POST', '/api/phone/devices/forget-all', { all: true }],
    ['PUT', '/api/phone/settings', { relayUrl: 'ws://relay.example.com/v1' }], ['PUT', '/api/phone/settings', { relayUrl: 'https://relay.example.com/v1' }], ['PUT', '/api/phone/settings', { relayUrl: 'wss://x/v1', lan: 1 }],
    ['GET', `/api/phone/pairing/${PID}`, {}]];
  for (const [m, p, b] of bad) assert.deepEqual(both(m, p, b), [false, false, false], `${m} ${p} ${JSON.stringify(b)}`);
});

test('replies: known fields only, names made safe, fixed codes, malformed answers fail', () => {
  const o = phoneResponse('/api/phone', 200, { computer: { id: 'C'.repeat(43), name: 'Mac', secret: 1 }, devices: [{ ...device, publicKey: 'x', name: 'Evil‮name' }], relayUrl: 'wss://relay.girru.net/v1', connection: 'connected', wifi: 'off', extra: 1 });
  assert.deepEqual(o, { computer: { id: 'C'.repeat(43), name: 'Mac' }, devices: [{ ...device, name: 'Evilname' }], relayUrl: 'wss://relay.girru.net/v1', connection: 'connected', wifi: 'off' });
  assert.deepEqual(phoneResponse('/api/phone', 200, o), o, 'a second projection keeps it');
  assert.throws(() => phoneResponse('/api/phone', 200, { ...o, wifi: 'maybe' }), /protocol/);
  assert.deepEqual(phoneResponse('/api/phone/pairing', 201, { id: PID, qr: QR, expiresAt: '2026-11-03T10:02:00.000Z', secret: 'x' }), { id: PID, qr: QR, expiresAt: '2026-11-03T10:02:00.000Z' });
  assert.throws(() => phoneResponse('/api/phone/pairing', 201, { id: PID, qr: 'javascript:alert(1)', expiresAt: '2026-11-03T10:02:00.000Z' }), /protocol/);
  assert.throws(() => phoneResponse('/api/phone/pairing', 201, { id: PID, qr: QR + '<x>', expiresAt: '2026-11-03T10:02:00.000Z' }), /protocol/);
  const s = `/api/phone/pairing/${PID}`;
  assert.deepEqual(phoneResponse(s, 200, { state: 'request', qr: null, expiresAt: null, request: { name: 'Pixel', model: 'android', checkCode: '482913', lifetimeDays: 60, key: 'x' } }),
    { state: 'request', qr: null, expiresAt: null, request: { name: 'Pixel', model: 'android', checkCode: '482913', lifetimeDays: 60 } });
  assert.throws(() => phoneResponse(s, 200, { state: 'request', qr: null, expiresAt: null, request: { name: 'Pixel', model: 'android', checkCode: '48291' } }), /protocol/);
  assert.deepEqual(phoneResponse(s, 200, { state: 'cancelled', qr: null, expiresAt: null, warning: 'second_request' }), { state: 'cancelled', qr: null, expiresAt: null, warning: 'second_request' });
  assert.deepEqual(phoneResponse(s, 200, { state: 'paired', qr: null, expiresAt: null, deviceId: DID }), { state: 'paired', qr: null, expiresAt: null, deviceId: DID });
  assert.deepEqual(phoneResponse(s, 200, { ok: true }), { ok: true });
  assert.deepEqual(phoneResponse(`${s}/allow`, 200, { deviceId: DID, token: 'x' }), { deviceId: DID });
  assert.deepEqual(phoneResponse('/api/phone/devices/forget-all', 200, { forgotten: 2 }), { forgotten: 2 });
  assert.deepEqual(phoneResponse('/api/phone/settings', 200, { relayUrl: 'wss://r.example/v1' }), { relayUrl: 'wss://r.example/v1' });
  assert.deepEqual(phoneResponse('/api/phone/pairing', 409, { code: 'wifi_off', message: 'backend text' }), { code: 'wifi_off' });
  assert.deepEqual(phoneResponse(`${s}/allow`, 409, { code: 'made_up' }), { code: 'conflict' });
  assert.deepEqual(phoneResponse(s, 404, null), { code: 'not_found' });
  assert.deepEqual(phoneResponse('/api/phone', 503, { code: 'identity_unavailable' }), { code: 'identity_unavailable' });
  assert.deepEqual(phoneResponse('/api/phone', 500, { code: 'stack', message: 'secret' }), { code: 'unavailable' });
  assert.deepEqual(project('/api/phone', 403, { code: 'owner_only', message: 'x' }), { code: 'forbidden' });
});

const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('bridge: forwards exact phone requests and projects the replies', async t => {
  const calls = []; let status = 201, reply = { id: PID, qr: QR, expiresAt: '2026-11-03T10:02:00.000Z', secret: 'leak' };
  const backend = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c);
    calls.push({ method: req.method, path: req.url, body: Buffer.concat(parts).toString() });
    res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(reply));
  });
  const upstreamPort = await listen(backend); t.after(() => close(backend));
  const app = createApplicationServer({ channel: 'candidate', upstreamPort });
  const port = await listen(app); t.after(() => close(app)); const origin = `http://127.0.0.1:${port}`;
  const send = (path, method, body) => new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers: { Origin: origin, Authorization: 'Bearer fictional', ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) } : {}) } }, res => {
      const parts = []; res.on('data', c => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString() }));
    }); req.on('error', reject); req.end(bytes);
  });
  const started = await send('/api/phone/pairing', 'POST', { path: 'anywhere' });
  assert.equal(started.status, 201); assert.deepEqual(JSON.parse(started.body), { id: PID, qr: QR, expiresAt: '2026-11-03T10:02:00.000Z' });
  assert.deepEqual(JSON.parse(calls[0].body), { path: 'anywhere' });
  status = 409; reply = { code: 'wifi_off', message: 'backend text' };
  const off = await send('/api/phone/pairing', 'POST', { path: 'wifi' });
  assert.equal(off.status, 409); assert.deepEqual(JSON.parse(off.body), { code: 'wifi_off' });
  status = 200; reply = { state: 'waiting', qr: 'not a pairing code', expiresAt: '2026-11-03T10:02:00.000Z' };
  assert.equal((await send(`/api/phone/pairing/${PID}`, 'GET')).status, 502, 'a malformed answer fails closed');
  reply = { ok: true };
  assert.equal((await send(`/api/phone/devices/${DID}`, 'DELETE')).status, 200);
  assert.equal(calls.at(-1).method, 'DELETE');
  const n = calls.length;
  assert.equal((await send('/api/phone/pairing', 'POST', { path: 'anywhere', relay: 'x' })).status, 400);
  assert.equal((await send(`/api/phone/devices/${DID}`, 'PATCH', { owner: 'x' })).status, 400);
  assert.equal((await send('/api/phone/settings', 'PUT', { relayUrl: 'wss://evil.example/other' })).status, 400);
  assert.equal(calls.length, n, 'refused requests never reach the backend');
});

test('page transport: no backend text reaches the page', async () => {
  const transport = createSameOriginTransport('http://127.0.0.1:42522', async () => new Response(JSON.stringify({ code: 'pairing_closed', message: 'backend text' }), { status: 409, headers: { 'Content-Type': 'application/json' } }));
  const r = await transport({ method: 'POST', path: `/api/phone/pairing/${PID}/allow`, body: { lifetimeDays: 90, path: 'anywhere' }, headers: { Authorization: 'Bearer fictional' }, signal: new AbortController().signal });
  assert.deepEqual(r, { status: 409, body: { code: 'pairing_closed' } });
  await assert.rejects(transport({ method: 'POST', path: '/api/phone/pairing', body: { path: 'lan' }, headers: { Authorization: 'Bearer fictional' }, signal: new AbortController().signal }));
});
