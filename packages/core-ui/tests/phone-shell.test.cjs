// The computer's chat page inside the Girru phone app (girru-app://computer):
// the origin is accepted only with the app's shell object, no token or cookie
// leaves the page, and the page starts signed in with a placeholder.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionClient, createSameOriginTransport, isShellOrigin, SHELL_ORIGIN, SHELL_SESSION } = require('../src/session.ts');
const { localSessionKeep } = require('../src/local-session-keep.ts');

const user = { id: 'fiction-owner', username: 'Fiction', email: 'fiction@example.invalid', role: 'owner' };

test('the shell origin needs the shell object', () => {
  assert.equal(isShellOrigin(SHELL_ORIGIN, { platform: 'ios', bridge: 1 }), true);
  assert.equal(isShellOrigin(SHELL_ORIGIN, undefined), false);
  assert.equal(isShellOrigin('girru-app://evil', { platform: 'ios' }), false);
  assert.equal(isShellOrigin('https://computer', { platform: 'ios' }), false);
  assert.throws(() => createSameOriginTransport(SHELL_ORIGIN, fetch));
});

test('inside the app: no Authorization, no cookies, and the page starts signed in', async () => {
  globalThis.girruShell = Object.freeze({ platform: 'ios', bridge: 1 });
  try {
    const calls = [];
    const fetcher = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ user }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const keep = localSessionKeep('computer', SHELL_ORIGIN);
    assert.equal(keep.load(), SHELL_SESSION);
    const client = new SessionClient({ live: createSameOriginTransport(SHELL_ORIGIN, fetcher) });
    client.selectMode('live');
    assert.equal(await client.resume(keep), true);
    assert.equal(client.getSnapshot().phase, 'authenticated');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${SHELL_ORIGIN}/api/auth/me`);
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(Object.keys(calls[0].init.headers).some((k) => k.toLowerCase() === 'authorization'), false);
  } finally { delete globalThis.girruShell; }
});

test('outside the app nothing changes', () => {
  assert.equal(localSessionKeep('computer', 'http://computer'), null);
  assert.equal(localSessionKeep('127.0.0.1', 'http://127.0.0.1:42522').load(), 'dpro-remembered-session');
});

test('meetings on the phone ask the app for Face ID and cap a spoken turn', async () => {
  const { phoneConfirm, PHONE_TURN_MS, PHONE_AUDIO_CHARS } = require('../src/phone-terminal-keys.ts');
  assert.equal(await phoneConfirm('Start the meeting', undefined), true, 'outside the app nothing is asked');
  const asked = [];
  const ios = (ok) => ({ girruShell: { platform: 'ios', bridge: 1 }, webkit: { messageHandlers: { girru: { postMessage: async (m) => { asked.push(m); return { ok }; } } } } });
  assert.equal(await phoneConfirm('Start the meeting', ios(true)), true);
  assert.equal(await phoneConfirm('End the meeting', ios(false)), false, 'a cancelled Face ID stops the step');
  assert.deepEqual(asked, [{ type: 'auth.request', reason: 'Start the meeting' }, { type: 'auth.request', reason: 'End the meeting' }]);
  assert.equal(PHONE_TURN_MS, 40_000);
  assert.ok(PHONE_AUDIO_CHARS + 1024 <= 256 * 1024, 'a capped turn fits the phone request');
});
