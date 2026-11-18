// MEM-READ-01 MR9: Night work in Settings and the morning report in Needs you.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { NightWorkController, NightReportRow, NightWorkSettings, lastNightLine } = require('../src/MemoryNightWork.tsx');

const report = { night: '2026-11-12', startedAt: '2026-11-12T00:04:00.000Z', endedAt: '2026-11-12T01:37:00.000Z', stopped: 'done', files: 214, projects: 4, proposals: 9, summaries: ['grenzer', 'Flowxtra'], keys: 1, duplicates: 3 };
function client(calls = []) {
  const routes = {
    'GET /api/memory/scopes/night': () => ({ settings: { enabled: true, from: '01:00', to: '06:00' }, last: report }),
    'PUT /api/memory/scopes/night': (b) => ({ settings: { enabled: true, from: b.from ?? '01:00', to: '06:00' } }),
    'GET /api/memory/scopes/night/report': () => ({ report }),
    'POST /api/memory/scopes/night/report/done': () => ({ ok: true }),
    'POST /api/memory/scopes/night/run': () => ({ started: true }),
  };
  return { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`);
    const once = x => memoryPagesRoute(r.path) ? memoryPagesResponse(r.path, 200, x) : x;
    return { status: 200, body: once(once(routes[`${r.method} ${r.path}`](r.body))) };
  } };
}

test('settings, hours and Run now go through the allow-list; bad hours are refused before sending', async () => {
  const calls = [];
  const c = new NightWorkController(client(calls));
  await c.load();
  assert.deepEqual(c.getSnapshot().settings, { enabled: true, from: '01:00', to: '06:00' });
  assert.match(lastNightLine(c.getSnapshot().last), /^Last night: .+ · 214 files read · stopped when done$/);
  assert.equal(await c.save({ from: '02:00' }), true);
  await c.runNow();
  assert.ok(calls.some(r => r.path === '/api/memory/scopes/night/run'));
  assert.equal(allowedRequest('PUT', '/api/memory/scopes/night', { from: '25:00' }), false);
  assert.equal(allowedRequest('PUT', '/api/memory/scopes/night', { every: 15 }), false);
  const html = renderToStaticMarkup(React.createElement(NightWorkSettings, { c }));
  for (const w of ['Work on memory at night', 'While the computer is idle and charging', 'Read new and changed files', 'Learn from the day', 'Write the summaries', 'Tidy:', 'Run now']) assert.ok(html.includes(w), w);
});

test('the morning report is one row; Done takes it away', async () => {
  const c = new NightWorkController(client());
  await c.loadReport();
  const html = renderToStaticMarkup(React.createElement(NightReportRow, { c }));
  for (const w of ['This morning', 'Read 214 new files in 4 projects', '9 new facts wait for you', 'Found 3 duplicates', 'Hid 1 key', 'Review the 9 facts']) assert.ok(html.includes(w), w);
  assert.match(html, /Wrote today(&#x27;|')s summary for grenzer and Flowxtra/);
  await c.done();
  assert.equal(renderToStaticMarkup(React.createElement(NightReportRow, { c })), '');
});
