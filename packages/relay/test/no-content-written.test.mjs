// MOB-RELAY-01 trust check: the relay never writes message content to disk or to its output.
// It runs the real entry point as a child process with its own empty working folder, HOME
// and temp folder, pushes marked envelopes (plain markers and real ciphertext) through every
// path (delivered, dropped, too large, refused), then checks the output and every file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createIdentity, startHandshake, answerHandshake, finishHandshake, seal } from '../src/e2e.ts';
import { b64url } from '../src/encoding.ts';
import { connect } from './helpers.mjs';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const SOURCES = ['relay.ts', 'websocket.ts', 'main.ts', 'encoding.ts'].map((f) => fileURLToPath(new URL(`../src/${f}`, import.meta.url)));

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

test('the relay source has no way to write files or log frames', () => {
  for (const file of SOURCES) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /from 'node:fs'|from 'fs'|require\(|writeFile|appendFile|createWriteStream|console\./, file);
  }
});

test('message content never reaches disk, stdout or stderr', async () => {
  const work = mkdtempSync(join(tmpdir(), 'relay-cwd-'));
  const home = mkdtempSync(join(tmpdir(), 'relay-home-'));
  const temp = mkdtempSync(join(tmpdir(), 'relay-tmp-'));
  const child = spawn(process.execPath, ['--import', TSX, MAIN], {
    cwd: work,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: temp, TMP: temp, TEMP: temp, GIRRU_RELAY_PORT: '0', GIRRU_RELAY_MAX_ENVELOPE_BYTES: '65536' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`relay did not start: ${stderr}`)), 15000);
      child.stderr.on('data', () => {
        const m = /listening on 127\.0\.0\.1:(\d+)/.exec(stderr);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
    });
    const url = `ws://127.0.0.1:${port}/v1`;
    const computer = createIdentity(), phone = createIdentity();
    const a = await connect(url, { identity: computer, allow: [phone.id] });
    const b = await connect(url, { identity: phone, allow: [computer.id] });

    const marker = `PLAINTEXTMARKER${randomBytes(8).toString('hex')}`;
    const { env: hs1, pending } = startHandshake(phone, computer.id);
    b.send(computer.id, hs1);
    const answered = answerHandshake(computer, phone.publicKey, (await a.next((f) => f.t === 'msg')).env);
    a.send(phone.id, answered.env);
    const session = finishHandshake(pending, computer.publicKey, (await b.next((f) => f.t === 'msg')).env);
    const sealed = seal(session, `${marker} the owner's private message`);
    const cipherMarker = sealed.split('.')[3].slice(0, 40);

    b.send(computer.id, sealed);
    await a.next((f) => f.t === 'msg' && f.env === sealed);
    b.send(computer.id, `g1.msg.${marker}.delivered`);
    await a.next((f) => f.t === 'msg');
    b.send(b64url(randomBytes(32)), `g1.msg.${marker}.dropped`, 'gone');
    await b.next((f) => f.t === 'drop');
    b.send(computer.id, `g1.msg.${marker}.${'x'.repeat(70000)}`);
    await b.closed;
    a.sendFrame(`{"t":"send","to":"${marker}","env":"${marker}"}`);
    await a.next((f) => f.t === 'error');
    a.sendFrame(`not json ${marker}`);
    await a.next((f) => f.t === 'error');
    await a.close();

    child.kill('SIGTERM');
    await exited;

    for (const output of [stdout, stderr]) {
      assert.ok(!output.includes(marker), 'plaintext marker in relay output');
      assert.ok(!output.includes(cipherMarker), 'ciphertext in relay output');
      assert.ok(!output.includes(computer.id) && !output.includes(phone.id), 'device ids in relay output');
    }
    assert.equal(stdout, '');
    assert.deepEqual(stderr.trim().split('\n').map((l) => l.replace(/:\d+$/, ':PORT')), ['girru-relay: listening on 127.0.0.1:PORT', 'girru-relay: stopped']);
    assert.deepEqual(readdirSync(work), [], 'the relay created files in its working folder');
    assert.deepEqual(readdirSync(home), [], 'the relay created files in HOME');
    // The temp folder may hold the TypeScript loader's compile cache; none of it may hold content.
    for (const file of filesUnder(temp)) {
      const bytes = readFileSync(file).toString('latin1');
      assert.ok(!bytes.includes(marker) && !bytes.includes(cipherMarker), `content found in ${file}`);
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    for (const dir of [work, home, temp]) rmSync(dir, { recursive: true, force: true });
  }
});
