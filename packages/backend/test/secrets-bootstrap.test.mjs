// INST-02: the backend generates its own secrets into a private file.
// Temp data dirs only; no network, no port, no real .env.
// Run: node --import tsx --test test/secrets-bootstrap.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const {
  bootstrapSecrets, REQUIRED_SECRETS, SECRETS_FILE_NAME, SecretsBootstrapError, isPlaceholderSecret, parseSecretsFile,
} = await import(join(backendDir, 'src/config/secrets-bootstrap.ts'));

const root = mkdtempSync(join(tmpdir(), 'ap-secrets-'));
test.after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const freshDir = () => join(root, `case-${++n}`, '.data');
const capture = () => {
  const lines = [];
  return { lines, log: (m) => lines.push(String(m)) };
};
const mode = (p) => statSync(p).mode & 0o777;
const NAMES = ['JWT_SECRET', 'ENCRYPTION_KEY', 'MASTER_ENCRYPTION_KEY', 'WORKFLOW_SECRET'];

test('empty env: 4 secrets of the right length in a 0600 file inside a 0700 dir; nothing secret printed', () => {
  const dataDir = freshDir();
  const env = {};
  const out = capture();
  const origLog = console.log; const origWarn = console.warn; const origErr = console.error;
  const printed = [];
  console.log = console.warn = console.error = (...a) => printed.push(a.join(' '));
  let report;
  try {
    report = bootstrapSecrets({ dataDir, env, log: out.log });
  } finally {
    console.log = origLog; console.warn = origWarn; console.error = origErr;
  }
  assert.deepEqual(REQUIRED_SECRETS.map((s) => s.name), NAMES);
  assert.deepEqual(report.generated, NAMES);
  assert.equal(env.JWT_SECRET.length, 128);
  assert.match(env.ENCRYPTION_KEY, /^[0-9a-f]{64}$/);
  assert.equal(env.MASTER_ENCRYPTION_KEY.length, 64);
  assert.equal(env.WORKFLOW_SECRET.length, 64);
  assert.equal(new Set(NAMES.map((k) => env[k])).size, 4, 'values differ');

  const file = join(dataDir, SECRETS_FILE_NAME);
  assert.equal(report.file, file);
  if (process.platform !== 'win32') {
    assert.equal(mode(file), 0o600);
    assert.equal(mode(dataDir), 0o700);
  }
  const parsed = parseSecretsFile(readFileSync(file, 'utf-8'));
  for (const k of NAMES) assert.equal(parsed.get(k), env[k]);

  const all = [...out.lines, ...printed, JSON.stringify(report)].join('\n');
  for (const k of NAMES) assert.ok(!all.includes(env[k]), `${k} value printed`);
  assert.ok(out.lines.some((l) => l.includes('JWT_SECRET')), 'names are reported');
});

test('re-run keeps the values and does not rewrite the file', () => {
  const dataDir = freshDir();
  const first = {};
  bootstrapSecrets({ dataDir, env: first, log: () => {} });
  const file = join(dataDir, SECRETS_FILE_NAME);
  const before = readFileSync(file, 'utf-8');
  const second = {};
  const report = bootstrapSecrets({ dataDir, env: second, log: () => {} });
  assert.deepEqual(report.generated, []);
  for (const k of NAMES) {
    assert.equal(second[k], first[k]);
    assert.equal(report.sources[k], 'file');
  }
  assert.equal(readFileSync(file, 'utf-8'), before);
});

test('env (.env) values win and are never copied into the file; existing file values are kept', () => {
  const dataDir = freshDir();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, SECRETS_FILE_NAME);
  const fileJwt = randomBytes(40).toString('hex');
  writeFileSync(file, `# mine\nJWT_SECRET=${fileJwt}\nOTHER_VALUE=keep\n`, { mode: 0o600 });
  const envKey = randomBytes(32).toString('hex');
  const env = { ENCRYPTION_KEY: envKey };
  const report = bootstrapSecrets({ dataDir, env, log: () => {} });
  assert.equal(env.ENCRYPTION_KEY, envKey);
  assert.equal(report.sources.ENCRYPTION_KEY, 'env');
  assert.equal(env.JWT_SECRET, fileJwt);
  assert.equal(report.sources.JWT_SECRET, 'file');
  assert.deepEqual(report.generated, ['MASTER_ENCRYPTION_KEY', 'WORKFLOW_SECRET']);
  const text = readFileSync(file, 'utf-8');
  assert.ok(!text.includes(envKey), 'env value copied to the file');
  assert.ok(text.startsWith(`# mine\nJWT_SECRET=${fileJwt}\nOTHER_VALUE=keep\n`), 'existing lines changed');
  assert.ok(!/^ENCRYPTION_KEY=/m.test(text));
});

test('placeholder values stop the boot with a clear error that names the variable, not the value', () => {
  for (const placeholder of ['change-me', 'your-secret-here', 'development-secret-change-in-production',
    'your-secret-key-here-CHANGE-THIS-IMMEDIATELY', 'super-secret-key-change-me']) {
    const dataDir = freshDir();
    const env = { JWT_SECRET: placeholder };
    assert.throws(() => bootstrapSecrets({ dataDir, env, log: () => {} }), (err) => {
      assert.ok(err instanceof SecretsBootstrapError);
      assert.match(err.message, /JWT_SECRET/);
      assert.match(err.message, /placeholder/);
      assert.ok(!err.message.includes(placeholder));
      return true;
    });
    assert.equal(existsSync(join(dataDir, SECRETS_FILE_NAME)), false, 'nothing written on refusal');
  }
  // a placeholder inside the secrets file is refused too
  const dataDir = freshDir();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, SECRETS_FILE_NAME), 'WORKFLOW_SECRET="super-secret-key-change-me"\n', { mode: 0o600 });
  assert.throws(() => bootstrapSecrets({ dataDir, env: {}, log: () => {} }), /WORKFLOW_SECRET .*placeholder/);
  assert.equal(isPlaceholderSecret(randomBytes(32).toString('hex')), false);
});

test('a malformed ENCRYPTION_KEY is refused (format named, value not shown)', () => {
  const bad = 'not-hex-' + randomBytes(8).toString('hex');
  assert.throws(() => bootstrapSecrets({ dataDir: freshDir(), env: { ENCRYPTION_KEY: bad }, log: () => {} }), (err) => {
    assert.match(err.message, /ENCRYPTION_KEY .*64 hex/);
    assert.ok(!err.message.includes(bad));
    return true;
  });
});

test('a secrets file readable by others is set back to 0600', { skip: process.platform === 'win32' }, () => {
  const dataDir = freshDir();
  bootstrapSecrets({ dataDir, env: {}, log: () => {} });
  const file = join(dataDir, SECRETS_FILE_NAME);
  chmodSync(file, 0o644);
  const out = capture();
  bootstrapSecrets({ dataDir, env: {}, log: out.log });
  assert.equal(mode(file), 0o600);
  assert.ok(out.lines.some((l) => l.includes('0600')));
});

// ENC-01: the native ownership plan (three encryption start-up modules that import no store, settings or
// database) comes first; then settings and secrets load, before any application store or the server opens.
const ENC_STARTUP_IMPORTS = [
  "import {receiveNativeStartupPlan} from '../memory/encryption/native-startup-handshake.js';",
  "import {reserveNativeStartupExclusions} from '../memory/encryption/native-startup-exclusion.js';",
  "import {bindNativeProcessStartup} from '../memory/encryption/native-process-startup.js';",
];

test('server entry loads env + secrets before any application import', () => {
  const src = readFileSync(join(backendDir, 'src/api/server.ts'), 'utf-8').replace(/^\s*\/\/.*$/gm, '');
  const env = src.indexOf("await import('../config/load-env.js');");
  assert.ok(env > 0, 'settings are loaded');
  for (const m of src.matchAll(/await import\('([^']+)'\)/g)) if (m[1] !== '../config/load-env.js') assert.ok(m.index > env, `${m[1]} loads after the settings`);
});

test('server entry: only the encryption start-up modules are static imports; the server loads after the settings (a pending restore is in place before any store opens)', () => {
  const src = readFileSync(join(backendDir, 'src/api/server.ts'), 'utf-8').replace(/^\s*\/\/.*$/gm, '');
  assert.deepEqual(src.match(/^import\s[^\n]*$/gm), ENC_STARTUP_IMPORTS);
  assert.match(src, /^await import\('\.\/server-main\.js'\);$/m);
  // Those start-up modules reach no store, settings or database when imported.
  for (const name of ['native-startup-handshake', 'native-startup-exclusion', 'native-process-startup']) {
    const mod = readFileSync(join(backendDir, `src/memory/encryption/${name}.ts`), 'utf-8');
    for (const line of mod.match(/^import\s[^\n]*$/gm) ?? []) assert.doesNotMatch(line, /config\/|repositories\/|\/db\/|database/, `${name}: ${line}`);
  }
});
