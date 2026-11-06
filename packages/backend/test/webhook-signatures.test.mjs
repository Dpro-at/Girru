// S0-A.5: public provider callbacks verify the provider signature and fail
// closed. Uses the real app (buildServer) so the auth gate is in front.
// Run: node --import tsx --test test/webhook-signatures.test.mjs
// Throwaway DB + cwd, random test-only secrets, fetch stubbed (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-webhook-sig-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
const TWILIO_TOKEN = randomBytes(16).toString('hex'); // throwaway, test only
const PUBLIC = 'https://agent.example.test';

const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{}', { status: 200 });
const quiet = { log: console.log, warn: console.warn, info: console.info };
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
await getDatabase().initialize();
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { initializeWebhooks } = await import(join(backendDir, 'src/webhooks/index.ts'));
const { twilioSignature, verifyWebhookSignature, webhookSignature } = await import(join(backendDir, 'src/webhooks/verify.ts'));
const { manager } = await initializeWebhooks();
const app = await buildServer({ logger: false });
// Run the archived telephony plugin explicitly; production no longer ships it.
const {registerTelephonyRoutes}=await import(join(backendDir,'test/fixtures/legacy-apps/src/api/routes/telephony.ts'));
await app.register(registerTelephonyRoutes);
await app.ready();
console.log = quiet.log; console.info = quiet.info; console.warn = quiet.warn;

test.after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.PUBLIC_URL;
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const form = (params) => new URLSearchParams(params).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const statusParams = { CallSid: 'CA123', CallStatus: 'ringing' };
const TWILIO_ROUTES = ['voice-webhook', 'outbound-twiml', 'process-speech', 'process-ivr', 'status-webhook', 'recording-webhook'];

test('Twilio webhooks: no auth token / public URL configured -> every request refused', async () => {
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.PUBLIC_URL;
  for (const r of TWILIO_ROUTES) {
    const url = `/api/telephony/${r}`;
    const sig = twilioSignature('anything', `${PUBLIC}${url}`, statusParams);
    const res = await app.inject({ method: 'POST', url, headers: { ...FORM, 'x-twilio-signature': sig }, payload: form(statusParams) });
    assert.equal(res.statusCode, 403, `${r} -> ${res.statusCode}`);
  }
});

test('Twilio webhooks: unsigned and wrongly signed requests get 403, signed ones pass', async () => {
  process.env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
  process.env.PUBLIC_URL = PUBLIC;
  for (const r of TWILIO_ROUTES) {
    const url = `/api/telephony/${r}`;
    const unsigned = await app.inject({ method: 'POST', url, headers: FORM, payload: form(statusParams) });
    assert.equal(unsigned.statusCode, 403, `${r} unsigned`);
    const wrong = twilioSignature('not-the-token', `${PUBLIC}${url}`, statusParams);
    assert.equal((await app.inject({ method: 'POST', url, headers: { ...FORM, 'x-twilio-signature': wrong }, payload: form(statusParams) })).statusCode, 403, `${r} wrong key`);
    // Signature over other parameters (tampered body).
    const tampered = twilioSignature(TWILIO_TOKEN, `${PUBLIC}${url}`, { ...statusParams, CallStatus: 'completed' });
    assert.equal((await app.inject({ method: 'POST', url, headers: { ...FORM, 'x-twilio-signature': tampered }, payload: form(statusParams) })).statusCode, 403, `${r} tampered`);
  }
  const url = '/api/telephony/status-webhook';
  const good = twilioSignature(TWILIO_TOKEN, `${PUBLIC}${url}`, statusParams);
  const ok = await app.inject({ method: 'POST', url, headers: { ...FORM, 'x-twilio-signature': good }, payload: form(statusParams) });
  assert.equal(ok.statusCode, 200, ok.body);
  // Query string is part of the signed URL.
  const q = '/api/telephony/outbound-twiml?callPointId=cp1';
  const qBad = twilioSignature(TWILIO_TOKEN, `${PUBLIC}/api/telephony/outbound-twiml`, {});
  assert.equal((await app.inject({ method: 'POST', url: q, headers: { ...FORM, 'x-twilio-signature': qBad }, payload: '' })).statusCode, 403);
});

test('inbound /webhook/*: HMAC-SHA256 over the raw body is required', async () => {
  const hook = await manager.createInbound({ name: 'ci', handler: { type: 'log' } });
  const body = JSON.stringify({ event: 'push', n: 1 });
  const JSONH = { 'content-type': 'application/json' };
  const missing = await app.inject({ method: 'POST', url: hook.path, headers: JSONH, payload: body });
  assert.equal(missing.statusCode, 403);
  const wrong = webhookSignature('iwhsec_wrong', body);
  assert.equal((await app.inject({ method: 'POST', url: hook.path, headers: { ...JSONH, 'x-webhook-signature': wrong }, payload: body })).statusCode, 403);
  // Signature of a different body.
  const other = webhookSignature(hook.secret, body.replace('1', '2'));
  assert.equal((await app.inject({ method: 'POST', url: hook.path, headers: { ...JSONH, 'x-webhook-signature': other }, payload: body })).statusCode, 403);
  const good = createHmac('sha256', hook.secret).update(body).digest('hex');
  const ok = await app.inject({ method: 'POST', url: hook.path, headers: { ...JSONH, 'x-webhook-signature': `sha256=${good}` }, payload: body });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().received, true);
  assert.equal((await app.inject({ method: 'POST', url: '/webhook/nope', headers: JSONH, payload: body })).statusCode, 404);
});

test('verifyWebhookSignature fails closed without a secret or signature', () => {
  assert.equal(verifyWebhookSignature('', 'x', webhookSignature('s', 'x')), false);
  assert.equal(verifyWebhookSignature('s', 'x', undefined), false);
  assert.equal(verifyWebhookSignature('s', 'x', ['a']), false);
  assert.equal(verifyWebhookSignature('s', 'x', webhookSignature('s', 'x')), true);
});
