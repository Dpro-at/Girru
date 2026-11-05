// S0-A.4: call-center AI tools call the backend's telephony routes with a
// short-lived token for the user of the current agent turn; without a user
// they refuse and make no call.
// Run: node --import tsx --test test/call-center-tools-auth.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-cc-tools-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only

const realFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), headers: new Headers(init.headers) });
  return new Response(JSON.stringify({ callSid: 'CA1', status: 'queued' }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('cc-owner', 'cc@example.test', 'cc', 'x', 'owner', 'active', 1)`).run();

const { makeCallTool, hangupCallTool } = await import(join(backendDir, 'test/fixtures/legacy-apps/extensions/call-center/src/tools.js'));
const { verifyToken } = await import(join(backendDir, 'src/auth/jwt.ts'));

test.after(() => {
  globalThis.fetch = realFetch;
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

test('make_call and hangup_call send a token for the turn user', async () => {
  const made = await makeCallTool.execute({ callPointId: 'cp1', toNumber: '+15550000000' }, { userId: 'cc-owner' });
  assert.equal(made.success, true, made.error);
  const hung = await hangupCallTool.execute({ callSid: 'CA1/../x' }, { userId: 'cc-owner' });
  assert.equal(hung.success, true, hung.error);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const auth = c.headers.get('authorization');
    assert.match(auth || '', /^Bearer /, c.url);
    assert.equal(verifyToken(auth.slice(7)).userId, 'cc-owner');
  }
  assert.ok(calls[1].url.endsWith('/api/telephony/calls/CA1%2F..%2Fx/hangup'), calls[1].url);
});

test('without a turn user the tools refuse and make no request', async () => {
  calls.length = 0;
  const made = await makeCallTool.execute({ callPointId: 'cp1', toNumber: '+15550000000' });
  assert.equal(made.success, false);
  const hung = await hangupCallTool.execute({ callSid: 'CA1' }, {});
  assert.equal(hung.success, false);
  assert.equal(calls.length, 0);
});
