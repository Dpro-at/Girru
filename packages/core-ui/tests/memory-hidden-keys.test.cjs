// MEM-READ-01 MR2: hidden keys show as lock chips; the Needs you row tells the owner once.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { KeyText, hiddenSummary, kindsLine, HiddenKeysController, HiddenKeysQuestion } = require('../src/memory-hidden-keys.tsx');

const TEXT = 'SSH login: ssh root@203.0.113.7 password: [SECRET:password:k3j9x0a1bq] and STRIPE=[SECRET:stripe_key:aa11bb22cc] old [REDACTED:password]';

test('lock chips replace references; nothing of the key shows', () => {
  const html = renderToStaticMarkup(React.createElement(KeyText, { text: TEXT, reveal: async () => 'x' }));
  assert.doesNotMatch(html, /SECRET:|REDACTED:|k3j9x0a1bq/);
  assert.equal((html.match(/dk-key-chip/g) ?? []).length, 3);
  assert.match(html, /Hidden: password/); assert.match(html, /Hidden: key/);
  assert.equal((html.match(/>Show</g) ?? []).length, 2, 'Show only for keys Girru kept, not for removed ones');
  assert.equal(hiddenSummary(TEXT), '3 keys hidden');
  assert.equal(hiddenSummary('login [SECRET:url_credentials:abcdef12]'), '1 login hidden');
  assert.equal(hiddenSummary('plain'), null);
  assert.equal(kindsLine({ login: 1, key: 2 }), '1 login, 2 keys');
});

function backend() {
  const calls = [];
  let drawers = [{ drawer: 'project:grenzer', count: 4, memories: 3, kinds: { login: 1, key: 3 } }];
  const routes = {
    'GET /api/memory/scopes/hidden-keys': () => ({ total: 4, drawers, keyIds: ['must-not-pass'] }),
    'POST /api/memory/scopes/hidden-keys/answer': (b) => { drawers = []; return { answered: 4, moved: b.answer === 'move' ? 4 : 0 }; },
    'POST /api/memory/scopes/hidden-keys/aa11bb22cc/reveal': () => ({ value: 'sk_test_value', extra: 'dropped' }),
  };
  return { calls, client: { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path} passes the browser allow-list`);
    const fn = routes[`${r.method} ${r.path}`]; if (!fn) return { status: 404, body: null };
    const once = x => memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, 200, x) : x;
    return { status: 200, body: once(once(fn(r.body))) };
  } } };
}

test('Needs you row: count, place and kinds; Move to Connections answers once', async () => {
  const { client, calls } = backend();
  const c = new HiddenKeysController(client);
  await c.load();
  assert.equal(c.getSnapshot().drawers[0].count, 4);
  assert.equal(c.getSnapshot().drawers[0].keyIds, undefined);
  const html = renderToStaticMarkup(React.createElement(HiddenKeysQuestion, { c }));
  for (const words of ['4 keys and logins were hidden in grenzer', 'Found in 3 memories: 1 login, 3 keys', 'Keep hidden here', 'Move to Connections…']) assert.ok(html.includes(words), words);
  assert.equal(await c.answer('project:grenzer', 'move'), true);
  assert.deepEqual(calls.at(-1).body, { answer: 'move', drawer: 'project:grenzer' });
  assert.equal(c.getSnapshot().drawers.length, 0);
  assert.match(c.getSnapshot().done, /Moved 4 to Connections/);
  assert.equal(await c.reveal('aa11bb22cc'), 'sk_test_value');
  assert.equal(allowedRequest('POST', '/api/memory/scopes/hidden-keys/answer', { answer: 'forget' }), false);
  assert.equal(allowedRequest('POST', '/api/memory/scopes/hidden-keys/../../x/reveal', undefined), false);
});
