// MEM-PANEL-01 (board v3): Memory › Memory helper, its RAM limit in Settings, Stop, and the project Files line.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedRequest } = require('../src/session.ts');
const { allowedMemoryHelper, memoryHelperResponse } = require('../src/memory-helper-contract.js');
const { memoryPagesRoute, memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { MemoryHelperController, stepWord } = require('../src/MemoryHelper.tsx');
const { NightWorkController } = require('../src/MemoryNightWork.tsx');
const { NightBar, RamLine, ReadLastNightLine, gb, lastNightSentence } = require('../src/MemoryHelperPlace.tsx');
const { readWhen } = require('../src/MemoryProjectWork.tsx');

const GIB = 1024 ** 3, MB = 1024 ** 2;
const status = { enabled: true, phase: 'ready', reason: null, error: null, model: 'qwen3-embedding:0.6b', completedBytes: 0, sizeBytes: 640 * MB, percent: 100, attempts: 0, nextTryAt: null, readyAt: '2026-10-17T12:02:00.000Z', remaining: 0, runtime: { installed: true, running: true }, worker: null };
const ram = { totalBytes: 32 * GIB, availableBytes: 18 * GIB, modelsBytes: 1 * GIB, loaded: [{ model: 'qwen3-embedding:0.6b', bytes: 1 * GIB }], limitBytes: 8 * GIB, mode: 'auto', customGb: null, lowFreeBytes: 2 * GIB };

test('contract: the settings call passes only with a reviewed body; night stop has no body', () => {
  assert.equal(allowedMemoryHelper('PUT', '/api/memory/helper/settings', { ram: { mode: 'auto' } }), true);
  assert.equal(allowedMemoryHelper('PUT', '/api/memory/helper/settings', { ram: { mode: 'custom', customGb: 12 } }), true);
  assert.equal(allowedMemoryHelper('PUT', '/api/memory/helper/settings', { worker: 'qwen3:4b' }), true);
  assert.equal(allowedMemoryHelper('PUT', '/api/memory/helper/settings', { worker: null }), true);
  for (const bad of [undefined, {}, { ram: { mode: 'custom' } }, { ram: { mode: 'auto', customGb: 4 } }, { ram: { mode: 'huge' } }, { worker: '../x' }, { worker: 'a', other: 1 }, { ram: { mode: 'custom', customGb: 1.5 } }]) {
    assert.equal(allowedMemoryHelper('PUT', '/api/memory/helper/settings', bad), false, JSON.stringify(bad));
  }
  assert.equal(allowedMemoryHelper('POST', '/api/memory/helper/settings', { ram: { mode: 'auto' } }), false);
  assert.equal(allowedRequest('PUT', '/api/memory/helper/settings', { ram: { mode: 'light' } }), true, 'the page client allows it');
  assert.equal(allowedRequest('POST', '/api/memory/scopes/night/stop', undefined), true);
  assert.equal(allowedRequest('POST', '/api/memory/scopes/night/stop', { now: true }), false);
});

test('contract: RAM, settings and candidates come through; anything else is dropped', () => {
  const out = memoryHelperResponse('/api/memory/helper', 200, { status, row: { state: 'ok' }, ram: { ...ram, path: '/x', loaded: [{ model: 'qwen3:4b', bytes: 3, path: '/y' }, { model: '../bad', bytes: 1 }] },
    settings: { ram: { mode: 'custom', customGb: 12 }, worker: 'qwen3:4b', extra: 1 }, candidates: [{ model: 'qwen3:4b', ramBytes: 3, fits: true, chosen: true, path: '/z' }, { model: '/etc/x y' }] });
  assert.deepEqual(out.ram.loaded, [{ model: 'qwen3:4b', bytes: 3 }]);
  assert.equal('path' in out.ram, false);
  assert.deepEqual(out.settings, { ram: { mode: 'custom', customGb: 12 }, worker: 'qwen3:4b' });
  assert.deepEqual(out.candidates, [{ model: 'qwen3:4b', ramBytes: 3, fits: true, chosen: true }]);
  assert.deepEqual(memoryHelperResponse('/api/memory/helper/settings', 409, { code: 'worker_too_big', error: 'long text /x' }), { code: 'worker_too_big' });
  const night = memoryPagesResponse('/api/memory/scopes/night', 200, { settings: { enabled: true, from: '01:00', to: '06:00' }, running: true, step: 'read',
    last: { night: '2026-11-27', startedAt: '2026-11-27T00:05:00.000Z', endedAt: '2026-11-27T02:40:00.000Z', stopped: 'low_ram', files: 5, projects: 2, proposals: 1, summaries: ['Girru'], keys: 0, duplicates: 0, byProject: { girru: { files: 3, summary: true, text: 'x' }, '../x': { files: 1 } } } });
  assert.equal(night.running, true); assert.equal(night.step, 'read');
  assert.equal(night.last.stopped, 'low_ram');
  assert.deepEqual(night.last.byProject, { girru: { files: 3, summary: true } });
  assert.ok(memoryPagesRoute('/api/memory/scopes/night/stop'));
  assert.deepEqual(memoryPagesResponse('/api/memory/scopes/night/stop', 200, { stopped: true, x: 1 }), { stopped: true });
  const docs = memoryPagesResponse('/api/memory/scopes/projects/girru/documents', 200, { key: [], other: [{ path: 'a.md', updatedAt: '2026-11-27T10:00:00.000Z', status: 'ok', reason: null, pages: null, bytes: 3, readAt: '2026-11-28T02:10:00.000Z' }] });
  assert.equal(docs.other[0].readAt, '2026-11-28T02:10:00', 'kept as UTC without the zone, like every page time');
});

test('one word per step: "Downloading" only while a download runs', () => {
  assert.equal(stepWord(status, false).word, 'Ready');
  for (const phase of ['waiting', 'checking', 'starting_runtime', 'verifying']) assert.equal(stepWord({ ...status, phase }, false).word, 'Checking', phase);
  assert.equal(stepWord({ ...status, phase: 'downloading', percent: 61 }, false).word, 'Downloading 61%');
  assert.equal(stepWord({ ...status, phase: 'reembedding' }, false).word, 'Updating memories');
  assert.equal(stepWord({ ...status, phase: 'fallback', reason: 'download_failed' }, true).word, 'Needs you');
});

test('the RAM line names RAM; the night bar shows the hours; the sentence says what last night did', () => {
  assert.equal(gb(8 * GIB), '8 GB'); assert.equal(gb(3.5 * GIB), '3.5 GB'); assert.equal(gb(1 * GIB), '1 GB');
  const line = renderToStaticMarkup(React.createElement(RamLine, { ram }));
  assert.match(line, /Uses <b>1 GB of RAM<\/b> · this computer has 32 GB RAM · RAM limit <b>8 GB<\/b> \(Automatic\)/);
  const bar = renderToStaticMarkup(React.createElement(NightBar, { settings: { enabled: true, from: '22:00', to: '06:00' }, last: null, now: new Date(2026, 10, 28, 15, 0) }));
  assert.equal((bar.match(/helper-night-band/g) ?? []).length, 2, 'a window over midnight is two bands');
  assert.match(bar, /Learns every night from 22:00 to 06:00/);
  assert.equal(lastNightSentence(null), 'It has not learned yet. Tonight it starts on its own.');
  assert.equal(lastNightSentence({ files: 12, summaries: ['a', 'b'], stopped: 'done' }), 'Last night it read 12 files, wrote 2 summaries.');
  assert.match(lastNightSentence({ files: 0, summaries: [], stopped: 'low_ram' }), /too little free RAM/);
});

function client(calls, reply = {}) {
  return { request: async r => {
    calls.push(r);
    assert.ok(allowedRequest(r.method, r.path, r.body), `${r.method} ${r.path}`);
    if (r.path === '/api/memory/helper/settings') return reply.settings ?? { status: 200, body: memoryHelperResponse(r.path, 200, { settings: { ram: r.body.ram ?? { mode: 'auto' }, worker: r.body.worker ?? null }, ram, candidates: [] }) };
    if (r.path === '/api/memory/helper') return { status: 200, body: memoryHelperResponse(r.path, 200, { status, row: { state: 'ok' }, ram, settings: { ram: { mode: 'auto' }, worker: null }, candidates: [{ model: 'qwen3:4b', ramBytes: 3.5 * GIB, fits: true, chosen: false }] }) };
    const body = { '/api/memory/scopes/night': { settings: { enabled: true, from: '01:00', to: '06:00' }, last: null, running: false, step: null }, '/api/memory/scopes/night/stop': { stopped: false }, '/api/memory/scopes/night/run': { started: true } }[r.path];
    return { status: 200, body: memoryPagesResponse(r.path, 200, body) };
  } };
}

test('the controller saves the RAM limit and the night writer, and says why a change was refused', async () => {
  const calls = [];
  const c = new MemoryHelperController(client(calls));
  await c.load();
  assert.equal(c.getSnapshot().ram.limitBytes, 8 * GIB);
  assert.equal(c.getSnapshot().candidates[0].model, 'qwen3:4b');
  assert.equal(await c.saveSettings({ ram: { mode: 'light' } }), null);
  assert.equal(c.getSnapshot().settings.ram.mode, 'light');
  const refused = new MemoryHelperController(client([], { settings: { status: 409, body: { code: 'worker_too_big' } } }));
  assert.equal(await refused.saveSettings({ worker: 'big:70b' }), 'This model does not fit in the RAM limit.');
  c.dispose(); refused.dispose();
  const n = new NightWorkController(client(calls));
  await n.stop();
  assert.ok(calls.some(r => r.method === 'POST' && r.path === '/api/memory/scopes/night/stop'));
  assert.equal(n.getSnapshot().notice, 'Nothing is running.');
  n.dispose();
});

test('the project Files line: only when last night read something for this project; files say when they were read', async () => {
  const n = new NightWorkController({ request: async r => ({ status: 200, body: memoryPagesResponse(r.path, 200, { settings: { enabled: true, from: '01:00', to: '06:00' }, running: false, step: null,
    last: { night: '2026-11-27', startedAt: '2026-11-27T00:05:00.000Z', endedAt: '2026-11-27T02:40:00.000Z', stopped: 'done', files: 5, projects: 2, proposals: 0, summaries: ['Girru'], keys: 0, duplicates: 0, byProject: { girru: { files: 5, summary: true } } } }) }) });
  await n.load();
  const html = renderToStaticMarkup(React.createElement(ReadLastNightLine, { night: n, slug: 'girru', onOpenHelper: () => {} }));
  assert.match(html, /Read last night: <b>5 files<\/b> · <b>1 summary<\/b>/);
  assert.match(html, /Memory helper/);
  assert.equal(renderToStaticMarkup(React.createElement(ReadLastNightLine, { night: n, slug: 'flowxtra' })), '', 'nothing read: no line');
  n.dispose();
  const now = new Date(2026, 10, 28, 10, 0);
  assert.equal(readWhen(new Date(2026, 10, 28, 2, 10).toISOString(), now), 'read last night');
  assert.equal(readWhen(new Date(2026, 10, 28, 9, 0).toISOString(), now), 'read today');
  assert.equal(readWhen(new Date(2026, 10, 25, 2, 0).toISOString(), now), 'read 3 days ago');
  assert.equal(readWhen(null, now), null);
  const utc = new Date(2026, 10, 28, 2, 10).toISOString().slice(0, 19);
  assert.equal(readWhen(utc, now), 'read last night', 'a page time without the zone is UTC');
});
