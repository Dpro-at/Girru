// INSTALLER-05: inside the desktop app the backend needs the per-launch token
// on every request, reports its random port over IPC and stops on an IPC
// "shutdown" message or when the app's IPC channel closes.
//  - unit: the onRequest hook on a bare Fastify instance;
//  - process: the real server.ts as a child (PORT=0, throwaway data dir,
//    no network), started and stopped the way the desktop app does it.
// Run: node --import tsx --test test/launch-token.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';

const backendDir = process.cwd();
const { registerLaunchToken, launchTokenFromEnv, LAUNCH_HEADER } = await import(join(backendDir, 'src/api/launch-token.ts'));
const token = () => randomBytes(32).toString('base64url');

test('launchTokenFromEnv: unset = no check, malformed = refuse to start', () => {
  assert.equal(launchTokenFromEnv({}), null);
  assert.equal(launchTokenFromEnv({ AGENT_PLAYER_LAUNCH_TOKEN: '' }), null);
  const t = token();
  assert.equal(launchTokenFromEnv({ AGENT_PLAYER_LAUNCH_TOKEN: t }), t);
  assert.throws(() => launchTokenFromEnv({ AGENT_PLAYER_LAUNCH_TOKEN: 'short' }), /malformed/);
});

test('hook: every route needs the exact token; without a token nothing changes', async () => {
  const t = token();
  const app = Fastify({ logger: false });
  registerLaunchToken(app, t);
  app.get('/health', async () => ({ ok: true }));
  app.post('/api/setup/admin', async () => ({ ok: true }));
  for (const headers of [{}, { [LAUNCH_HEADER]: token() }, { [LAUNCH_HEADER]: `${t}x` }, { [LAUNCH_HEADER]: t.slice(1) }]) {
    const r = await app.inject({ method: 'GET', url: '/health', headers });
    assert.equal(r.statusCode, 403);
    assert.deepEqual(r.json(), { error: 'Forbidden', code: 'launch_token' });
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/setup/admin', payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/nope' })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: '/health', headers: { [LAUNCH_HEADER]: t } })).statusCode, 200);
  await app.close();

  const open = Fastify({ logger: false });
  registerLaunchToken(open, null);
  open.get('/health', async () => ({ ok: true }));
  assert.equal((await open.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  await open.close();
});

function startServer(t, base) {
  const dataDir = join(base, 'data');
  mkdirSync(dataDir, { recursive: true });
  const env = {
    PATH: process.env.PATH, HOME: join(base, 'home'), TMPDIR: join(base, 'tmp'),
    NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0', LOG_LEVEL: 'warn',
    AGENT_PLAYER_DATA_DIR: dataDir, AGENT_PLAYER_LAUNCH_TOKEN: t, ALLOWED_ORIGINS: 'http://127.0.0.1:1',
    AGENT_PLAYER_BACKGROUND: 'off', EXTENSIONS_DISABLED: 'true', MEMORY_EMBEDDINGS: 'hash',
    OLLAMA_URL: 'http://127.0.0.1:9', LOCAL_MODEL_API_URL: 'http://127.0.0.1:9/v1',
  };
  for (const d of [env.HOME, env.TMPDIR]) mkdirSync(d, { recursive: true });
  const loader = pathToFileURL(join(backendDir, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const child = fork(join(backendDir, 'src', 'api', 'server.ts'), [], { cwd: dataDir, env, execArgv: ['--import', loader], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Like the desktop app: the server asks for the memory-encryption plan first; this test has none.
  child.on('message', m => { if (m?.type === 'memory-control-ready') child.send({ v: 1, type: 'memory-control-bootstrap', plan: { control: null, selection: { selected: false, profileId: null, mode: 'none' } } }); });
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no listening message\n${output.slice(-2000)}`)), 120_000);
    child.on('message', m => { if (m && m.type === 'listening') { clearTimeout(timer); resolve(m); } });
    exited.then(r => { clearTimeout(timer); reject(new Error(`exited ${JSON.stringify(r)}\n${output.slice(-2000)}`)); });
  });
  return { child, ready, exited, output: () => output };
}

test('real server: random loopback port over IPC, token required, IPC shutdown exits 0', { timeout: 180_000 }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ap-launch-')));
  const t = token();
  const server = startServer(t, base);
  try {
    const ready = await server.ready;
    assert.equal(ready.host, '127.0.0.1');
    assert.ok(Number.isInteger(ready.port) && ready.port > 0 && ready.port !== 41522);
    const url = `http://127.0.0.1:${ready.port}/health`;
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { headers: { [LAUNCH_HEADER]: token() } })).status, 403);
    assert.equal((await fetch(url, { headers: { [LAUNCH_HEADER]: t } })).status, 200);
    assert.ok(!server.output().includes(t), 'token must never be printed');
    server.child.send({ type: 'shutdown' });
    const result = await server.exited;
    assert.deepEqual(result, { code: 0, signal: null });
    await assert.rejects(fetch(url));
  } finally {
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
});

test('real server: stops by itself when the app\'s IPC channel closes', { timeout: 180_000 }, async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ap-launch-')));
  const server = startServer(token(), base);
  try {
    await server.ready;
    server.child.disconnect();
    const result = await server.exited;
    assert.equal(result.code, 0);
  } finally {
    if (server.child.exitCode === null) server.child.kill('SIGKILL');
    rmSync(base, { recursive: true, force: true });
  }
});
