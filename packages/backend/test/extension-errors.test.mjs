// F-08: extension 5xx responses never echo internal error text (generic
// message + error id, original logged server-side); the trading SSE stream
// never sends `Access-Control-Allow-Origin: *`.
// Run: node --import tsx --test test/extension-errors.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const backendDir = process.cwd();
const { createExtensionErrorSanitizer, GENERIC_EXTENSION_ERROR } = await import(join(backendDir, 'src/plugins/extension-error-sanitizer.ts'));
const { default: Fastify } = await import('fastify');

const SECRET = 'db password is hunter2 at /srv/secret/path';
const app = Fastify();
await app.register(async (scope) => {
  scope.addHook('onSend', createExtensionErrorSanitizer('demo'));
  scope.get('/sent-500', async (_req, reply) => reply.code(500).send({ error: SECRET }));
  scope.get('/thrown', async () => { throw new Error(SECRET); });
  scope.get('/bad-request', async (_req, reply) => reply.code(400).send({ error: 'domain_id is required' }));
  scope.get('/ok', async () => ({ success: true, value: 1 }));
  scope.get('/text-503', async (_req, reply) => reply.code(503).type('text/plain').send('maintenance'));
}, { prefix: '/api/ext/demo' });
await app.ready();
test.after(() => app.close());

const logged = [];
const realError = console.error;
console.error = (...args) => { logged.push(args.join(' ')); };
test.after(() => { console.error = realError; });

test('5xx JSON bodies are replaced by a generic message and an error id; the original is logged', async () => {
  for (const url of ['/api/ext/demo/sent-500', '/api/ext/demo/thrown']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 500);
    assert.ok(!res.body.includes('hunter2'), res.body);
    const body = res.json();
    assert.equal(body.error, GENERIC_EXTENSION_ERROR);
    assert.match(body.errorId, /^[0-9a-f-]{36}$/);
    assert.ok(logged.some((l) => l.includes(body.errorId) && l.includes('hunter2')), 'original logged with the id');
  }
});

test('4xx, 2xx and non-JSON bodies pass through unchanged', async () => {
  const bad = await app.inject({ method: 'GET', url: '/api/ext/demo/bad-request' });
  assert.equal(bad.statusCode, 400);
  assert.deepEqual(bad.json(), { error: 'domain_id is required' });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/ext/demo/ok' })).json(), { success: true, value: 1 });
  const text = await app.inject({ method: 'GET', url: '/api/ext/demo/text-503' });
  assert.equal(text.statusCode, 503);
  assert.equal(text.body, 'maintenance');
});

test('the extension runner adds the sanitizer to every extension route scope', () => {
  const runner = readFileSync(join(backendDir, 'src/plugins/extension-runner.ts'), 'utf-8');
  assert.match(runner, /scope\.addHook\('onSend', createExtensionErrorSanitizer\(id\)\)/);
});

test('trading /stream never sends a wildcard CORS origin', () => {
  const routes = readFileSync(join(backendDir, 'test/fixtures/legacy-apps/extensions/trading/src/routes.js'), 'utf-8');
  assert.ok(!/Access-Control-Allow-Origin['"]\s*,\s*['"]\*/.test(routes));
  assert.match(routes, /streamAllowedOrigins\(\)\.includes\(requestOrigin\)/);
});
