// MOB-PAIR-01: Settings › Phone on the computer, without a relay.
//  - migration 164 tables; the computer identity's private key is stored only encrypted;
//  - owner-only API with exact bodies and plain error codes (user, admin, no token refused);
//  - a pairing renews its QR code (new pairing id, secret and expiry; the old id stops working);
//  - device patch / forget / forget-all, sliding lifetime, the read-only phone_devices tool;
//  - with the background off nothing dials out (no WebSocket is created).
// Throwaway DB and keys; no network.
// Run: node --import tsx --import ../../scripts/test-temp-root.mjs --test test/phone-api.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-phone-api-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.AGENT_PLAYER_BACKGROUND = 'off';
const sockets = [];
globalThis.WebSocket = class { constructor(url) { sockets.push(String(url)); throw new Error('no network in this test'); } };
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
for (const [id, role] of [['ph-owner', 'owner'], ['ph-admin', 'admin'], ['ph-user', 'user']]) {
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', ?, 'active', 1)`).run(id, `${id}@example.test`, id, role);
}
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { phoneLink, QR_RENEW_MS, PAIRING_MAX_MS } = await import(join(backendDir, 'src/phone/service.ts'));
const store = await import(join(backendDir, 'src/phone/store.ts'));
const P = await import(join(backendDir, 'src/phone/protocol/pairing.ts'));
const E = await import(join(backendDir, 'src/phone/protocol/e2e.ts'));
const { phoneDevicesTool } = await import(join(backendDir, 'src/tools/phone.ts'));
const app = await buildServer({ logger: false });
await app.ready();

const as = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
const call = (user, method, url, payload) => app.inject({ method, url, headers: user ? as(user) : {}, ...(payload !== undefined ? { payload } : {}) });
const DAY = 24 * 60 * 60 * 1000;

test.after(async () => { await phoneLink().stop(); await app.close(); });

// Everything the link sends (no relay here): pairing challenges and welcomes are read from it.
const sent = [];
{
  const link = phoneLink();
  const real = link.deliver.bind(link);
  link.deliver = (id, env, ...rest) => { sent.push({ id, env }); return real(id, env, ...rest); };
}
const challengeFor = (phone, qr) => {
  const f = [...sent].reverse().find((m) => m.id === phone.id && m.env.startsWith('g1.pchal.'));
  return f ? P.openChallenge(f.env, qr.computerKey, qr.pairingId, qr.secret, phone.id) : null;
};
/** Opens a pairing and feeds a request from `phone` in, as the relay would. */
async function requestFrom(phone, name = 'Phone', opts = {}) {
  const p = (await call('ph-owner', 'POST', '/api/phone/pairing', { path: 'anywhere' })).json();
  const qr = P.readQr(p.qr);
  phoneLink().onEnvelope(phone.id, P.sealPairingRequest(phone, qr.pairingId, qr.secret, { name, platform: 'ios', ...opts }), qr.pairingId, 'relay');
  return { p, qr };
}

test('migration 164 creates the phone tables', () => {
  for (const t of ['phone_identity', 'phone_devices', 'phone_settings', 'phone_approvals_shown']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t), t);
  }
  assert.throws(() => db.prepare("INSERT INTO phone_devices (id, owner_id, name, public_key, path, created_at, last_used_at) VALUES ('x', 'o', 'n', 'k', 'bluetooth', 1, 1)").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO phone_devices (id, owner_id, name, public_key, lifetime_days, created_at, last_used_at) VALUES ('x', 'o', 'n', 'k', 45, 1, 1)").run(), /CHECK/);
});

test('every phone route is owner only; agents and other people are refused', async () => {
  const routes = [['GET', '/api/phone'], ['POST', '/api/phone/pairing', { path: 'anywhere' }], ['GET', '/api/phone/pairing/ps_AAAAAAAAAAAAAAAAAAAAAA'],
    ['POST', '/api/phone/pairing/ps_AAAAAAAAAAAAAAAAAAAAAA/allow', { lifetimeDays: 30, path: 'anywhere' }], ['POST', '/api/phone/pairing/ps_AAAAAAAAAAAAAAAAAAAAAA/deny'],
    ['DELETE', '/api/phone/pairing/ps_AAAAAAAAAAAAAAAAAAAAAA'], ['PATCH', `/api/phone/devices/${'a'.repeat(43)}`, { name: 'x' }], ['DELETE', `/api/phone/devices/${'a'.repeat(43)}`],
    ['POST', '/api/phone/devices/forget-all'], ['PUT', '/api/phone/settings', { relayUrl: 'wss://relay.example.org/v1' }]];
  for (const [method, url, body] of routes) {
    assert.equal((await call(null, method, url, body)).statusCode, 401, `${method} ${url} without a token`);
    for (const who of ['ph-user', 'ph-admin']) assert.equal((await call(who, method, url, body)).statusCode, 403, `${method} ${url} as ${who}`);
  }
  const { resolveRouteAccess } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
  for (const [method, url] of routes) assert.equal(resolveRouteAccess(method, url.replace(/ps_A+|a{43}/, ':id')), 'owner');
});

test('GET /api/phone before anything is paired; nothing dials out with the background off', async () => {
  const r = await call('ph-owner', 'GET', '/api/phone');
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.deepEqual(r.json(), { computer: null, devices: [], relayUrl: 'wss://relay.girru.net/v1', connection: 'off', wifi: 'off' });
});

test('settings: only wss://host/v1 (ws:// only to this computer), exact body', async () => {
  for (const body of [{}, { relayUrl: 'https://relay.example.org/v1' }, { relayUrl: 'ws://relay.example.org/v1' }, { relayUrl: 'wss://relay.example.org/v2' }, { relayUrl: 'wss://relay.example.org/v1', extra: 1 }, { relayUrl: 'wss://a b/v1' }]) {
    const r = await call('ph-owner', 'PUT', '/api/phone/settings', body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.deepEqual(r.json(), { code: 'invalid_request' });
  }
  assert.deepEqual((await call('ph-owner', 'PUT', '/api/phone/settings', { relayUrl: 'ws://127.0.0.1:41540/v1' })).json(), { relayUrl: 'ws://127.0.0.1:41540/v1' });
  assert.equal((await call('ph-owner', 'PUT', '/api/phone/settings', { relayUrl: 'wss://relay.example.org/v1' })).statusCode, 200);
  assert.equal((await call('ph-owner', 'GET', '/api/phone')).json().relayUrl, 'wss://relay.example.org/v1');
});

let pairing;
test('a pairing shows a QR code that the phone can read; the computer identity is kept encrypted', async () => {
  for (const body of [undefined, {}, { path: 'bluetooth' }, { path: 'anywhere', x: 1 }]) assert.equal((await call('ph-owner', 'POST', '/api/phone/pairing', body)).statusCode, 400);
  assert.deepEqual((await call('ph-owner', 'POST', '/api/phone/pairing', { path: 'wifi' })).json(), { code: 'wifi_off' }, 'the Wi-Fi path is off by default');
  const r = await call('ph-owner', 'POST', '/api/phone/pairing', { path: 'anywhere' });
  assert.equal(r.statusCode, 201, r.body);
  pairing = r.json();
  assert.deepEqual(Object.keys(pairing).sort(), ['expiresAt', 'id', 'qr']);
  const qr = P.readQr(pairing.qr);
  assert.equal(qr.relay, 'wss://relay.example.org/v1');
  assert.ok(qr.expiresAt - Date.now() <= QR_RENEW_MS + 1000, 'a code lives 2 minutes');
  assert.equal(QR_RENEW_MS, 2 * 60 * 1000);
  const row = db.prepare("SELECT * FROM phone_identity WHERE id = 'computer'").get();
  assert.equal(row.device_id, qr.computerId);
  assert.ok(!/MIG|BEGIN/.test(row.private_key_enc) && row.private_key_enc.length > 100);
  const loaded = await store.loadIdentity(false);
  assert.equal(loaded.id, qr.computerId, 'the stored identity decrypts to the key in the QR code');
  const view = (await call('ph-owner', 'GET', `/api/phone/pairing/${pairing.id}`)).json();
  assert.deepEqual(view, { state: 'waiting', qr: pairing.qr, expiresAt: pairing.expiresAt });
  assert.equal((await call('ph-owner', 'GET', '/api/phone')).json().computer.id, qr.computerId);
  assert.deepEqual(sockets, [], 'no connection with the background off');
});

test('the QR code renews: new pairing id and secret; a request on the old code is not taken', async () => {
  const before = P.readQr(pairing.qr);
  assert.equal(await phoneLink().renew(pairing.id), true);
  const view = (await call('ph-owner', 'GET', `/api/phone/pairing/${pairing.id}`)).json();
  const after = P.readQr(view.qr);
  assert.notEqual(after.pairingId, before.pairingId);
  assert.notDeepEqual(after.secret, before.secret);
  // The link has no relay here, so feed the request in directly (as the relay would deliver it).
  const phone = E.createIdentity();
  const link = phoneLink();
  link.onEnvelope(phone.id, P.sealPairingRequest(phone, before.pairingId, before.secret, { name: 'Old photo', platform: 'ios' }), before.pairingId, 'relay');
  assert.equal((await call('ph-owner', 'GET', `/api/phone/pairing/${pairing.id}`)).json().state, 'waiting', 'the old code accepts nothing');
  link.onEnvelope(phone.id, P.sealPairingRequest(phone, after.pairingId, after.secret, { name: 'Work iPhone', platform: 'ios', lifetimeDays: 30 }), after.pairingId, 'relay');
  const req = (await call('ph-owner', 'GET', `/api/phone/pairing/${pairing.id}`)).json();
  assert.equal(req.state, 'request');
  assert.equal(req.qr, null);
  // The phone got a signed challenge for itself, and both screens show the code made with it.
  const challenge = challengeFor(phone, after);
  assert.ok(challenge, 'a check challenge went back to the phone');
  assert.deepEqual(req.request, { name: 'Work iPhone', model: 'ios', checkCode: P.checkCode(after.secret, after.computerKey, phone.publicKey, challenge), lifetimeDays: 30 });
  // The same request again: the same challenge again, the code stays.
  const count = sent.filter((m) => m.env.startsWith('g1.pchal.')).length;
  link.onEnvelope(phone.id, P.sealPairingRequest(phone, after.pairingId, after.secret, { name: 'Work iPhone', platform: 'ios', lifetimeDays: 30 }), after.pairingId, 'relay');
  assert.equal(sent.filter((m) => m.env.startsWith('g1.pchal.')).length, count + 1);
  assert.deepEqual(challengeFor(phone, after), challenge);
  assert.equal(await phoneLink().renew(pairing.id), false, 'a received request stops the renewing');

  for (const body of [{}, { lifetimeDays: 45, path: 'anywhere' }, { lifetimeDays: 30 }, { lifetimeDays: 30, path: 'anywhere', name: 'x' }]) {
    assert.equal((await call('ph-owner', 'POST', `/api/phone/pairing/${pairing.id}/allow`, body)).statusCode, 400, JSON.stringify(body));
  }
  const allowed = await call('ph-owner', 'POST', `/api/phone/pairing/${pairing.id}/allow`, { lifetimeDays: 30, path: 'anywhere' });
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.deepEqual(allowed.json(), { deviceId: phone.id });
  assert.equal((await call('ph-owner', 'GET', `/api/phone/pairing/${pairing.id}`)).json().state, 'paired');
  assert.deepEqual((await call('ph-owner', 'POST', `/api/phone/pairing/${pairing.id}/allow`, { lifetimeDays: 30, path: 'anywhere' })).json(), { code: 'pairing_closed' });
  const devices = (await call('ph-owner', 'GET', '/api/phone')).json().devices;
  assert.equal(devices.length, 1);
  assert.deepEqual({ ...devices[0], pairedAt: 0, lastUsedAt: 0, expiresAt: 0 }, { id: phone.id, name: 'Work iPhone', model: 'ios', path: 'anywhere', lifetimeDays: 30, status: 'active', pairedAt: 0, lastUsedAt: 0, expiresAt: 0 });
  const row = db.prepare('SELECT * FROM phone_devices WHERE id = ?').get(phone.id);
  assert.ok(row.notify_key_enc && row.notify_key_iv && row.notify_key_tag && row.push_enc === null);
  assert.equal((await store.notifyKeyOf(phone.id)).length, 32);
});

test('a second, different request on the same code cancels the pairing with a warning', async () => {
  const p = (await call('ph-owner', 'POST', '/api/phone/pairing', { path: 'anywhere' })).json();
  const qr = P.readQr(p.qr);
  const a = E.createIdentity(), b = E.createIdentity();
  const reqA = P.sealPairingRequest(a, qr.pairingId, qr.secret, { name: 'Mine', platform: 'android' });
  phoneLink().onEnvelope(a.id, reqA, qr.pairingId, 'relay');
  phoneLink().onEnvelope(a.id, reqA, qr.pairingId, 'relay');
  assert.equal((await call('ph-owner', 'GET', `/api/phone/pairing/${p.id}`)).json().state, 'request', 'the same phone again changes nothing');
  phoneLink().onEnvelope(b.id, P.sealPairingRequest(b, qr.pairingId, qr.secret, { name: 'Mine', platform: 'android' }), qr.pairingId, 'relay');
  assert.deepEqual((await call('ph-owner', 'GET', `/api/phone/pairing/${p.id}`)).json(), { state: 'cancelled', qr: null, expiresAt: null, warning: 'second_request' });
  assert.deepEqual((await call('ph-owner', 'POST', `/api/phone/pairing/${p.id}/allow`, { lifetimeDays: 30, path: 'anywhere' })).json(), { code: 'pairing_closed' });
});

test('deny, close, a new pairing closes the old one, unknown ids answer 404', async () => {
  const one = (await call('ph-owner', 'POST', '/api/phone/pairing', { path: 'anywhere' })).json();
  const two = (await call('ph-owner', 'POST', '/api/phone/pairing', { path: 'anywhere' })).json();
  assert.equal((await call('ph-owner', 'GET', `/api/phone/pairing/${one.id}`)).json().state, 'cancelled');
  assert.deepEqual((await call('ph-owner', 'POST', `/api/phone/pairing/${two.id}/allow`, { lifetimeDays: 30, path: 'anywhere' })).json(), { code: 'no_request' });
  assert.equal((await call('ph-owner', 'POST', `/api/phone/pairing/${two.id}/deny`, { x: 1 })).statusCode, 400);
  assert.deepEqual((await call('ph-owner', 'POST', `/api/phone/pairing/${two.id}/deny`)).json(), { ok: true });
  assert.equal((await call('ph-owner', 'GET', `/api/phone/pairing/${two.id}`)).json().state, 'cancelled');
  const three = (await call('ph-owner', 'POST', '/api/phone/pairing', { path: 'anywhere' })).json();
  assert.deepEqual((await call('ph-owner', 'DELETE', `/api/phone/pairing/${three.id}`)).json(), { ok: true });
  assert.equal((await call('ph-owner', 'GET', `/api/phone/pairing/${three.id}`)).json().state, 'cancelled');
  assert.deepEqual((await call('ph-owner', 'GET', '/api/phone/pairing/ps_BBBBBBBBBBBBBBBBBBBBBB')).json(), { code: 'not_found' });
  assert.equal((await call('ph-owner', 'GET', '/api/phone/pairing/nope')).statusCode, 404);
});

test('devices: patch with exact bodies, sliding lifetime, forget wipes the keys, forget-all', async () => {
  const [d] = (await call('ph-owner', 'GET', '/api/phone')).json().devices;
  for (const body of [{}, { name: '' }, { name: 'a\u0001' }, { path: 'lan' }, { lifetimeDays: 1 }, { owner: 'x' }]) {
    assert.equal((await call('ph-owner', 'PATCH', `/api/phone/devices/${d.id}`, body)).statusCode, 400, JSON.stringify(body));
  }
  assert.deepEqual((await call('ph-owner', 'PATCH', `/api/phone/devices/${d.id}`, { name: 'Pocket', path: 'wifi', lifetimeDays: null })).json(), { ok: true });
  let [v] = (await call('ph-owner', 'GET', '/api/phone')).json().devices;
  assert.equal(v.name, 'Pocket'); assert.equal(v.path, 'wifi'); assert.equal(v.lifetimeDays, null); assert.equal(v.expiresAt, null);
  assert.deepEqual((await call('ph-owner', 'PATCH', `/api/phone/devices/${'b'.repeat(43)}`, { name: 'x' })).json(), { code: 'not_found' });

  // Lifetime counts from the last use: 31 days unused with 30 days = expired; a use renews it; counters never go back.
  await call('ph-owner', 'PATCH', `/api/phone/devices/${d.id}`, { lifetimeDays: 30 });
  db.prepare('UPDATE phone_devices SET last_used_at = ? WHERE id = ?').run(Date.now() - 31 * DAY, d.id);
  [v] = (await call('ph-owner', 'GET', '/api/phone')).json().devices;
  assert.equal(v.status, 'expired');
  await store.markUsed(d.id, Date.now(), 5);
  await store.markUsed(d.id, Date.now() - DAY, 3);
  const row = db.prepare('SELECT last_counter, last_used_at FROM phone_devices WHERE id = ?').get(d.id);
  assert.equal(row.last_counter, 5);
  [v] = (await call('ph-owner', 'GET', '/api/phone')).json().devices;
  assert.equal(v.status, 'active');

  const tool = await phoneDevicesTool.execute({}, { userId: 'ph-owner', agentId: 'main' });
  assert.equal(tool.data.phones.length, 1);
  assert.deepEqual(Object.keys(tool.data.phones[0]).sort(), ['expiresAt', 'lastUsedAt', 'model', 'name', 'path', 'status']);
  assert.match((await phoneDevicesTool.execute({}, { userId: 'ph-user' })).error, /only for the owner/);
  assert.match((await phoneDevicesTool.execute({}, { userId: 'ph-owner', toolPolicy: { channel: 'telegram' } })).error, /someone else/);

  assert.deepEqual((await call('ph-owner', 'DELETE', `/api/phone/devices/${d.id}`)).json(), { ok: true });
  const gone = db.prepare('SELECT * FROM phone_devices WHERE id = ?').get(d.id);
  assert.ok(gone.revoked_at > 0);
  assert.equal(gone.public_key, '');
  assert.equal(gone.notify_key_enc, null);
  assert.deepEqual((await call('ph-owner', 'GET', '/api/phone')).json().devices, []);
  assert.deepEqual((await call('ph-owner', 'DELETE', `/api/phone/devices/${d.id}`)).json(), { code: 'not_found' });
  assert.equal((await phoneDevicesTool.execute({}, { userId: 'ph-owner' })).content[0].text, 'No phone is paired.');

  for (const name of ['A', 'B']) {
    const k = E.createIdentity();
    await store.addDevice({ id: k.id, ownerId: 'ph-owner', name, model: 'ios', publicKey: k.publicKey, path: 'anywhere', lifetimeDays: 90, now: Date.now() });
  }
  assert.equal((await call('ph-owner', 'POST', '/api/phone/devices/forget-all', { all: true })).statusCode, 400);
  assert.deepEqual((await call('ph-owner', 'POST', '/api/phone/devices/forget-all')).json(), { forgotten: 2 });
  assert.deepEqual((await call('ph-owner', 'GET', '/api/phone')).json().devices, []);
  assert.deepEqual(sockets, [], 'still no connection');
});

test('M1: an attacker with the QR photo cannot pre-pick a key for the code: the challenge comes after its request', async () => {
  // The relay drops the real phone's request and sends the attacker's (sealed with the photographed secret).
  const real = E.createIdentity(), attacker = E.createIdentity();
  const { p, qr } = await requestFrom(attacker, 'Mine');
  const view = (await call('ph-owner', 'GET', `/api/phone/pairing/${p.id}`)).json();
  assert.equal(view.state, 'request');
  // The challenge was made after the attacker's key was fixed and is addressed to the attacker only.
  const f = sent.findLast((m) => m.env.startsWith('g1.pchal.'));
  assert.equal(f.id, attacker.id);
  assert.throws(() => P.openChallenge(f.env, qr.computerKey, qr.pairingId, qr.secret, real.id), /wrong_key/, 'the real phone never shows a code for it');
  assert.equal(view.request.checkCode, P.checkCode(qr.secret, qr.computerKey, attacker.publicKey, challengeFor(attacker, qr)));
  phoneLink().deny(p.id, 'ph-owner');
});

test('L9: a request does not restart the 10-minute pairing deadline', async () => {
  const phone = E.createIdentity();
  const p = (await call('ph-owner', 'POST', '/api/phone/pairing', { path: 'anywhere' })).json();
  const qr = P.readQr(p.qr);
  const t0 = Date.now();
  phoneLink().onPairingRequest(qr.pairingId, phone.id, P.sealPairingRequest(phone, qr.pairingId, qr.secret, { name: 'Late', platform: 'ios' }), 'relay', t0 + 60_000);
  assert.equal(phoneLink().pairingView(p.id, 'ph-owner', t0 + 61_000).state, 'request');
  assert.equal(phoneLink().pairingView(p.id, 'ph-owner', t0 + PAIRING_MAX_MS + 1000).state, 'expired', 'ten minutes from the screen, not from the request');
});

test('L5: Allow cannot be cut in half; a cancel during Allow leaves nothing paired', async () => {
  const phone = E.createIdentity();
  const { p } = await requestFrom(phone, 'Racing');
  const allowing = phoneLink().allow(p.id, 'ph-owner', { lifetimeDays: 30, path: 'anywhere' });
  // Everything below runs before the Allow's first await returns.
  assert.throws(() => phoneLink().closePairing(p.id, 'ph-owner'), (e) => e.code === 'allowing');
  const fresh = phoneLink().startPairing('ph-owner', 'anywhere');
  assert.throws(() => phoneLink().deny(p.id, 'ph-owner'), (e) => e.code === 'pairing_closed');
  // A second, different request arrives meanwhile (a security cancel always wins): the Allow undoes itself.
  const pid = phoneLink().pairings.get(p.id).request.pid, secret = phoneLink().pairings.get(p.id).request.secret;
  const other = E.createIdentity();
  phoneLink().onEnvelope(other.id, P.sealPairingRequest(other, pid, secret, { name: 'Other', platform: 'ios' }), pid, 'relay');
  await assert.rejects(fresh, (e) => e.code === 'allowing');
  await assert.rejects(allowing, (e) => e.code === 'pairing_closed');
  assert.equal((await call('ph-owner', 'GET', `/api/phone/pairing/${p.id}`)).json().state, 'cancelled');
  assert.ok(!(await call('ph-owner', 'GET', '/api/phone')).json().devices.some((d) => d.id === phone.id), 'nothing paired');
  assert.equal(phoneLink().devices.has(phone.id), false);
  assert.ok(!sent.some((m) => m.id === phone.id && m.env.startsWith('g1.pwel.')), 'no welcome went out');
});

test('M3: a forgotten phone never comes back through a refresh, only through a new Allow', async () => {
  const phone = E.createIdentity();
  const { p } = await requestFrom(phone, 'Back');
  assert.equal((await call('ph-owner', 'POST', `/api/phone/pairing/${p.id}/allow`, { lifetimeDays: 30, path: 'anywhere' })).statusCode, 200);
  assert.equal(phoneLink().devices.has(phone.id), true);
  const key = db.prepare('SELECT public_key FROM phone_devices WHERE id = ?').get(phone.id).public_key;
  // Two refreshes overlap with the forget; then a stale read (the row as it was) lands last.
  const a = phoneLink().refresh(), b = phoneLink().forget('ph-owner', phone.id), c = phoneLink().refresh();
  await Promise.all([a, b, c]);
  assert.equal(phoneLink().devices.has(phone.id), false);
  db.prepare('UPDATE phone_devices SET revoked_at = NULL, public_key = ? WHERE id = ?').run(key, phone.id);
  await phoneLink().refresh();
  assert.equal(phoneLink().devices.has(phone.id), false, 'a stale row does not bring it back');
  assert.equal(phoneLink().verifier.lastCounter(phone.id), undefined, 'not in the command gate either');
  db.prepare('UPDATE phone_devices SET revoked_at = 1 WHERE id = ?').run(phone.id);
  const again = await requestFrom(phone, 'Back');
  assert.equal((await call('ph-owner', 'POST', `/api/phone/pairing/${again.p.id}/allow`, { lifetimeDays: 30, path: 'anywhere' })).statusCode, 200);
  assert.equal(phoneLink().devices.has(phone.id), true, 'a new Allow brings it back');
  await phoneLink().forget('ph-owner', phone.id);
});

test('L4: a relay setting that cannot be read is no unhandled rejection', async () => {
  const link = phoneLink();
  const { p } = await requestFrom(E.createIdentity(), 'x');
  link.deny(p.id, 'ph-owner');
  await call('ph-owner', 'POST', '/api/phone/pairing', { path: 'anywhere' });
  const seen = [];
  const onRejection = (e) => seen.push(e);
  process.on('unhandledRejection', onRejection);
  db.exec('ALTER TABLE phone_settings RENAME TO phone_settings_away');
  link.started = true;
  try {
    link.syncRelay();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    link.started = false;
    db.exec('ALTER TABLE phone_settings_away RENAME TO phone_settings');
    process.off('unhandledRejection', onRejection);
  }
  assert.deepEqual(seen, []);
  assert.equal(link.relay, null);
});
