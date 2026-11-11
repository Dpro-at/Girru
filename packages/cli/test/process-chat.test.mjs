// Real CLI processes, piped stdin and loopback HTTP; no injected prompt/client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const loader = import.meta.resolve('tsx');
const password = '  Fixture π!9 password  ';
const token = 'fixture-' + randomBytes(24).toString('hex');

async function fixture(t, { signedIn = false, health = 200, chatStatus = 200, stream } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cli-process-'));
  const config = join(home, 'config');
  mkdirSync(config, { mode: 0o700 });
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ path: req.url, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/health') { res.statusCode = health; return res.end(JSON.stringify({ status: 'ok' })); }
    if (req.url === '/api/auth/login') {
      assert.equal(body.password, password);
      return res.end(JSON.stringify({ token, user: { username: 'fixture' } }));
    }
    assert.equal(req.url, '/api/chat', 'only fixture health/login/chat endpoints may be contacted');
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.statusCode = chatStatus;
    if (stream !== undefined) {
      res.setHeader('Content-Type', 'text/event-stream');
      return res.end(stream);
    }
    return res.end(JSON.stringify(chatStatus === 200 ? { message: { content: 'fixture answer' } } : { error: 'Fixture refusal' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  if (signedIn) writeFileSync(join(config, 'auth.json'), JSON.stringify({ createdBy: 'agent-player-cli', token, backendUrl: url }), { mode: 0o600 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const run = (args, input = '') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, entry, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config,
        TMPDIR: home, TEMP: home, TMP: home, AGENT_PLAYER_CONFIG_DIR: config, AGENT_PLAYER_URL: url, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Fixture CLI timed out')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, output: stdout + stderr }); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
  return { run, requests, config };
}

for (const [name, ending] of [['LF', '\n'], ['CRLF', '\r\n'], ['EOF without newline', '']]) {
  test(`actual login reads a hidden piped password with ${name}`, async t => {
    const f = await fixture(t);
    const result = await f.run(['login', '--email', 'fixture@example.test'], password + ending);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Signed in/);
    assert.deepEqual(f.requests.map(r => r.path), ['/api/auth/login']);
    assert.equal(f.requests[0].body.password, password, 'do not trim password bytes');
    assert.ok(!result.output.includes(password));
    assert.ok(!result.output.includes(token));
    const saved = readFileSync(join(f.config, 'auth.json'), 'utf8');
    assert.ok(!saved.includes(password));
    if (process.platform !== 'win32') assert.equal(statSync(join(f.config, 'auth.json')).mode & 0o777, 0o600);
  });
}

test('actual login consumes only the first piped line without echo', async t => {
  const f = await fixture(t);
  const result = await f.run(['login', '--email', 'fixture@example.test'], password + '\nignored-second-line\n');
  assert.equal(result.code, 0, result.output);
  assert.equal(f.requests.length, 1);
  assert.ok(!result.output.includes(password));
  assert.ok(!result.output.includes('ignored-second-line'));
});

for (const input of ['', '\n']) {
  test(`actual login refuses ${input ? 'an empty line' : 'empty EOF'} without a request or token file`, async t => {
    const f = await fixture(t);
    const result = await f.run(['login', '--email', 'fixture@example.test'], input);
    assert.equal(result.code, 1);
    assert.match(result.output, /Password is required/);
    assert.equal(f.requests.length, 0);
    assert.equal(existsSync(join(f.config, 'auth.json')), false);
  });
}

test('actual unsigned chat fails with exit1 and never submits chat intent', async t => {
  const f = await fixture(t);
  const result = await f.run(['chat', 'fixture message']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Not signed in/);
  assert.deepEqual(f.requests.map(r => r.path), ['/health']);
});

for (const chatStatus of [401, 403, 409, 429, 500]) {
  test(`actual authenticated chat exits1 on HTTP${chatStatus}, without retry or fallback`, async t => {
    const f = await fixture(t, { signedIn: true, chatStatus });
    const result = await f.run(['chat', 'fixture message']);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Failed to send message/);
    assert.ok(!result.output.includes(token));
    assert.deepEqual(f.requests.map(r => r.path), ['/health', '/api/chat']);
  });
}

test('actual chat reports unhealthy backend as a failed command without sending intent', async t => {
  const f = await fixture(t, { signedIn: true, health: 503 });
  const result = await f.run(['chat', 'fixture message']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Backend is not running/);
  assert.deepEqual(f.requests.map(r => r.path), ['/health']);
});

test('actual chat refuses an empty message with exit1', async t => {
  const f = await fixture(t, { signedIn: true });
  const result = await f.run(['chat', '   ']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /Please provide a message/);
  assert.deepEqual(f.requests.map(r => r.path), ['/health']);
});

for (const stream of [undefined, 'data: {"type":"reasoning","content":"hidden fixture reasoning"}\n\ndata: {"type":"text","content":"fixture answer"}\n\ndata: {"type":"done"}\n\n']) {
  test(`actual chat succeeds with exit0 for ${stream ? 'completed SSE' : 'JSON'}`, async t => {
    const f = await fixture(t, { signedIn: true, stream });
    const result = await f.run(['chat', 'fixture message']);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /fixture answer/);
    assert.ok(!result.output.includes('hidden fixture reasoning'));
    assert.ok(!result.output.includes(token));
    assert.deepEqual(f.requests.map(r => r.path), ['/health', '/api/chat']);
  });
}

test('actual chat exits1 on interrupted SSE without printing a partial answer', async t => {
  const f = await fixture(t, { signedIn: true, stream: 'data: {"type":"text","content":"partial-fixture-answer"}\n\n' });
  const result = await f.run(['chat', 'fixture message']);
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /interrupted/);
  assert.ok(!result.output.includes('partial-fixture-answer'));
  assert.deepEqual(f.requests.map(r => r.path), ['/health', '/api/chat']);
});
