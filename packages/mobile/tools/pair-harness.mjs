// A real computer and a real relay for pairing a phone app's own code, on 127.0.0.1 only.
//
// Starts the relay behind TLS (a throwaway certificate for localhost: the apps accept
// wss:// only), runs the backend's phone link on a throwaway database, opens a pairing
// QR code, then runs the phone command with the QR text as its last argument. The phone
// command prints `id=<device id>` and `code=<6 digits>` once it holds the challenge, and
// `paired` once it checked the welcome (on stdout, or as lines in the file GIRRU_PAIR_OUT).
// The harness compares the code with the one the computer shows, chooses Allow, and checks
// the computer lists the phone.
//
// Run from packages/backend (exit code 0 = paired end to end):
//   node --import tsx ../mobile/tools/pair-harness.mjs <phone command> [args…]
// The phone command gets `GIRRU_TEST_CA=<certificate path>` to trust the test relay and
// `GIRRU_PAIR_OUT=<file>` for commands whose stdout is not passed through (Gradle tests).
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer as createTlsServer } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';

// A path to the phone command is kept from where the harness started; it changes folder below.
const phoneCommand = process.argv.slice(2).map((a, i) => (i === 0 && a.includes('/') ? resolve(a) : a));
if (phoneCommand.length === 0) {
  process.stderr.write('usage: node --import tsx ../mobile/tools/pair-harness.mjs <phone command> [args…]\n');
  process.exit(2);
}

// The backend dials the relay with Node's own WebSocket, which trusts extra roots only
// from NODE_EXTRA_CA_CERTS at start: make the certificate, then run again with it.
if (!process.env.GIRRU_TEST_CA) {
  const certDir = mkdtempSync(join(tmpdir(), 'girru-pair-ca-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost', '-addext', 'extendedKeyUsage=serverAuth',
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { stdio: 'ignore' });
  const child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, GIRRU_TEST_CA: join(certDir, 'cert.pem'), GIRRU_TEST_KEY: join(certDir, 'key.pem'), NODE_EXTRA_CA_CERTS: join(certDir, 'cert.pem') },
  });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  await main();
}

async function main() {
  const backendDir = process.cwd();
  const relayDir = join(backendDir, '..', 'relay');
  const dir = mkdtempSync(join(tmpdir(), 'girru-pair-harness-'));
  mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.NODE_ENV = 'test';
  process.env.AGENT_PLAYER_BACKGROUND = 'off';
  const log = (line) => process.stderr.write(`computer: ${line}\n`);
  const quiet = () => {};
  console.log = quiet; console.info = quiet; console.warn = quiet;

  const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
  const db = getDatabase();
  await db.initialize();
  const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
  await getCredentialStorage().initialize();
  db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('ph-owner', 'ph-owner@example.test', 'ph-owner', 'x', 'owner', 'active', 1)`).run();
  const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
  const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
  const { phoneLink } = await import(join(backendDir, 'src/phone/service.ts'));
  const { createRelay } = await import(pathToFileURL(join(relayDir, 'src/relay.ts')).href);

  // TLS in front of the relay, as in production; the relay itself listens on 127.0.0.1 only.
  const tls = createTlsServer({ key: readFileSync(process.env.GIRRU_TEST_KEY), cert: readFileSync(process.env.GIRRU_TEST_CA) });
  await new Promise((r) => tls.listen(0, '127.0.0.1', r));
  const relayUrl = `wss://localhost:${tls.address().port}/v1`;
  const relay = createRelay({ port: 0, relayUrl });
  const { port } = await relay.listen();
  tls.on('secureConnection', (s) => { const up = netConnect(port, '127.0.0.1'); s.pipe(up).pipe(s); s.on('error', () => up.destroy()); up.on('error', () => s.destroy()); });

  const app = await buildServer({ logger: false });
  await app.ready();
  const call = (method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken('ph-owner', 1)}` }, ...(payload !== undefined ? { payload } : {}) });
  assert.equal((await call('PUT', '/api/phone/settings', { relayUrl })).statusCode, 200);
  await phoneLink().start();

  let phone;
  const done = async (code, message) => {
    log(message);
    phone?.kill();
    await phoneLink().stop().catch(() => undefined);
    await relay.close().catch(() => undefined);
    tls.close();
    await app.close().catch(() => undefined);
    process.exit(code);
  };
  const timer = setTimeout(() => done(1, 'FAIL: timed out'), 120_000);

  const until = async (fn, what, ms = 20_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  try {
    const p = (await call('POST', '/api/phone/pairing', { path: 'anywhere' })).json();
    await until(() => relay.stats().pairings >= 1, 'pairing id open on the relay');
    log(`relay ${relayUrl}, QR open`);

    const outFile = join(dir, 'phone-out.txt');
    phone = spawn(phoneCommand[0], [...phoneCommand.slice(1), p.qr], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, GIRRU_PAIR_OUT: outFile } });
    const said = { id: null, code: null, paired: false, exit: null };
    const heard = (line) => {
      process.stderr.write(`phone: ${line}\n`);
      if (line.startsWith('id=')) said.id = line.slice(3);
      else if (line.startsWith('code=')) said.code = line.slice(5);
      else if (line === 'paired') said.paired = true;
    };
    createInterface({ input: phone.stdout }).on('line', heard);
    let fileLines = 0;
    const readOut = () => {
      if (!existsSync(outFile)) return;
      const lines = readFileSync(outFile, 'utf8').split('\n').filter(Boolean);
      for (const line of lines.slice(fileLines)) heard(line);
      fileLines = lines.length;
    };
    const poll = setInterval(readOut, 50);
    // Read the last lines before the exit is seen.
    phone.on('exit', () => { clearInterval(poll); readOut(); });
    phone.on('exit', (c) => { said.exit = c ?? 1; });
    phone.on('error', (e) => { log(`phone command: ${e.message}`); said.exit = 1; });

    const view = await until(async () => { const v = (await call('GET', `/api/phone/pairing/${p.id}`)).json(); return v.state === 'request' && v; }, 'pairing request');
    await until(() => said.code || said.exit !== null, 'phone check code');
    assert.ok(said.code, 'the phone showed a check code');
    assert.equal(said.code, view.request.checkCode, 'both screens show the same check code');
    log(`check code ${said.code} matches; Allow`);
    assert.equal((await call('POST', `/api/phone/pairing/${p.id}/allow`, { lifetimeDays: 30, path: 'anywhere' })).statusCode, 200);

    await until(() => said.paired || said.exit !== null, 'phone welcome');
    assert.ok(said.paired, 'the phone checked the welcome');
    const listed = (await call('GET', '/api/phone')).json().devices ?? [];
    assert.ok(listed.some((d) => d.id === said.id), `the computer lists the phone ${said.id}`);
    await until(() => said.exit !== null, 'phone exit', 10_000);
    assert.equal(said.exit, 0, 'the phone command succeeded');
    clearTimeout(timer);
    await done(0, 'PASS: paired end to end');
  } catch (err) {
    clearTimeout(timer);
    await done(1, `FAIL: ${err.message}`);
  }
}
