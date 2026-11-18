// H-ERR-01: one global Fastify error handler.
// - A thrown error without a 4xx status (or with a 5xx one) answers the fixed
//   body { error: 'Internal error', code: 'internal_error' }; the message never
//   reaches the client, and the log gets the method, the route pattern (not
//   the URL with its query string) and safe error fields only.
// - Nested (encapsulated) plugins are covered too.
// - Fastify schema-validation 400s, typed 4xx errors and rate-limit 429s are
//   byte-identical to Fastify's default reply (checked against an app without
//   the handler).
// - A sample route from each of the 11 route files (the 7 email files were removed) that used to echo
//   error.message in 5xx bodies, stubbed to throw a secret, answers the
//   generic 500 and logs no secret.
// Run: node --import tsx --test test/global-error-handler.test.mjs
// Throwaway DB + cwd + HOME, random test-only secrets, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-global-errors-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.MEMORY_EMBEDDINGS = 'hash';

const SECRET = 'INTERNAL-SECRET-sk-ant-api03-zyxwvutsrqponmlkjih /Users/someone/private.db';
const secretError = (name = 'SqliteError', code = 'SQLITE_ERROR') =>
  Object.assign(new Error(`broke: ${SECRET}`), { name, code, stderr: SECRET });

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${String(url)}`); };

const quiet = { log: console.log, warn: console.warn, info: console.info, error: console.error };
const logged = [];
const capture = (...a) => { logged.push(a.map((x) => (typeof x === 'string' ? x : (x instanceof Error ? `${x.message} ${x.stack}` : JSON.stringify(x) ?? String(x)))).join(' ')); };
const startCapture = () => { logged.length = 0; console.log = capture; console.warn = capture; console.info = capture; console.error = capture; };
const stopCapture = () => Object.assign(console, quiet);
startCapture();

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES ('ge-owner', 'ge-owner@example.test', 'ge-owner', 'x', 'owner', 'active')`).run();

const { registerGlobalErrorHandler, INTERNAL_ERROR_BODY } = await import(join(backendDir, 'src/api/error-handler.ts'));
const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { RATE_LIMIT_PLUGIN_OPTIONS, registerRateLimit } = await import(join(backendDir, 'src/api/rate-limit-config.ts'));
const { default: Fastify } = await import('fastify');
const { default: rateLimit } = await import('@fastify/rate-limit');

const auth = { authorization: `Bearer ${generateToken('ge-owner', 1)}` };

/** Routes used by the handler tests; registered the same way on both apps. */
async function demoRoutes(app) {
  app.get('/api/ge/boom/:id', async () => { throw secretError(); });
  app.get('/api/ge/boom-503', async () => { throw Object.assign(new Error(SECRET), { statusCode: 503 }); });
  app.get('/api/ge/boom-string', async () => { throw SECRET; }); // eslint-disable-line no-throw-literal
  app.post('/api/ge/validated', {
    schema: { body: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 2 } } } },
  }, async () => ({ ok: true }));
  app.get('/api/ge/typed-404', async () => { throw Object.assign(new Error('Proposal not found'), { statusCode: 404, code: 'not_found' }); });
  app.get('/api/ge/typed-409', async () => { throw Object.assign(new Error('Version conflict'), { status: 409 }); });
  app.post('/api/ge/limited', { config: { rateLimit: { ...registerRateLimit, max: 1 } } }, async () => ({ ok: true }));
  // Nested, encapsulated plugins (two levels, with prefixes).
  await app.register(async (child) => {
    await child.register(async (grand) => {
      grand.get('/deep/:x', async () => { throw secretError('TypeError', 'ERR_SOMETHING'); });
    }, { prefix: '/inner' });
  }, { prefix: '/api/ge/nested' });
}

async function makeApp(withHandler) {
  const app = Fastify();
  if (withHandler) registerGlobalErrorHandler(app);
  await app.register(rateLimit, { ...RATE_LIMIT_PLUGIN_OPTIONS });
  await demoRoutes(app);
  await app.ready();
  return app;
}
const app = await makeApp(true);
const plain = await makeApp(false);

// The real app: buildServer() wires the handler; a nested plugin added to it
// must inherit the handler too.
const real = await buildServer({ logger: false });
await real.register(async (child) => {
  await child.register(async (grand) => {
    grand.get('/deep', async () => { throw secretError(); });
  }, { prefix: '/inner' });
}, { prefix: '/api/ge-real' });
await real.ready();

// The sample app: one route plugin from each of the 11 files.
const sample = Fastify();
registerGlobalErrorHandler(sample);
registerAuthGate(sample);
const plugins = [
  ['evaluation', 'default'], ['agent-files', 'agentFilesRoutes'], ['setup', 'default'],
  ['claude-local', 'claudeLocalRoutes'], ['gateway', 'gatewayRoutes'],
  ['onboarding', 'onboardingRoutes'], ['world-builder', 'worldBuilderRoutes'], ['ai-tools', 'aiToolsRoutes'],
  ['memory-quality', 'default'], ['memory-sharing', 'default'], ['world-generator', 'worldGeneratorRoutes'],
];
for (const [file, exp] of plugins) {
  const mod = await import(join(backendDir, `src/api/routes/${file}.ts`));
  assert.equal(typeof mod[exp], 'function', `${file} exports ${exp}`);
  await sample.register(mod[exp]);
}
await sample.ready();
stopCapture();

test.after(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  await plain.close();
  await real.close();
  await sample.close();
  closeDatabase();
  process.chdir(backendDir);
  rmSync(dir, { recursive: true, force: true });
});

function assertGeneric(res, label, status = 500) {
  assert.equal(res.statusCode, status, `${label}: status (${res.body})`);
  assert.deepEqual(res.json(), { ...INTERNAL_ERROR_BODY }, `${label}: fixed body`);
  assert.deepEqual(res.json(), { error: 'Internal error', code: 'internal_error' });
  for (const s of ['INTERNAL-SECRET', 'sk-ant-api03', '/Users/someone', 'broke']) {
    assert.ok(!res.body.includes(s), `${label}: no "${s}" in the body`);
  }
}

function assertNoSecretLogged(label) {
  const all = logged.join('\n');
  for (const s of ['INTERNAL-SECRET', 'sk-ant-api03', '/Users/someone', 'broke:']) {
    assert.ok(!all.includes(s), `${label}: no "${s}" in the log`);
  }
}

async function inject(target, opts) {
  startCapture();
  try { return await target.inject(opts); } finally { stopCapture(); }
}

test('a thrown error with a secret message answers the generic 500; the log names the route pattern only', async () => {
  const res = await inject(app, { method: 'GET', url: '/api/ge/boom/42?token=QS-SECRET-VALUE' });
  assertGeneric(res, 'boom');
  assertNoSecretLogged('boom');
  const line = logged.find((l) => l.includes('internal error'));
  assert.ok(line, 'one internal-error log line');
  assert.match(line, /\[API\] GET \/api\/ge\/boom\/:id internal error/);
  assert.match(line, /"name":"SqliteError"/);
  assert.match(line, /"code":"SQLITE_ERROR"/);
  assert.ok(!logged.join('\n').includes('QS-SECRET-VALUE'), 'no query string in the log');
  assert.ok(!logged.join('\n').includes('/42'), 'no concrete URL in the log');
});

test('a 5xx-status error keeps its status with the generic body; a thrown string is a generic 500', async () => {
  assertGeneric(await inject(app, { method: 'GET', url: '/api/ge/boom-503' }), 'boom-503', 503);
  assertNoSecretLogged('boom-503');
  assertGeneric(await inject(app, { method: 'GET', url: '/api/ge/boom-string' }), 'boom-string');
  assertNoSecretLogged('boom-string');
});

test('a route in a nested encapsulated plugin gets the same generic 500', async () => {
  const res = await inject(app, { method: 'GET', url: '/api/ge/nested/inner/deep/7' });
  assertGeneric(res, 'nested');
  assertNoSecretLogged('nested');
  assert.ok(logged.some((l) => l.includes('[API] GET /api/ge/nested/inner/deep/:x internal error')), 'log names the nested route pattern');
});

test('buildServer() wires the handler for every plugin, nested ones included', async () => {
  const res = await inject(real, { method: 'GET', url: '/api/ge-real/inner/deep', headers: auth });
  assertGeneric(res, 'buildServer nested');
  assertNoSecretLogged('buildServer nested');
});

test('Fastify schema-validation 400s are byte-identical to the default reply', async () => {
  for (const payload of [{}, { name: 'x' }, { name: 5 }]) {
    const a = await inject(app, { method: 'POST', url: '/api/ge/validated', payload });
    const b = await plain.inject({ method: 'POST', url: '/api/ge/validated', payload });
    assert.equal(a.statusCode, 400);
    assert.equal(a.statusCode, b.statusCode);
    assert.equal(a.body, b.body, 'same body bytes');
    assert.equal(a.headers['content-type'], b.headers['content-type']);
    assert.equal(a.json().code, 'FST_ERR_VALIDATION');
  }
  // Malformed JSON (FST_ERR_CTP_*) stays a 400 too.
  const opts = { method: 'POST', url: '/api/ge/validated', payload: '{bad', headers: { 'content-type': 'application/json' } };
  const a = await inject(app, opts);
  const b = await plain.inject(opts);
  assert.equal(a.statusCode, 400);
  assert.equal(a.body, b.body);
});

test('typed 4xx errors keep their status and body', async () => {
  for (const url of ['/api/ge/typed-404', '/api/ge/typed-409']) {
    const a = await inject(app, { method: 'GET', url });
    const b = await plain.inject({ method: 'GET', url });
    assert.equal(a.statusCode, b.statusCode, url);
    assert.equal(a.body, b.body, `${url}: same body bytes`);
  }
  const nf = await inject(app, { method: 'GET', url: '/api/ge/typed-404' });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.json().code, 'not_found');
  assert.equal(nf.json().message, 'Proposal not found');
});

test('rate-limit 429 is unchanged', async () => {
  const send = (target) => target.inject({ method: 'POST', url: '/api/ge/limited', payload: { email: 'rl@example.test' } });
  assert.equal((await send(app)).statusCode, 200);
  assert.equal((await send(plain)).statusCode, 200);
  const a = await inject(app, { method: 'POST', url: '/api/ge/limited', payload: { email: 'rl@example.test' } });
  const b = await send(plain);
  assert.equal(a.statusCode, 429);
  assert.equal(b.statusCode, 429);
  assert.equal(a.body, b.body, 'same body bytes');
  assert.equal(a.json().code, 'rate_limited');
  assert.equal(a.json().error, 'Too many attempts');
  assert.equal(a.headers['retry-after'], b.headers['retry-after']);
  assert.ok(Number(a.headers['retry-after']) > 0);
});

// ── One route from each of the 11 files, stubbed to throw the secret ──────

/** Statements whose SQL matches `re` throw the secret error. */
function failSql(re) {
  const original = db.prepare;
  db.prepare = function (sql) {
    if (re.test(sql)) throw secretError();
    return original.call(this, sql);
  };
  return () => { db.prepare = original; };
}

/** Patch a property of a CJS object (builtin modules: synced to ESM too). */
function patch(obj, key, value, builtin = false) {
  const original = obj[key];
  obj[key] = value;
  if (builtin) syncBuiltinESMExports();
  return () => { obj[key] = original; if (builtin) syncBuiltinESMExports(); };
}

const NOT_USERS = /^(?![\s\S]*\bFROM (users|auth_sessions)\b)/; // the auth gate still reads the users and sessions tables
const fsp = require('node:fs/promises');
const cp = require('node:child_process');
const { repositories } = await import(join(backendDir, 'src/repositories/index.ts'));
const { OnboardingWizard } = await import(join(backendDir, 'src/onboarding/index.ts'));
const gw = await import(join(backendDir, 'src/gateway/index.ts'));

// Gateway: a test-only instance (no cleanup timer), whose getSession throws.
const restoreTimer = patch(gw.SessionManager.prototype, 'startCleanupInterval', () => {});
gw.getGateway({}, { storageDir: join(dir, '.data', 'gateway') });
restoreTimer();

// Claude Code session file for the import route (HOME is the temp dir).
mkdirSync(join(dir, '.claude', 'projects', 'proj'), { recursive: true });
writeFileSync(join(dir, '.claude', 'projects', 'proj', 'sess.jsonl'), `${JSON.stringify({ message: { role: 'user', content: 'hi' } })}\n`);

const sampleCases = [
  ['evaluation', 'GET', '/api/evaluation/overview', undefined, () => failSql(/agents_config/), '[Evaluation] GET /api/evaluation/overview'],
  ['agent-files', 'GET', '/api/agents/ge-agent/personality', undefined, () => {
    const r1 = patch(fsp, 'readFile', async () => { throw secretError('Error', 'EACCES'); }, true);
    const r2 = patch(fsp, 'mkdir', async () => { throw secretError('Error', 'EACCES'); }, true);
    return () => { r1(); r2(); };
  }, '[AgentFiles] GET /api/agents/:id/personality'],
  // Public setup route: every statement fails (owner check included, so setup is not locked).
  ['setup', 'POST', '/api/setup/database', {}, () => failSql(/[\s\S]/), '[Setup] POST /api/setup/database'],
  ['claude-local', 'POST', '/api/claude-local/import/proj/sess', {}, () => failSql(/chat_sessions|chat_messages/), '[ClaudeLocal] POST /api/claude-local/import/:slug/:id'],
  ['gateway', 'GET', '/api/gateway/sessions/ge-owner', undefined, () => patch(gw.UnifiedGateway.prototype, 'getSession', async () => { throw secretError(); }), '[Gateway] GET /api/gateway/sessions/:userId'],
  ['onboarding', 'POST', '/api/onboarding/start', {}, () => patch(OnboardingWizard.prototype, 'start', () => { throw secretError(); }), '[Onboarding] POST /api/onboarding/start'],
  ['world-builder', 'POST', '/api/world-builder', { name: 'W', objects: [] }, () => failSql(/storage_files|user_worlds/), '[WorldBuilder] POST /api/world-builder'],
  ['ai-tools', 'POST', '/api/ai-tools/claude-code/install', {}, () => patch(cp, 'execFile', (...args) => {
    const cb = args[args.length - 1];
    process.nextTick(() => cb(secretError('Error', 'ENOENT')));
  }, true), '[AiTools] POST /api/ai-tools/:id/install'],
  ['memory-quality', 'GET', '/api/memory-quality/stats', undefined, () => patch(repositories.memory, 'qualityStats', async () => { throw secretError(); }), '[MemoryQuality] GET /api/memory-quality/stats'],
  ['memory-sharing', 'GET', '/api/memory-sharing/shared', undefined, () => patch(repositories.memory, 'shared', async () => { throw secretError(); }), '[MemorySharing] GET /api/memory-sharing/shared'],
  ['world-generator', 'POST', '/api/world-generator/ai', { prompt: 'p', agent_id: 'a' }, () => failSql(/SELECT model FROM agents_config\b/), '[WorldGenerator] POST /api/world-generator/ai'],
];

test('the sample covers all 11 route files', () => {
  assert.equal(new Set(sampleCases.map((c) => c[0])).size, 11);
});

for (const [file, method, url, payload, stub, route] of sampleCases) {
  test(`${file} ${route}: an internal error returns the generic 500 only`, async () => {
    const restore = stub();
    let res;
    try {
      res = await inject(sample, { method, url, headers: auth, ...(payload !== undefined ? { payload } : {}) });
    } finally {
      restore();
    }
    assertGeneric(res, route);
    assertNoSecretLogged(route);
    assert.ok(logged.some((l) => l.includes(`${route} internal error`)), `the log names the route (${route}): ${logged.join(' | ')}`);
  });
}
