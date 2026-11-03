// MOBILE-CTRL-01 Task 5: the desktop chat page on the phone (phone/ui-bridge.ts).
//  - the phone's short list is pinned: widening it fails this test; dangerous routes are refused
//    before the desktop gate or the backend is asked;
//  - api.call runs as the owner through the desktop gate and its projection, no token in the answer;
//  - ui.get serves only the verified build, in parts, nothing outside its manifest;
//  - api.stream sends a run's projected events, then stream.end; limits per phone.
// Throwaway DB, keys and build folder; no network.
// Run: node --import tsx --import ../../scripts/test-temp-root.mjs --test test/phone-ui-bridge.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-phone-ui-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.AGENT_PLAYER_BACKGROUND = 'off';
globalThis.WebSocket = class { constructor(url) { throw new Error(`no network in this test: ${url}`); } };
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {};
console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('ui-owner', 'ui-owner@example.test', 'ui-owner', 'x', 'owner', 'active', 1)`).run();
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const B = await import(join(backendDir, 'src/phone/ui-bridge.ts'));
const { runCommand } = await import(join(backendDir, 'src/phone/commands.ts'));
const { chatRuns, ChatRun } = await import(join(backendDir, 'src/services/chat-runs.ts'));
const app = await buildServer({ logger: false });
await app.ready();
B.bindPhoneApi(app);
test.after(async () => { B.bindPhoneApi(null); await app.close(); });

const TID = '0b8a1c4e-0000-4000-8000-000000000001';
let n = 0;
const ctx = (frames = []) => ({ deviceId: `dev-${++n}`, ownerId: 'ui-owner', now: () => Date.now(), push: (f) => { frames.push(f); return true; } });
const code = async (p) => { try { await p; return null; } catch (e) { return e.code; } };

test('the phone list is exactly the chat page (pinned)', async () => {
  const yes = [
    ['GET', '/api/auth/me'], ['GET', '/api/agents'], ['GET', '/api/agents/main'],
    ['GET', '/api/chat/conversations'], ['POST', '/api/chat/conversations'],
    ['GET', '/api/chat/conversations/abcdefgh1'], ['PATCH', '/api/chat/conversations/abcdefgh1'],
    ['GET', '/api/chat/conversations/abcdefgh1/messages?limit=30'],
    ['POST', '/api/chat/conversations/abcdefgh1/runs'], ['POST', '/api/chat/runs/run-abcdefgh/stop'],
    ['POST', '/api/chat/runs/run-abcdefgh/steer'],
    ['GET', '/api/chat/conversations/abcdefgh1/usage'], ['GET', '/api/chat/conversations/abcdefgh1/team'],
    ['GET', '/api/chat/conversations/abcdefgh1/schedule'], ['POST', '/api/chat/conversations/abcdefgh1/stop'],
    ['GET', '/api/chat/sidebar'], ['PUT', '/api/chat/sidebar'], ['GET', '/api/chat/panel'], ['PUT', '/api/chat/panel'],
    ['GET', '/api/chat/last'], ['GET', '/api/chat/settings'],
    // The owner's decision: the terminal too (the app asks for its biometric check first).
    ['GET', '/api/terminal'], ['GET', '/api/terminal/prefs'], ['PUT', '/api/terminal/prefs'], ['POST', '/api/terminal/sessions'],
    ['POST', `/api/terminal/sessions/${TID}/input`], ['POST', `/api/terminal/sessions/${TID}/resize`], ['DELETE', `/api/terminal/sessions/${TID}`],
  ];
  for (const [m, p] of yes) assert.equal(await B.phoneMayCall(m, p), true, `${m} ${p}`);
  const no = [
    ['GET', '/api/phone/devices'], ['POST', '/api/phone/pairing'], ['DELETE', '/api/phone/devices'], ['PUT', '/api/phone/settings'],
    ['GET', '/api/terminal/sessions'], ['GET', `/api/terminal/sessions/${TID}/stream`], ['POST', '/api/terminal/sessions/not-an-id/input'], ['DELETE', '/api/terminal/sessions'],
    ['GET', '/api/chat/projects/abcdefgh1/file?path=a.txt'], ['GET', '/api/chat/projects/abcdefgh1/tree'], ['GET', '/api/chat/projects/abcdefgh1/diff?path=a'],
    ['GET', '/api/chat/projects/abcdefgh1/variables'], ['PUT', '/api/chat/projects/abcdefgh1/variables/API_KEY'], ['GET', '/api/chat/project-folders'],
    ['DELETE', '/api/chat/conversations/abcdefgh1'], ['POST', '/api/chat/transcribe'], ['POST', '/api/chat/conversations/abcdefgh1/images'],
    ['GET', '/api/chat/runs/run-abcdefgh/events'], ['PUT', '/api/chat/settings'],
    ['POST', '/api/auth/login'], ['POST', '/api/auth/logout'], ['GET', '/api/users'], ['PUT', '/api/agents/main'], ['POST', '/api/agents/name-suggestion'],
    ['GET', '/api/credentials'], ['GET', '/api/backups'], ['GET', '/api/audit'], ['GET', '/api/extensions'], ['POST', '/api/mcp/servers'],
    ['GET', '/api/runs'], ['GET', '/api/approvals'], ['GET', '/api/memory/proposals'], ['GET', '/health'], ['GET', '/api/../api/phone/devices'],
  ];
  for (const [m, p] of no) assert.equal(await B.phoneMayCall(m, p), false, `${m} ${p}`);
});

test('api.call refuses outside the list before anything runs', async () => {
  let injected = 0;
  const real = app.inject.bind(app);
  app.inject = (...a) => { injected++; return real(...a); };
  try {
    for (const path of ['/api/phone/devices', `/api/terminal/sessions/${TID}/stream`, '/api/auth/me/../../phone/devices']) {
      assert.equal(await code(runCommand(ctx(), { type: 'api.call', method: 'GET', path })), 'not_allowed', path);
    }
    assert.equal(await code(runCommand(ctx(), { type: 'api.call', method: 'GET', path: '/api/auth/me', extra: 1 })), 'bad_format');
    assert.equal(await code(runCommand(ctx(), { type: 'api.call', method: 'TRACE', path: '/api/auth/me' })), 'bad_format');
    assert.equal(await code(runCommand(ctx(), { type: 'api.call', method: 'GET', path: '/api/auth/me', body: {} })), 'bad_format');
    assert.equal(injected, 0);
  } finally { app.inject = real; }
});

test('api.call runs as the owner through the desktop gate and projection', async () => {
  const c = ctx();
  const me = await B.apiCall(c, { type: 'api.call', method: 'GET', path: '/api/auth/me' });
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.body), ['user']);
  assert.equal(me.body.user.id, 'ui-owner');
  assert.equal(me.body.user.role, 'owner');
  assert.doesNotMatch(JSON.stringify(me), /Bearer|eyJ/);

  const made = await B.apiCall(c, { type: 'api.call', method: 'POST', path: '/api/chat/conversations', body: { title: 'From the phone' } });
  assert.equal(made.status, 201, JSON.stringify(made));
  // A change made from the phone is audited with the phone; a read is not.
  await new Promise((r) => setTimeout(r, 50));
  const rows = db.prepare("SELECT action, resource_id, metadata FROM audit_logs WHERE action = 'phone.api.call'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource_id, c.deviceId);
  assert.match(rows[0].metadata, /"path":"\/api\/chat\/conversations"/);
  const list = await B.apiCall(c, { type: 'api.call', method: 'GET', path: '/api/chat/conversations' });
  assert.equal(list.status, 200);
  assert.ok(JSON.stringify(list.body).includes('From the phone'));

  // The desktop gate refuses a body it does not know: answered 400 without reaching the backend.
  const bad = await B.apiCall(c, { type: 'api.call', method: 'POST', path: '/api/chat/conversations', body: { title: 'x', evil: true } });
  assert.deepEqual(bad, { status: 400, body: null });
});

test('api.call stops when the owner is no longer an active owner', async () => {
  db.prepare("UPDATE users SET status = 'suspended' WHERE id = 'ui-owner'").run();
  try { assert.equal(await code(B.apiCall(ctx(), { type: 'api.call', method: 'GET', path: '/api/auth/me' })), 'owner_changed'); }
  finally { db.prepare("UPDATE users SET status = 'active' WHERE id = 'ui-owner'").run(); }
});

test('api.call is limited per phone', async () => {
  const c = ctx();
  for (let i = 0; i < B.LIMITS.call; i++) await B.apiCall(c, { type: 'api.call', method: 'GET', path: '/api/auth/me' });
  assert.equal(await code(B.apiCall(c, { type: 'api.call', method: 'GET', path: '/api/auth/me' })), 'rate_limited');
  // Another phone is not held back.
  assert.equal((await B.apiCall(ctx(), { type: 'api.call', method: 'GET', path: '/api/auth/me' })).status, 200);
});

test('ui.get serves only the verified build, in parts', async () => {
  const empty = join(dir, 'no-build');
  mkdirSync(empty);
  B.setUiPackageRoot(empty);
  assert.equal(await code(B.uiGet(ctx(), { type: 'ui.get', path: '/' })), 'ui_unavailable');
  const pkg = join(dir, 'core-ui-copy');
  mkdirSync(pkg);
  const { beginBuild, completeBuild } = createRequire(import.meta.url)(join(backendDir, '../core-ui/scripts/build-artifacts.cjs'));
  const { buildId, output } = beginBuild(pkg, 'current', 'fictional');
  mkdirSync(join(output, 'assets'));
  const big = randomBytes(B.UI_PART_BYTES * 2 + 10);
  writeFileSync(join(output, 'index.html'), '<!doctype html><title>Girru</title>');
  writeFileSync(join(output, 'THIRD_PARTY_NOTICES.txt'), 'notices');
  writeFileSync(join(output, 'assets', 'app-1.js'), big);
  writeFileSync(join(output, 'assets', 'app-1.css'), 'body{}');
  writeFileSync(join(output, 'secret.map'), 'not served');
  completeBuild(pkg, buildId, 'current');
  B.setUiPackageRoot(pkg);
  try {
    const c = ctx();
    for (const route of ['/', '/chat', '/settings']) {
      const r = await B.uiGet(c, { type: 'ui.get', path: route });
      assert.equal(r.status, 200);
      assert.equal(r.type, 'text/html; charset=utf-8');
      assert.equal(Buffer.from(r.body, 'base64').toString(), '<!doctype html><title>Girru</title>');
      assert.equal(r.build, buildId);
    }
    const parts = [];
    for (let part = 0; part < 3; part++) {
      const r = await B.uiGet(c, { type: 'ui.get', path: '/assets/app-1.js', part });
      assert.equal(r.parts, 3); assert.equal(r.size, big.length); assert.equal(r.type, 'text/javascript; charset=utf-8');
      parts.push(Buffer.from(r.body, 'base64'));
    }
    assert.ok(Buffer.concat(parts).equals(big));
    assert.equal(await code(B.uiGet(c, { type: 'ui.get', path: '/assets/app-1.js', part: 3 })), 'bad_format');
    for (const p of ['/secret.map', '/../package.json', '/assets/../index.html', '/assets/app-1.js.map', '/etc/passwd', 'index.html', '/memory/x']) {
      assert.equal((await B.uiGet(c, { type: 'ui.get', path: p })).status, 404, p);
    }
  } finally { B.setUiPackageRoot(null); }
});

test('api.stream sends the run as the page reads it, then stream.end', async () => {
  const run = new ChatRun('run-phone-stream-1', 'ui-owner', 'sess-1', Date.now());
  chatRuns['runs'].set(run.id, run);
  const emit = (frame) => { const e = { seq: run.events.length + 1, frame }; run.events.push(e); run.emitter.emit('event', e); };
  emit({ type: 'text', content: 'Hel' });
  const frames = [];
  const c = ctx(frames);
  assert.equal(await code(B.apiStream(c, { type: 'api.stream', path: '/api/chat/runs/run-phone-stream-1/stop' })), 'not_allowed');
  assert.equal(await code(B.apiStream(c, { type: 'api.stream', path: '/api/chat/runs/run-unknown-1/events' })), 'not_found');
  const started = await B.apiStream(c, { type: 'api.stream', path: '/api/chat/runs/run-phone-stream-1/events?after=0' });
  const done = started.follow();
  emit({ type: 'text', content: 'lo' });
  run.emitter.emit('preview', { type: 'preview', content: 'Hello wor' });
  // As ChatRun.finish does: the numbered end event, then 'end'.
  emit({ type: 'end', status: 'complete', ms: 1, at: 1 });
  run.status = 'complete';
  run.emitter.emit('end');
  await done;
  const data = frames.filter((f) => f.type === 'stream').map((f) => f.data);
  assert.deepEqual(data.filter((d) => d.seq > 0).map((d) => d.seq), [1, 2, 3]);
  assert.equal(data.at(-1).type, 'end');
  assert.ok(data.some((d) => d.type === 'preview' && d.seq === 0));
  assert.deepEqual(frames.at(-1), { type: 'stream.end', status: 'complete' });

  // Resume after seq 2: only the end comes back.
  const again = [];
  const r2 = await B.apiStream(ctx(again), { type: 'api.stream', path: '/api/chat/runs/run-phone-stream-1/events?after=2' });
  await r2.follow();
  assert.deepEqual(again.filter((f) => f.type === 'stream').map((f) => f.data.seq), [3]);

  // Another owner's run is not found.
  const other = new ChatRun('run-phone-stream-2', 'someone-else', 'sess-2', Date.now());
  chatRuns['runs'].set(other.id, other);
  assert.equal(await code(B.apiStream(ctx(), { type: 'api.stream', path: '/api/chat/runs/run-phone-stream-2/events' })), 'not_found');
});

test('api.stream ends dropped on a backed-up link, and open streams are limited', async () => {
  const run = new ChatRun('run-phone-stream-3', 'ui-owner', 'sess-3', Date.now());
  chatRuns['runs'].set(run.id, run);
  const frames = [];
  const c = { ...ctx(), push: (f) => { frames.push(f); return f.type !== 'stream'; } };
  const s = await B.apiStream(c, { type: 'api.stream', path: '/api/chat/runs/run-phone-stream-3/events' });
  const done = s.follow();
  const e = { seq: 1, frame: { type: 'text', content: 'x' } }; run.events.push(e); run.emitter.emit('event', e);
  await done;
  assert.deepEqual(frames.at(-1), { type: 'stream.end', status: 'dropped' });

  const busy = ctx();
  for (let i = 0; i < B.LIMITS.streams; i++) await B.apiStream(busy, { type: 'api.stream', path: '/api/chat/runs/run-phone-stream-3/events' });
  assert.equal(await code(B.apiStream(busy, { type: 'api.stream', path: '/api/chat/runs/run-phone-stream-3/events' })), 'rate_limited');
  run.finish('complete', Date.now());
});

test('the terminal from a phone: open, stream its output, type, exit; keystrokes audited once a minute', async () => {
  const { terminalManager } = await import(join(backendDir, 'src/api/routes/terminal.ts'));
  let emit = null, exit = null;
  const typed = [];
  terminalManager.spawnFn = () => ({ onData(f) { emit = f; }, onExit(f) { exit = f; }, write(d) { typed.push(d); }, resize() {}, kill() {} });
  terminalManager.env = { AGENT_TERMINAL: 'true', PATH: '/usr/bin:/bin' };
  const prev = process.env.AGENT_TERMINAL;
  process.env.AGENT_TERMINAL = 'true';
  try {
    const c = ctx();
    const opened = await B.apiCall(c, { type: 'api.call', method: 'POST', path: '/api/terminal/sessions', body: { cols: 80, rows: 24 } });
    assert.equal(opened.status, 201, JSON.stringify(opened));
    const id = opened.body.id;
    assert.match(id, /^[0-9a-f-]{36}$/);

    // The terminal's stream never goes through api.call.
    assert.equal(await code(B.apiCall(c, { type: 'api.call', method: 'GET', path: `/api/terminal/sessions/${id}/stream` })), 'not_allowed');
    const frames = [];
    const s = await B.apiStream({ ...c, push: (f) => { frames.push(f); return true; } }, { type: 'api.stream', path: `/api/terminal/sessions/${id}/stream?after=0` });
    const done = s.follow();
    emit('hello\r\n');
    for (let i = 0; i < 3; i++) assert.equal((await B.apiCall(c, { type: 'api.call', method: 'POST', path: `/api/terminal/sessions/${id}/input`, body: { data: 'l' } })).status, 204);
    assert.deepEqual(typed, ['l', 'l', 'l']);
    exit({ exitCode: 0 });
    await done;
    const out = frames.filter((f) => f.type === 'stream');
    assert.equal(out[0].event, 'output');
    assert.equal(out[0].data.data, 'hello\r\n');
    assert.ok(out[0].data.seq >= 1);
    assert.deepEqual(out.at(-1), { type: 'stream', event: 'exit', data: { exitCode: 0 } });
    assert.deepEqual(frames.at(-1), { type: 'stream.end', status: 'complete' });

    await new Promise((r) => setTimeout(r, 50));
    const rows = db.prepare("SELECT action, metadata FROM audit_logs WHERE resource_id = ? ORDER BY id").all(c.deviceId);
    assert.deepEqual(rows.map((r) => r.action), ['phone.api.call', 'phone.api.stream', 'phone.terminal.input']);
    // The route's own gates apply: switched off, or no longer an active owner, nothing streams.
    process.env.AGENT_TERMINAL = 'false';
    assert.equal(await code(B.apiStream(ctx(), { type: 'api.stream', path: `/api/terminal/sessions/${TID}/stream` })), 'disabled');
    process.env.AGENT_TERMINAL = 'true';
    db.prepare("UPDATE users SET status = 'suspended' WHERE id = 'ui-owner'").run();
    try { assert.equal(await code(B.apiStream(ctx(), { type: 'api.stream', path: `/api/terminal/sessions/${TID}/stream` })), 'owner_changed'); }
    finally { db.prepare("UPDATE users SET status = 'active' WHERE id = 'ui-owner'").run(); }
    // Another owner's terminal is not found.
    assert.equal(await code(B.apiStream(ctx(), { type: 'api.stream', path: `/api/terminal/sessions/${TID}/stream` })), 'not_found');
  } finally {
    if (prev === undefined) delete process.env.AGENT_TERMINAL; else process.env.AGENT_TERMINAL = prev;
    terminalManager.closeAll();
  }
});
