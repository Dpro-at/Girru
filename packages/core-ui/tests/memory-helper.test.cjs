require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowedMemoryHelper, memoryHelperResponse, helperStatus } = require('../src/memory-helper-contract.js');
const { HelperDetails, MemoryHelperController, pillWords, rowWords, timeLeft, nextTry, chosenBasic } = require('../src/MemoryHelper.tsx');
const { SetupSteps } = require('../src/FirstRunSetup.tsx');

const MB = 1024 * 1024;
const base = { enabled: true, phase: 'downloading', reason: null, error: null, model: 'qwen3-embedding:0.6b', completedBytes: 269 * MB, sizeBytes: 640 * MB, percent: 42, attempts: 0, nextTryAt: null, readyAt: null, remaining: 0, runtime: { installed: true, running: true }, worker: null };
const st = (s, extra = {}) => ({ phase: 'ready', status: { ...base, ...s }, needsYou: false, rate: null, busy: false, ...extra });

test('MODELS-01-INSTALL contract: only the two reviewed calls pass, with no body', () => {
  assert.equal(allowedMemoryHelper('GET', '/api/memory/helper', undefined), true);
  assert.equal(allowedMemoryHelper('POST', '/api/memory/helper/retry', undefined), true);
  assert.equal(allowedMemoryHelper('POST', '/api/memory/helper/retry', { force: true }), false);
  assert.equal(allowedMemoryHelper('POST', '/api/memory/helper', undefined), false);
  assert.equal(allowedMemoryHelper('GET', '/api/memory/helper/other', undefined), false);
  assert.equal(allowedRequest('GET', '/api/memory/helper', undefined), true, 'the page client allows it');
  assert.equal(allowedRequest('DELETE', '/api/memory/helper', undefined), false);
});

test('MODELS-01-INSTALL contract: unknown fields, paths and error text never reach the page', () => {
  const out = memoryHelperResponse('/api/memory/helper', 200, {
    status: { ...base, error: 'ENOENT /Users/x/.ollama', path: '/Users/x', runtime: { installed: true, running: true, startedByGirru: true, bin: '/x' }, worker: { model: 'qwen3:0.6b', phase: 'ready', secret: 1 } },
    row: { state: 'needs_you', word: 'x', detail: { path: '/x' } } });
  assert.deepEqual(out.row, { state: 'needs_you' });
  assert.equal(out.status.error, null, 'free error text is dropped');
  assert.equal('path' in out.status, false);
  assert.deepEqual(out.status.runtime, { installed: true, running: true });
  assert.deepEqual(out.status.worker, { model: 'qwen3:0.6b', phase: 'ready' });
  assert.deepEqual(memoryHelperResponse('/api/memory/helper', 404, { code: 'not_found' }), { code: 'not_found' });
  assert.deepEqual(memoryHelperResponse('/api/memory/helper/retry', 200, { started: true, x: 1 }), { started: true });
  assert.equal(helperStatus({ phase: 'evil' }).phase, 'waiting');
});

test('M1–M3: the pill says the same plain words everywhere, no technical names', () => {
  assert.equal(pillWords(base), 'Memory helper · 42% of 640 MB');
  assert.equal(pillWords({ ...base, phase: 'ready' }), 'Memory helper ready');
  assert.equal(pillWords({ ...base, phase: 'fallback', reason: 'download_failed' }), 'Memory helper · basic recall for now');
  assert.equal(pillWords({ ...base, phase: 'checking' }), 'Memory helper · getting ready');
  for (const phase of ['waiting', 'checking', 'downloading', 'reembedding', 'ready', 'fallback'])
    assert.doesNotMatch(pillWords({ ...base, phase }), /embedding|hash|ollama|qwen/i);
  assert.equal(chosenBasic({ ...base, phase: 'fallback', reason: 'hash_chosen' }), true, 'a chosen basic recall shows no pill');
  assert.equal(chosenBasic({ ...base, phase: 'fallback', reason: 'download_failed' }), false);
});

test('M1: the popover explains, shows progress, and after a failure offers Try now calmly', () => {
  const html = renderToStaticMarkup(React.createElement(HelperDetails, { st: st({}, { rate: 2 * MB }), onRetry() {} }));
  assert.match(html, /640 MB, once/);
  assert.match(html, /269 of 640 MB · about 3 minutes/);
  assert.doesNotMatch(html, /Try now/);
  const failed = renderToStaticMarkup(React.createElement(HelperDetails, { st: st({ phase: 'fallback', reason: 'download_failed', error: 'network', attempts: 1, nextTryAt: new Date(Date.now() + 5 * 60000).toISOString() }), onRetry() {} }));
  assert.match(failed, /Download paused/);
  assert.match(failed, /No connection right now\. Girru tries again by itself in 5 minutes/);
  assert.match(failed, /basic recall/);
  assert.match(failed, /Try now/);
  assert.doesNotMatch(failed, /embedding|hash|ollama/i);
});

test('M6: the Health row has a word for every state; needs you only when the backend says so', () => {
  assert.deepEqual(rowWords({ ...base, phase: 'checking' }, false).word, 'Getting ready');
  assert.equal(rowWords(base, false).word, 'Downloading 42%');
  assert.equal(rowWords({ ...base, phase: 'reembedding' }, false).word, 'Updating memories');
  assert.equal(rowWords({ ...base, phase: 'ready' }, false).word, 'Ready');
  const once = rowWords({ ...base, phase: 'fallback', reason: 'download_failed', attempts: 1 }, false);
  assert.equal(once.word, 'Basic recall for now'); assert.equal(once.tone, 'attention');
  const three = rowWords({ ...base, phase: 'fallback', reason: 'download_failed', attempts: 3 }, true);
  assert.equal(three.word, 'Needs you'); assert.match(three.line, /tried 3 times/);
  assert.equal(rowWords({ ...base, phase: 'fallback', reason: 'hash_chosen' }, false).tone, 'ok');
});

test('time left and next try read as people say them', () => {
  assert.equal(timeLeft(base, null), null);
  assert.equal(timeLeft(base, 2 * MB), 'about 3 minutes');
  assert.equal(nextTry({ ...base, nextTryAt: new Date(Date.now() + 30_000).toISOString() }), 'in a minute');
  assert.equal(nextTry({ ...base, nextTryAt: null }), null);
});

test('the controller turns 404 into "off" (nothing shows) and reads progress', async () => {
  const off = new MemoryHelperController({ request: async () => ({ status: 404, body: { code: 'not_found' } }) });
  await off.load(); assert.equal(off.getSnapshot().phase, 'off'); off.dispose();
  const calls = [];
  const on = new MemoryHelperController({ request: async (r) => { calls.push(r); return r.method === 'POST' ? { status: 200, body: { started: true } } : { status: 200, body: { status: { ...base, phase: 'ready' }, row: { state: 'ok' } } }; } });
  await on.retry();
  assert.equal(on.getSnapshot().status.phase, 'ready');
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['POST /api/memory/helper/retry', 'GET /api/memory/helper']);
  on.dispose();
});

test('no setup step and no choice: the steps are unchanged', () => {
  const html = renderToStaticMarkup(React.createElement(SetupSteps, { current: 'Local model' }));
  assert.doesNotMatch(html, /Memory helper/);
});
