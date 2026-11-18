// CLI-03: login/logout, private token file, bearer token on API calls.
// fetch is stubbed; nothing contacts a server. Uses a temp HOME/config dir.
// Run (from the repo root): node --import tsx --test packages/cli/test/auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = mkdtempSync(join(tmpdir(), 'ap-cli-auth-'));
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'config', 'agent-player');
for (const k of ['AGENT_PLAYER_URL', 'BACKEND_URL', 'AGENT_PLAYER_WEB_URL', 'FRONTEND_URL', 'XDG_CONFIG_HOME']) delete process.env[k];

const TOKEN = 'tok-' + randomBytes(24).toString('hex'); // fake, test only
const PASSWORD = 'pw-' + randomBytes(8).toString('hex'); // fake, test only

const calls = [];
let respond = () => ({ status: 200, body: {} });
globalThis.fetch = async (url, init = {}) => {
  const call = { url: String(url), method: init.method, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(call);
  const { status, body, raw } = respond(call);
  return new Response(raw ?? (body === undefined ? '' : JSON.stringify(body)), { status });
};

// Capture everything printed.
const printed = [];
const origLog = console.log;
console.log = (...a) => printed.push(a.map(String).join(' '));
const out = [];
const log = (m) => out.push(m);

const store = await import('../src/utils/auth-store.ts');
const { ApiClient, NOT_SIGNED_IN } = await import('../src/utils/api-client.ts');
const { loginCommand, logoutCommand } = await import('../src/commands/auth.ts');
const { onboardCommand } = await import('../src/commands/onboard.ts');

test.after(() => {
  console.log = origLog;
  rmSync(dir, { recursive: true, force: true });
});

const noTokenPrinted = () => {
  const all = [...printed, ...out].join('\n');
  assert.ok(!all.includes(TOKEN), 'token printed');
  assert.ok(!all.includes(PASSWORD), 'password printed');
};

test('chat without a saved session fails before any request', async () => {
  calls.length = 0;
  await assert.rejects(new ApiClient().sendMessage('hi'), (e) => e.message === NOT_SIGNED_IN);
  assert.equal(calls.length, 0);
});

test('login posts to the default backend and saves the token in a 0600 file', async () => {
  calls.length = 0;
  respond = (c) => c.url.endsWith('/api/auth/login')
    ? { status: 200, body: { success: true, user: { username: 'owner1' }, token: TOKEN } }
    : { status: 404, body: {} };
  const ok = await loginCommand({ email: 'owner@example.test' }, { askHidden: async () => PASSWORD, log });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:41522/api/auth/login');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { email: 'owner@example.test', password: PASSWORD });
  assert.equal(calls[0].headers.Authorization, undefined);

  const file = store.getTokenFilePath();
  assert.equal(file, join(dir, 'config', 'agent-player', 'auth.json'));
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, 'config', 'agent-player')).mode & 0o777, 0o700);
  }
  assert.equal(store.getStoredToken(), TOKEN);
  assert.ok(!readFileSync(file, 'utf-8').includes(PASSWORD), 'password must not be stored');
  noTokenPrinted();
});

test('wrong password: no token file change, clear message', async () => {
  respond = () => ({ status: 401, body: { error: 'Unauthorized' } });
  const ok = await loginCommand({ email: 'owner@example.test' }, { askHidden: async () => 'wrong', log });
  assert.equal(ok, false);
  assert.match(out.at(-1), /wrong email or password/);
  assert.equal(store.getStoredToken(), TOKEN, 'previous session kept');
});

test('chat and other calls send the bearer token; chat uses the messages API', async () => {
  calls.length = 0;
  respond = (c) => c.url.endsWith('/api/chat')
    ? { status: 200, body: { message: { role: 'assistant', content: 'hello there' } } }
    : { status: 200, body: { skills: [{ id: 's1' }] } };
  const client = new ApiClient();
  assert.equal(await client.sendMessage('hi'), 'hello there');
  assert.deepEqual(await client.getSkills(), [{ id: 's1' }]);
  assert.equal(calls[0].url, 'http://127.0.0.1:41522/api/chat');
  assert.deepEqual(calls[0].body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(calls[0].body.stream, false);
  for (const c of calls) assert.equal(c.headers.Authorization, `Bearer ${TOKEN}`);
  noTokenPrinted();
});

test('chat projects completed SSE through the authenticated request adapter and rejects partial replies', async () => {
  calls.length = 0;
  const client = new ApiClient();
  respond = () => ({ status: 200, raw: 'data: {"type":"text","content":"fixture answer"}\n\ndata: {"type":"done"}\n\n' });
  assert.equal(await client.sendMessage('hi'), 'fixture answer');
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  respond = () => ({ status: 200, raw: 'data: {"type":"text","content":"partial"}\n\n' });
  await assert.rejects(client.sendMessage('hi'), /interrupted/);
  noTokenPrinted();
});

test('health check does not send the token', async () => {
  calls.length = 0;
  respond = () => ({ status: 200, body: { status: 'ok' } });
  assert.equal(await new ApiClient().isBackendRunning(), true);
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('an ended session (401) gives a login hint without the token', async () => {
  respond = () => ({ status: 401, body: { error: 'Authentication required' } });
  await assert.rejects(new ApiClient().sendMessage('hi'), (e) => {
    assert.equal(e.message, NOT_SIGNED_IN);
    assert.ok(!e.message.includes(TOKEN));
    return true;
  });
});

test('onboard points to the web wizard and never calls the removed route', async () => {
  calls.length = 0;
  respond = () => ({ status: 200, body: { status: 'ok' } });
  out.length = 0;
  await onboardCommand({ log });
  assert.ok(calls.every((c) => !c.url.includes('/api/onboarding')));
  assert.ok(out.some((l) => l.includes('http://127.0.0.1:41521/onboarding')));
});

test('logout ends the session at the backend and removes only its own file', async () => {
  calls.length = 0;
  respond = () => ({ status: 200, body: { success: true } });
  await logoutCommand({ log });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:41522/api/auth/logout');
  assert.equal(calls[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(existsSync(store.getTokenFilePath()), false);
  assert.equal(store.getStoredToken(), null);

  // A file at that path that the CLI did not create is left alone.
  mkdirSync(store.getConfigDir(), { recursive: true });
  writeFileSync(store.getTokenFilePath(), '{"something":"else"}');
  calls.length = 0;
  await logoutCommand({ log });
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(store.getTokenFilePath(), 'utf-8'), '{"something":"else"}');
  noTokenPrinted();
});
