// TERM-01: built-in terminal. Owner only, loopback only, off unless
// AGENT_TERMINAL=true; the shell never sees the server's secrets.
// Run: node --import tsx --test test/terminal.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network. Real PTY on POSIX.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-terminal-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.AGENT_TERMINAL = 'true';
process.env.SHELL = '/bin/sh';
const SECRET_MARK = 'term-secret-' + randomBytes(6).toString('hex');
process.env.OPENAI_API_KEY = SECRET_MARK; // must never reach the shell

const quiet = { log: console.log, warn: console.warn };
console.log = () => {};
console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('tm-owner', 'owner');
addUser('tm-admin', 'admin');
addUser('tm-user', 'user');

const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { terminalRoutesWith } = await import(join(backendDir, 'src/api/routes/terminal.ts'));
const mgr = await import(join(backendDir, 'src/terminal/manager.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');

const manager = new mgr.TerminalManager({ cwd: dir });
const app = Fastify();
registerAuthGate(app);
await app.register(terminalRoutesWith(manager));
await app.listen({ host: '127.0.0.1', port: 0 });
const port = app.server.address().port;

console.log = quiet.log;
console.warn = quiet.warn;

test.after(async () => {
  await app.close();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` });
// app.inject uses a fake socket whose remoteAddress is 127.0.0.1.
const call = (method, url, who, payload) => app.inject({ method, url, headers: who ? auth(who) : {}, payload });
const posix = platform() !== 'win32';

/** Read the SSE stream over a real socket until `until(text)` or timeout. */
function readStream(id, who, until, after = 0, ms = 8000) {
  return new Promise((resolve, reject) => {
    let text = '';
    const req = http.get({ host: '127.0.0.1', port, path: `/api/terminal/sessions/${id}/stream?after=${after}`, headers: auth(who) }, res => {
      res.setEncoding('utf8');
      res.on('data', d => {
        text += d;
        if (until(text)) { req.destroy(); resolve({ status: res.statusCode, text }); }
      });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', err => (err.code === 'ECONNRESET' ? resolve({ text }) : reject(err)));
    setTimeout(() => { req.destroy(); resolve({ text, timedOut: true }); }, ms).unref();
  });
}
const outputOf = (sse) => sse.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)).data ?? '').join('');

test('only an active owner may use the terminal (gate + handler)', async () => {
  assert.equal((await call('GET', '/api/terminal')).statusCode, 401);
  for (const who of ['tm-admin', 'tm-user']) {
    assert.equal((await call('GET', '/api/terminal', who)).statusCode, 403, `GET as ${who}`);
    assert.equal((await call('POST', '/api/terminal/sessions', who, {})).statusCode, 403, `POST as ${who}`);
  }
  const res = await call('GET', '/api/terminal', 'tm-owner');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { enabled: true, sessions: [] });
});

test('off unless AGENT_TERMINAL=true', async () => {
  const off = new mgr.TerminalManager({ env: { PATH: '/usr/bin:/bin' }, spawn: () => { throw new Error('must not spawn'); } });
  await assert.rejects(off.create('tm-owner'), err => err.code === 'disabled');
  assert.equal(mgr.terminalEnabled({ AGENT_TERMINAL: '1' }), false);
  assert.equal(mgr.terminalEnabled({ AGENT_TERMINAL: 'true' }), true);
});

test('a peer that is not loopback is refused', async () => {
  const { isLoopbackPeer } = await import(join(backendDir, 'src/api/routes/terminal.ts'));
  assert.equal(isLoopbackPeer({ socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.equal(isLoopbackPeer({ socket: { remoteAddress: '::1' } }), true);
  assert.equal(isLoopbackPeer({ socket: { remoteAddress: '192.168.1.20' } }), false);
  assert.equal(isLoopbackPeer({ socket: { remoteAddress: undefined } }), false);
});

test('the shell environment is an allow-list (no server secrets)', () => {
  const env = mgr.shellEnv('darwin', { PATH: '/bin', HOME: '/h', JWT_SECRET: 'x', OPENAI_API_KEY: 'y', DATABASE_URL: 'z' });
  assert.deepEqual(Object.keys(env).sort(), ['COLORTERM', 'HOME', 'PATH', 'PROMPT_EOL_MARK', 'TERM']);
  const win = mgr.shellEnv('win32', { Path: 'x', PATH: 'C:\\Windows', SystemRoot: 'C:\\Windows', ENCRYPTION_KEY: 'k' });
  assert.equal(win.ENCRYPTION_KEY, undefined);
  assert.equal(win.SystemRoot, 'C:\\Windows');
  assert.deepEqual(mgr.defaultShell('win32', {}), { file: 'powershell.exe', args: ['-NoLogo'] });
});

test('sizes are clamped; bad resize input is refused', () => {
  assert.deepEqual(mgr.clampSize(9999, 1), { cols: mgr.MAX_COLS, rows: mgr.MIN_ROWS });
  assert.deepEqual(mgr.clampSize('80', null), { cols: 80, rows: 24 });
});

test('real shell: run a command, stream output, resume, isolation, close', { skip: !posix && 'POSIX PTY only here' }, async () => {
  const created = await call('POST', '/api/terminal/sessions', 'tm-owner', { cols: 100, rows: 30 });
  assert.equal(created.statusCode, 201, created.body);
  const { id, cols, rows } = created.json();
  assert.equal(cols, 100);
  assert.equal(rows, 30);

  // Another owner-tier account cannot see or drive this session.
  addUser('tm-owner2', 'owner');
  assert.equal((await call('POST', `/api/terminal/sessions/${id}/input`, 'tm-owner2', { data: 'id\n' })).statusCode, 404);
  assert.deepEqual((await call('GET', '/api/terminal', 'tm-owner2')).json().sessions, []);

  const streaming = readStream(id, 'tm-owner', t => outputOf(t).includes('answer=42') && outputOf(t).includes('secret=[]'));
  const cmd = 'echo answer=$((6*7)); echo "secret=[$OPENAI_API_KEY]"\n';
  assert.equal((await call('POST', `/api/terminal/sessions/${id}/input`, 'tm-owner', { data: cmd })).statusCode, 204);
  const got = await streaming;
  const out = outputOf(got.text);
  assert.match(out, /answer=42/);
  assert.match(out, /secret=\[\]/);
  assert.ok(!got.text.includes(SECRET_MARK), 'server secret leaked into the shell');

  // Resume after the last seq: only newer output arrives.
  const lastSeq = Math.max(...got.text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)).seq ?? 0));
  const resumed = readStream(id, 'tm-owner', t => outputOf(t).includes('second=ok'), lastSeq);
  await call('POST', `/api/terminal/sessions/${id}/input`, 'tm-owner', { data: 'echo second=ok\n' });
  const again = outputOf((await resumed).text);
  assert.match(again, /second=ok/);
  assert.doesNotMatch(again, /answer=42/);

  assert.equal((await call('POST', `/api/terminal/sessions/${id}/resize`, 'tm-owner', { cols: 120, rows: 40 })).statusCode, 200);
  assert.equal((await call('POST', `/api/terminal/sessions/${id}/resize`, 'tm-owner', { cols: '1', rows: 40 })).statusCode, 400);
  assert.equal((await call('POST', `/api/terminal/sessions/${id}/input`, 'tm-owner', { data: '' })).statusCode, 400);
  assert.equal((await call('POST', `/api/terminal/sessions/${id}/input`, 'tm-owner', { data: 'x'.repeat(mgr.MAX_INPUT_BYTES + 1) })).statusCode, 400);

  assert.equal((await call('DELETE', `/api/terminal/sessions/${id}`, 'tm-owner')).statusCode, 204);
  assert.equal((await call('DELETE', `/api/terminal/sessions/${id}`, 'tm-owner')).statusCode, 404);
  const events = db.prepare(`SELECT event_type, user_id, resource_id FROM audit_logs WHERE resource_type = 'terminal' ORDER BY id`).all();
  assert.deepEqual(events.map(e => e.event_type), ['terminal.session.open', 'terminal.session.close']);
  assert.ok(events.every(e => e.user_id === 'tm-owner' && e.resource_id === id));
});

test('exit is streamed and input after exit is refused', { skip: !posix && 'POSIX PTY only here' }, async () => {
  const { id } = (await call('POST', '/api/terminal/sessions', 'tm-owner', {})).json();
  const streaming = readStream(id, 'tm-owner', t => t.includes('event: exit'));
  await call('POST', `/api/terminal/sessions/${id}/input`, 'tm-owner', { data: 'exit 3\n' });
  const got = await streaming;
  assert.match(got.text, /event: exit\ndata: \{"exitCode":3\}/);
  assert.equal((await call('POST', `/api/terminal/sessions/${id}/input`, 'tm-owner', { data: 'ls\n' })).statusCode, 409);
  await call('DELETE', `/api/terminal/sessions/${id}`, 'tm-owner');
});

test('per-owner session cap and malformed ids', async () => {
  let n = 0;
  const fake = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() { n++; } });
  const capped = new mgr.TerminalManager({ env: { AGENT_TERMINAL: 'true', PATH: '/bin' }, spawn: fake, cwd: dir });
  for (let i = 0; i < mgr.MAX_SESSIONS_PER_OWNER; i++) await capped.create('o1');
  await assert.rejects(capped.create('o1'), err => err.code === 'limit');
  await capped.create('o2'); // the cap is per owner
  capped.closeAll();
  assert.equal(n, mgr.MAX_SESSIONS_PER_OWNER + 1);
  assert.equal((await call('POST', '/api/terminal/sessions/not-a-uuid/input', 'tm-owner', { data: 'x' })).statusCode, 404);
});

test('finished sessions free their place; they are let go after the idle time', async () => {
  const exits = [];
  const fake = () => ({ onData() {}, onExit(fn) { exits.push(fn); }, write() {}, resize() {}, kill() {} });
  const m = new mgr.TerminalManager({ env: { AGENT_TERMINAL: 'true', PATH: '/bin' }, spawn: fake, idleTimeoutMs: 40, cwd: dir });
  for (let i = 0; i < mgr.MAX_SESSIONS_PER_OWNER; i++) await m.create('o1', { command: 'true' });
  await assert.rejects(m.create('o1'), err => err.code === 'limit');
  exits[0]({ exitCode: 0 });
  const next = await m.create('o1'); // the finished one no longer counts
  assert.ok(next.id);
  assert.equal(m.list('o1').filter(s => s.exited).length, 1, 'its transcript is still there to replay');
  await new Promise(r => setTimeout(r, 90));
  assert.equal(m.list('o1').filter(s => s.exited).length, 0, 'let go after the idle time');
  m.closeAll();
});

test('a chat command with hidden or control characters is refused', async () => {
  const fake = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
  const m = new mgr.TerminalManager({ env: { AGENT_TERMINAL: 'true', PATH: '/bin' }, spawn: fake, cwd: dir, os: 'darwin' });
  for (const bad of ['ls\u202e', 'echo a\u200bb', 'ls\x1b[2J', 'ls\r', 'x\0', ' ', 'a'.repeat(16001), 'ls\u061c', 'ls\u3164x', 'ls\u{E0041}', 'ls\u2028x', 'ls\u00ad']) {
    await assert.rejects(m.create('o1', { command: bad }), err => err.code === 'invalid', JSON.stringify(bad.slice(0, 20)));
  }
  assert.ok((await m.create('o1', { command: 'npm test\n\tnpm run build' })).id, 'newline and tab are fine');
  assert.equal(mgr.commandAllowed('npm test'), true);
  assert.equal(mgr.commandAllowed('echo "مرحبًا"'), true, 'Arabic with marks is fine');
  m.closeAll();
});

test('chat commands are refused on Windows until verified there; shells still open', async () => {
  const fake = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
  const m = new mgr.TerminalManager({ env: { AGENT_TERMINAL: 'true', PATH: 'C:\\Windows' }, spawn: fake, os: 'win32', cwd: dir });
  await assert.rejects(m.create('o1', { command: 'dir' }), err => err.code === 'unsupported');
  assert.ok((await m.create('o1')).id);
  m.closeAll();
});

test('a running command is not ended for being quiet; Stop escalates if it does not end', async () => {
  const signals = []; let exit;
  const fake = () => ({ onData() {}, onExit(fn) { exit = fn; }, write() {}, resize() {}, kill(sig) { signals.push(sig ?? 'default'); } });
  const m = new mgr.TerminalManager({ env: { AGENT_TERMINAL: 'true', PATH: '/bin' }, spawn: fake, idleTimeoutMs: 20, stopGraceMs: 30, cwd: dir, os: 'darwin' });
  const s = await m.create('o1', { command: 'sleep 100' });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(m.list('o1').length, 1, 'still there after the idle time');
  m.stop('o1', s.id);
  m.stop('o1', s.id); // a second Stop while waiting sends nothing new
  assert.deepEqual(signals, ['SIGTERM']);
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  exit({ exitCode: 0, signal: 9 });
  m.closeAll();
});

test('idle sessions are closed', async () => {
  let killed = false;
  const fake = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() { killed = true; } });
  const m = new mgr.TerminalManager({ env: { AGENT_TERMINAL: 'true', PATH: '/bin' }, spawn: fake, idleTimeoutMs: 30, cwd: dir });
  await m.create('o1');
  await new Promise(r => setTimeout(r, 80));
  assert.equal(killed, true);
  assert.deepEqual(m.list('o1'), []);
});

test('a chat project terminal opens in the project folder; unknown or foreign projects are refused', { skip: !posix }, async () => {
  const folder = join(dir, 'term-project'); mkdirSync(folder, { recursive: true });
  const { createProject } = await import(join(backendDir, 'src/repositories/chat-conversations.ts'));
  const p = await createProject('tm-owner', { name: 'Term', folder });
  const r = await call('POST', '/api/terminal/sessions', 'tm-owner', { projectId: p.id });
  assert.equal(r.statusCode, 201);
  const { realpathSync } = await import('node:fs');
  assert.equal(r.json().cwd, realpathSync(folder));
  const id = r.json().id;
  assert.equal((await call('POST', `/api/terminal/sessions/${id}/input`, 'tm-owner', { data: 'pwd\r' })).statusCode, 204);
  const out = await readStream(id, 'tm-owner', t => outputOf(t).includes('term-project'));
  assert.match(outputOf(out.text), /term-project/);
  await call('DELETE', `/api/terminal/sessions/${id}`, 'tm-owner');
  assert.equal((await call('POST', '/api/terminal/sessions', 'tm-owner', { projectId: '00000000-0000-4000-8000-000000000000' })).statusCode, 404);
  assert.equal((await call('POST', '/api/terminal/sessions', 'tm-owner', { projectId: '../etc' })).statusCode, 404);
});

test('terminal look: owner prefs saved and merged; unknown or out-of-range settings refused', async () => {
  const first = (await call('GET', '/api/terminal/prefs', 'tm-owner')).json();
  assert.equal(first.prefs.theme, 'dpro-night');
  assert.equal((await call('GET', '/api/terminal/prefs', 'tm-user')).statusCode, 403);
  const saved = await call('PUT', '/api/terminal/prefs', 'tm-owner', { theme: 'ocean', fontSize: 14, cursorStyle: 'bar' });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual([saved.json().prefs.theme, saved.json().prefs.fontSize, saved.json().prefs.cursorStyle, saved.json().prefs.cursorBlink], ['ocean', 14, 'bar', true]);
  assert.equal((await call('GET', '/api/terminal/prefs', 'tm-owner')).json().prefs.theme, 'ocean', 'kept across requests');
  for (const bad of [{ theme: 'neon' }, { fontSize: 99 }, { shell: '/bin/sh' }, { fontFamily: 'Comic Sans' }]) {
    assert.equal((await call('PUT', '/api/terminal/prefs', 'tm-owner', bad)).statusCode, 400, JSON.stringify(bad));
  }
  assert.equal((await call('PUT', '/api/terminal/prefs', 'tm-owner', { fontSize: 13 })).json().prefs.theme, 'ocean', 'a partial save keeps the rest');
});

test('node-pty spawn-helper gets the run permission it is installed without', { skip: process.platform === 'win32' }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  const pkg = mkdtempSync(j(tmpdir(), 'ap-pty-'));
  mkdirSync(j(pkg, 'prebuilds', 'darwin-x64'), { recursive: true });
  writeFileSync(j(pkg, 'package.json'), '{}');
  const helper = j(pkg, 'prebuilds', 'darwin-x64', 'spawn-helper');
  writeFileSync(helper, 'x', { mode: 0o644 });
  const fixed = mgr.ensureSpawnHelper('darwin', 'x64', () => j(pkg, 'package.json'));
  assert.deepEqual(fixed, [helper]);
  assert.equal(statSync(helper).mode & 0o111, 0o111);
  // Already runnable: nothing to do. Windows: never touched.
  assert.deepEqual(mgr.ensureSpawnHelper('darwin', 'x64', () => j(pkg, 'package.json')), []);
  assert.deepEqual(mgr.ensureSpawnHelper('win32', 'x64', () => j(pkg, 'package.json')), []);
});


test('reviewed command mode starts once and returns the actual shell exit', { skip: !posix }, async () => {
  const r = await call('POST','/api/terminal/sessions','tm-owner',{command:'printf COMMAND_MODE_OK; exit 7'});
  assert.equal(r.statusCode,201);
  const id=r.json().id;
  try {
    const transcript=await readStream(id,'tm-owner',s=>s.includes('"exitCode":7'));
    assert.match(transcript.text,/COMMAND_MODE_OK/);
    assert.match(transcript.text,/"exitCode":7/);
    assert.equal((await call('POST',`/api/terminal/sessions/${id}/stop`,'tm-user')).statusCode,403);
    assert.equal((await call('POST',`/api/terminal/sessions/${id}/stop`,'tm-owner')).statusCode,204);
  } finally { await call('DELETE',`/api/terminal/sessions/${id}`,'tm-owner'); }
});

test('Stop terminates a real command PTY and preserves the authoritative termination status', { skip: !posix }, async () => {
  const r=await call('POST','/api/terminal/sessions','tm-owner',{command:'printf READY_TO_STOP; read reply'});
  assert.equal(r.statusCode,201);const id=r.json().id;
  try {
    const started=await readStream(id,'tm-owner',s=>s.includes('READY_TO_STOP'));
    assert.match(started.text,/READY_TO_STOP/);
    assert.equal((await call('POST',`/api/terminal/sessions/${id}/stop`,'tm-owner')).statusCode,204);
    const finished=await readStream(id,'tm-owner',s=>s.includes('event: exit'));
    const event=finished.text.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6))).find(x=>'exitCode' in x);
    assert.ok(event && (event.signal>0 || event.exitCode!==0));
  } finally { await call('DELETE',`/api/terminal/sessions/${id}`,'tm-owner'); }
});
