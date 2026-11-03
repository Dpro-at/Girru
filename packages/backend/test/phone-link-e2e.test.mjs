// MOB-LINK-01 end to end: a real relay on 127.0.0.1, the backend's phone link on a throwaway database,
// and a fake phone built from the relay's reference code.
//  scan QR → g1.preq → g1.pchal (check code) → owner Allow → g1.pwel → handshake → signed chat.list → sealed reply;
//  a replayed command is refused; chat.send streams the run back; approvals: list, pending, decide,
//  2FA owners get verification_required; a second phone pairing notifies the first (g1.ntf);
//  an old QR code is closed on the relay at once; a Wi-Fi-only phone is not reachable via the relay;
//  a forgotten phone is refused; a cut-short approval needs the full view first; a replayed hs1 is ignored;
//  a phone paired again starts its counter over.
// No network beyond 127.0.0.1 (the local model is stubbed).
// Run: node --import tsx --import ../../scripts/test-temp-root.mjs --test test/phone-link-e2e.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const relayDir = join(backendDir, '..', 'relay');
const dir = mkdtempSync(join(tmpdir(), 'ap-phone-e2e-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.AGENT_PLAYER_BACKGROUND = 'off';
process.env.OLLAMA_URL = 'http://127.0.0.1:11434';
for (const k of ['AGENT_EXEC_TOOLS', 'OLLAMA_THINK', 'DEFAULT_MODEL']) delete process.env[k];

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u === 'http://127.0.0.1:11434/api/chat') {
    const enc = new TextEncoder();
    const lines = [{ message: { content: 'Hello from the computer' }, done: false }, { message: { content: '' }, done: true }];
    return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(enc.encode(JSON.stringify(l) + '\n')); c.close(); } }), { status: 200 });
  }
  throw new Error(`unexpected network call in test: ${u}`);
};
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const { getOrchestrator } = await import(join(backendDir, 'src/multi-agent/index.ts'));
await getOrchestrator().initialize(join(dir, '.data', 'multi-agent', 'orchestrator.db'));
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('pe-owner', 'pe-owner@example.test', 'pe-owner', 'x', 'owner', 'active', 1)`).run();
db.prepare(`INSERT INTO agents_config (id, name, provider, model, is_primary) VALUES ('pe-main', 'Main', 'ollama', 'qwen-test', 1)`).run();

const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { phoneLink } = await import(join(backendDir, 'src/phone/service.ts'));
const P = await import(join(backendDir, 'src/phone/protocol/pairing.ts'));
const approvals = await import(join(backendDir, 'src/tools/approvals.ts'));
// The phone side uses the relay's own reference code.
const { createRelay } = await import(pathToFileURL(join(relayDir, 'src/relay.ts')).href);
const E = await import(pathToFileURL(join(relayDir, 'src/e2e.ts')).href);
const { connect } = await import(pathToFileURL(join(relayDir, 'test/helpers.mjs')).href);

const relay = createRelay({ port: 0 });
const { port } = await relay.listen();
const relayUrl = `ws://127.0.0.1:${port}/v1`;
const app = await buildServer({ logger: false });
await app.ready();
const call = (method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken('pe-owner', 1)}` }, ...(payload !== undefined ? { payload } : {}) });
assert.equal((await call('PUT', '/api/phone/settings', { relayUrl })).statusCode, 200);
await phoneLink().start();

const clients = [];
test.after(async () => {
  for (const c of clients) await c.close().catch(() => undefined);
  await phoneLink().stop();
  await relay.close();
  await app.close();
});

async function until(fn, what, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A fake phone: identity, relay connection, counter, session. */
class Phone {
  constructor(name) { this.name = name; this.identity = E.createIdentity(); this.ctr = 0; }
  async scan(qrText) {
    this.qr = P.readQr(qrText);
    this.client = await connect(this.qr.relay, { identity: this.identity, allow: [this.qr.computerId] });
    clients.push(this.client);
  }
  request(opts = {}) {
    this.client.sendPairing(this.qr.pairingId, P.sealPairingRequest(this.identity, this.qr.pairingId, this.qr.secret, { name: this.name, platform: 'ios', ...opts }), 'preq');
  }
  next(match = () => true, ms = 3000) { return this.client.next(match, ms); }
  /** The computer's signed challenge; only then does the phone show its check code. */
  async challenge() {
    const f = await this.next((f) => f.t === 'msg' && f.env.startsWith('g1.pchal.'));
    assert.equal(f.from, this.qr.computerId);
    const c = P.openChallenge(f.env, this.qr.computerKey, this.qr.pairingId, this.qr.secret, this.identity.id);
    this.checkCode = P.checkCode(this.qr.secret, this.qr.computerKey, this.identity.publicKey, c);
    return this.checkCode;
  }
  async welcome() {
    const f = await this.next((f) => f.t === 'msg' && f.env.startsWith('g1.pwel.'));
    assert.equal(f.from, this.qr.computerId);
    this.welcomed = P.openWelcome(f.env, this.qr.computerKey, this.qr.pairingId, this.qr.secret, this.identity);
    return this.welcomed;
  }
  async handshake() {
    const { env, pending } = E.startHandshake(this.identity, this.qr.computerId);
    this.lastHs1 = env;
    this.client.send(this.qr.computerId, env);
    const f = await this.next((f) => (f.t === 'msg' && f.env.startsWith('g1.hs2.')) || f.t === 'drop');
    if (f.t === 'drop') return f;
    this.session = E.finishHandshake(pending, this.qr.computerKey, f.env);
    return f;
  }
  sendRaw(obj) { this.client.send(this.qr.computerId, E.seal(this.session, JSON.stringify(obj))); }
  signed(body) { return E.signCommand(this.identity, this.qr.computerId, ++this.ctr, JSON.stringify(body)); }
  command(body) { const cmd = this.signed(body); this.sendRaw(cmd); return cmd; }
  async read(match = () => true, ms = 3000) {
    for (;;) {
      const f = await this.next((f) => f.t === 'msg' && f.env.startsWith('g1.msg.') || f.t === 'drop', ms);
      if (f.t === 'drop') return { drop: f.reason };
      const m = JSON.parse(E.open(this.session, f.env).toString());
      if (match(m)) return m;
    }
  }
  reply(ref, ms) { return this.read((m) => m.type === 'reply' && m.ref === ref, ms); }
}

async function pair(phone, { path = 'anywhere', lifetimeDays = 30 } = {}) {
  const p = (await call('POST', '/api/phone/pairing', { path: 'anywhere' })).json();
  await phone.scan(p.qr);
  await until(() => relay.stats().pairings >= 1, 'pairing id open on the relay');
  phone.request();
  const view = await until(async () => { const v = (await call('GET', `/api/phone/pairing/${p.id}`)).json(); return v.state === 'request' && v; }, 'pairing request');
  assert.equal(view.request.checkCode, await phone.challenge(), 'both screens show the same check code');
  assert.equal((await call('POST', `/api/phone/pairing/${p.id}/allow`, { lifetimeDays, path })).statusCode, 200);
  const w = await phone.welcome();
  assert.equal(w.lifetimeDays, lifetimeDays);
  return p;
}

const first = new Phone('Work iPhone');

test('pair through the relay: QR → request → Allow → welcome; then a signed command gets a sealed reply', async () => {
  assert.equal(relay.stats().devices, 0, 'nothing paired, no pairing open: the computer stays off the relay');
  await pair(first);
  assert.equal(first.welcomed.computer, first.qr.computerId);
  const hs = await first.handshake();
  assert.equal(hs.t, 'msg');
  const cmd = first.command({ type: 'chat.list', ref: 'r1' });
  const r = await first.reply('r1');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data, { conversations: [] });
  const row = db.prepare('SELECT last_counter, last_used_at FROM phone_devices WHERE id = ?').get(first.identity.id);
  assert.equal(row.last_counter, 1, 'the counter is stored');

  // The same signed command again (new envelope) is refused, and runs nothing. A refused command is answered by its nonce.
  first.sendRaw(cmd);
  assert.deepEqual(await first.reply(cmd.nonce), { type: 'reply', ref: cmd.nonce, ok: false, error: 'replay' });
  // A command signed for another computer is refused.
  first.sendRaw(E.signCommand(first.identity, E.createIdentity().id, ++first.ctr, JSON.stringify({ type: 'team.list', ref: 'r2' })));
  assert.equal((await first.read((m) => m.type === 'reply')).error, 'wrong_target');
  const team = first.command({ type: 'team.list', ref: 'r3' });
  assert.ok(team);
  const t = await first.reply('r3');
  assert.ok(t.data.agents.some((a) => a.id === 'pe-main' && a.name === 'Main'));
  const unknown = first.command({ type: 'terminal.open', ref: 'r4' });
  assert.ok(unknown);
  assert.equal((await first.reply('r4')).error, 'unknown_command');
});

test('chat.send starts a turn as the owner and streams the run back, then run.end', async () => {
  first.command({ type: 'chat.send', ref: 's1', message: 'Hi from my phone' });
  const r = await first.reply('s1', 5000);
  assert.equal(r.ok, true, JSON.stringify(r));
  const { runId, conversationId } = r.data;
  const frames = [];
  const end = await first.read((m) => { if (m.type === 'run' && m.ref === 's1') frames.push(m); return m.type === 'run.end' && m.runId === runId; }, 8000);
  assert.equal(end.status, 'complete');
  assert.ok(frames.some((f) => f.frame.type === 'text' && String(f.frame.content).includes('Hello from the computer')), JSON.stringify(frames.map((f) => f.frame.type)));
  first.command({ type: 'chat.messages', ref: 's2', id: conversationId });
  const page = await first.reply('s2');
  assert.deepEqual(page.data.messages.map((m) => m.role), ['user', 'assistant']);
  first.command({ type: 'chat.list', ref: 's3' });
  assert.equal((await first.reply('s3')).data.conversations[0].id, conversationId);
  first.command({ type: 'chat.stop', ref: 's4', runId });
  assert.equal((await first.reply('s4')).ok, true);
  first.command({ type: 'tasks.list', ref: 's5' });
  assert.ok(Array.isArray((await first.reply('s5')).data.runs));
  first.command({ type: 'schedules.list', ref: 's6' });
  assert.ok(Array.isArray((await first.reply('s6')).data.schedules));
  const audit = db.prepare("SELECT metadata FROM audit_logs WHERE action = 'phone.chat.send'").get();
  assert.equal(JSON.parse(audit.metadata).device, first.identity.id, 'the audit row names the phone');
});

test('approvals: pending only once shown to this phone; deny; approve needs paramsHash; 2FA is never skipped', async () => {
  const tool = { name: 'phone_test_tool' };
  const ask = async () => (await approvals.requestApproval(tool, { value: 'x' }, { userId: 'pe-owner', agentId: 'pe-main', sessionId: 's1' }, 'other')).details.approvalId;
  const a = await ask(), b = await ask();
  first.sendRaw({ type: 'approval.pending', id: a });
  assert.deepEqual(await first.read((m) => m.type === 'approval.pending'), { type: 'approval.pending', id: a, pending: false }, 'not shown to this phone yet');
  first.command({ type: 'approval.decide', ref: 'a0', id: a, approve: false });
  assert.equal((await first.reply('a0')).error, 'not_pending', 'a phone cannot decide an approval it was never given');
  first.command({ type: 'approval.pending', ref: 'a1' });
  const list = (await first.reply('a1')).data.approvals;
  assert.deepEqual(list.map((x) => x.id).sort(), [a, b].sort());
  assert.match(list[0].paramsHash, /^[0-9a-f]{64}$/);
  first.sendRaw({ type: 'approval.pending', id: a });
  assert.equal((await first.read((m) => m.type === 'approval.pending')).pending, true);
  first.command({ type: 'approval.decide', ref: 'a2', id: a, approve: false });
  assert.deepEqual((await first.reply('a2')).data, { id: a, status: 'denied' });
  first.command({ type: 'approval.decide', ref: 'a3', id: a, approve: false });
  assert.equal((await first.reply('a3')).error, 'not_pending', 'the first decision wins');
  first.command({ type: 'approval.decide', ref: 'a4', id: b, approve: true });
  assert.equal((await first.reply('a4')).error, 'params_hash_required');
  db.prepare('INSERT INTO verification_factors (user_id, sealed_secret, version, enabled, last_counter, activated_at) VALUES (?, ?, 1, 1, -1, ?)').run('pe-owner', 'unused-test-cipher', Date.now());
  const hash = list.find((x) => x.id === b).paramsHash;
  first.command({ type: 'approval.decide', ref: 'a5', id: b, decision: 'approve', paramsHash: hash });
  assert.equal((await first.reply('a5')).error, 'verification_required');
  assert.equal((await approvals.getApproval(b)).status, 'pending', 'nothing ran');
  const row = db.prepare("SELECT metadata FROM audit_logs WHERE action = 'tool_approval.deny' AND resource_id = ?").get(a);
  assert.equal(JSON.parse(row.metadata).device, first.identity.id);
});

test('M2: a cut-short or nested preview is approved only after the full view of that very hash', async () => {
  db.prepare('DELETE FROM verification_factors WHERE user_id = ?').run('pe-owner');
  const tool = { name: 'phone_test_tool' };
  const id = (await approvals.requestApproval(tool, { text: 'y'.repeat(2000), nested: { deep: 1 } }, { userId: 'pe-owner', agentId: 'pe-main', sessionId: 's1' }, 'other')).details.approvalId;
  first.command({ type: 'approval.detail', ref: 'm0', id });
  assert.equal((await first.reply('m0')).error, 'not_pending', 'no full view of an approval never given to this phone');
  first.command({ type: 'approval.pending', ref: 'm1' });
  const item = (await first.reply('m1')).data.approvals.find((x) => x.id === id);
  assert.equal(item.truncated, true);
  assert.equal(item.fullViewRequired, true);
  first.command({ type: 'approval.decide', ref: 'm2', id, approve: true, paramsHash: item.paramsHash });
  assert.equal((await first.reply('m2')).error, 'full_view_required');
  assert.equal((await approvals.getApproval(id)).status, 'pending', 'nothing ran');
  first.command({ type: 'approval.detail', ref: 'm3', id });
  const detail = (await first.reply('m3')).data;
  assert.equal(detail.params.text.length, 2000);
  assert.deepEqual(detail.params.nested, { deep: 1 });
  assert.equal(detail.paramsHash, item.paramsHash);
  assert.ok(Array.isArray(detail.maskedFields));
  // Another phone's full view does not count for this one; this phone's does.
  first.command({ type: 'approval.decide', ref: 'm4', id, approve: true, paramsHash: item.paramsHash });
  const decided = await first.reply('m4', 5000);
  assert.notEqual(decided.error, 'full_view_required', JSON.stringify(decided));
  assert.notEqual((await approvals.getApproval(id)).status, 'pending', 'the full view let the approval through');
});

test('L2: a replayed hs1 is ignored and the live session keeps working', async () => {
  first.command({ type: 'chat.list', ref: 'h0' });
  assert.equal((await first.reply('h0')).ok, true);
  first.client.send(first.qr.computerId, first.lastHs1);
  await assert.rejects(first.next((f) => f.t === 'msg' && f.env.startsWith('g1.hs2.'), 500), /timed out/, 'no second answer');
  // The same hello with its ECDSA signature re-encoded (s → n − s) is still valid, and still a replay.
  first.client.send(first.qr.computerId, malleate(first.lastHs1));
  await assert.rejects(first.next((f) => f.t === 'msg' && f.env.startsWith('g1.hs2.'), 500), /timed out/, 'no answer to a re-signed copy');
  first.command({ type: 'chat.list', ref: 'h1' });
  assert.equal((await first.reply('h1')).ok, true, 'the session was not swapped');
});

const second = new Phone('Tablet');
test('pairing a second phone notifies the first with a signed notice', async () => {
  await pair(second);
  const f = await first.next((f) => f.t === 'msg' && f.env.startsWith('g1.ntf.'));
  const n = P.openNotice(f.env, first.qr.computerKey, first.identity.id, Buffer.from(first.welcomed.notifyKey, 'base64url'));
  assert.equal(n.content.kind, 'security');
  assert.match(n.content.body, /Tablet was paired/);
  assert.equal(n.ctr, 1);
});

test('a renewed QR code closes the old pairing id on the relay at once', async () => {
  const p = (await call('POST', '/api/phone/pairing', { path: 'anywhere' })).json();
  const late = new Phone('Late');
  await late.scan(p.qr);
  await until(() => relay.stats().pairings === 1, 'pairing open');
  assert.equal(await phoneLink().renew(p.id), true);
  const fresh = P.readQr((await call('GET', `/api/phone/pairing/${p.id}`)).json().qr);
  await until(async () => { late.client.sendPairing(late.qr.pairingId, 'g1.preq.x.y', 'old'); const f = await late.next((f) => f.t === 'drop' || f.t === 'error', 1000).catch(() => null); return f?.t === 'drop'; }, 'old pairing id closed');
  late.qr = { ...late.qr, pairingId: fresh.pairingId, secret: fresh.secret };
  late.request();
  await until(async () => (await call('GET', `/api/phone/pairing/${p.id}`)).json().state === 'request', 'request on the new code');
  assert.deepEqual((await call('POST', `/api/phone/pairing/${p.id}/deny`)).json(), { ok: true });
});

test('a Wi-Fi-only phone is never reached through the relay', async () => {
  assert.equal((await call('PATCH', `/api/phone/devices/${second.identity.id}`, { path: 'wifi' })).statusCode, 200);
  const hs = await second.handshake();
  assert.deepEqual({ t: hs.t, reason: hs.reason }, { t: 'drop', reason: 'offline' }, 'the computer no longer allows it on the relay');
  // Back to anywhere: reachable again.
  await call('PATCH', `/api/phone/devices/${second.identity.id}`, { path: 'anywhere' });
  const again = await until(async () => { const r = await second.handshake(); return r.t === 'msg' && r; }, 'handshake after path change');
  assert.equal(again.t, 'msg');
});

test('a forgotten phone is refused', async () => {
  assert.equal((await call('DELETE', `/api/phone/devices/${first.identity.id}`)).statusCode, 200);
  await until(async () => {
    first.command({ type: 'chat.list', ref: 'f1' });
    const r = await first.read((m) => m.type === 'reply', 800).catch(() => ({ silent: true }));
    assert.notEqual(r.ok, true, 'a forgotten phone never gets an answer');
    return r.drop === 'offline';
  }, 'the relay drops a forgotten phone');
  const hs = await first.handshake();
  assert.equal(hs.t, 'drop');
  const devices = (await call('GET', '/api/phone')).json().devices.map((d) => d.id);
  assert.deepEqual(devices, [second.identity.id]);
});

test('L6: a phone paired again starts its counter over', async () => {
  const again = new Phone('Again');
  await pair(again);
  await again.handshake();
  for (const ref of ['c1', 'c2', 'c3']) { again.command({ type: 'chat.list', ref }); assert.equal((await again.reply(ref)).ok, true); }
  // Same identity, new QR code: the computer stores counter 0 and must not keep the old 3 in memory.
  await pair(again);
  again.ctr = 0;
  await again.handshake();
  again.command({ type: 'chat.list', ref: 'c4' });
  assert.deepEqual({ ok: (await again.reply('c4')).ok }, { ok: true });
  await call('DELETE', `/api/phone/devices/${again.identity.id}`);
});

test('Wi-Fi path (off by default): a phone pairs and talks over the local listener, never via the relay', async () => {
  assert.equal((await call('GET', '/api/phone')).json().wifi, 'off');
  const store = await import(join(backendDir, 'src/phone/store.ts'));
  // Every address at once is never bound: one private (or loopback) address only.
  for (const host of ['0.0.0.0', '::']) {
    await store.setSetting('phone.lanListen', JSON.stringify({ host, port: 0 }));
    await phoneLink().restartLan();
    assert.equal((await call('GET', '/api/phone')).json().wifi, 'failed', host);
  }
  await store.setSetting('phone.lanListen', JSON.stringify({ host: '127.0.0.1', port: 0 }));
  await phoneLink().restartLan();
  assert.equal((await call('GET', '/api/phone')).json().wifi, 'on');
  const p = (await call('POST', '/api/phone/pairing', { path: 'wifi' })).json();
  const qr = P.readQr(p.qr);
  assert.equal(qr.relay, undefined, 'a Wi-Fi pairing code names no relay');
  assert.equal(qr.lan.length, 1);
  const local = new Phone('Home phone');
  local.qr = qr;
  local.client = await connect(`ws://${qr.lan[0]}/v1`, { identity: local.identity });
  clients.push(local.client);
  local.request();
  const view = await until(async () => { const v = (await call('GET', `/api/phone/pairing/${p.id}`)).json(); return v.state === 'request' && v; }, 'request over Wi-Fi');
  assert.equal(view.request.checkCode, await local.challenge(), 'the challenge comes back over Wi-Fi too');
  assert.equal((await call('POST', `/api/phone/pairing/${p.id}/allow`, { lifetimeDays: null, path: 'wifi' })).statusCode, 200);
  assert.equal((await local.welcome()).lifetimeDays, null);
  assert.equal((await local.handshake()).t, 'msg');
  local.command({ type: 'chat.list', ref: 'w1' });
  assert.equal((await local.reply('w1')).ok, true);
  // The same phone dialing the relay is not let through: it is not on the computer's relay allow list.
  const viaRelay = await connect(relayUrl, { identity: local.identity, allow: [qr.computerId] });
  clients.push(viaRelay);
  viaRelay.send(qr.computerId, E.startHandshake(local.identity, qr.computerId).env);
  assert.equal((await viaRelay.next((f) => f.t === 'drop')).reason, 'offline');
});

/** The other valid encoding of a P-256 DER signature (s → n − s); needs no private key. */
function malleate(env) {
  const parts = env.split('.');
  const der = Buffer.from(parts[3], 'base64url');
  const n = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  let i = 2; const rLen = der[i + 1]; const r = der.subarray(i + 2, i + 2 + rLen); i += 2 + rLen;
  const s = BigInt('0x' + der.subarray(i + 2, i + 2 + der[i + 1]).toString('hex'));
  const int = (v) => { let h = v.toString(16); if (h.length % 2) h = '0' + h; let b = Buffer.from(h, 'hex'); if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); return Buffer.concat([Buffer.from([2, b.length]), b]); };
  const body = Buffer.concat([Buffer.from([2, r.length]), r, int(n - s)]);
  parts[3] = Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('base64url');
  return parts.join('.');
}
