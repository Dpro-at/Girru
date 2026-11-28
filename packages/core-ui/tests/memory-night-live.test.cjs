// MEM-LIVE-01 (board v4): the footer pill while night work runs, and what it is doing now.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { memoryPagesResponse } = require('../src/memory-pages-contract.js');
const { NightWorkController, nightPillWord } = require('../src/MemoryNightWork.tsx');
const { NightSteps, NightEventList, NightNowLine } = require('../src/MemoryHelperPlace.tsx');

const NOW = { step: 'read', file: 'docs/storage-map.md', project: 'girru', read: 12, startedAt: '2026-11-28T01:04:00.000Z' };
const EVENTS = [
  { at: '2026-11-28T01:09:00.000Z', kind: 'read', text: 'Read README.md', project: 'girru' },
  { at: '2026-11-28T01:08:00.000Z', kind: 'idea', text: '3 ideas wait for you in Needs you', project: null },
  { at: '2026-11-28T01:04:00.000Z', kind: 'start', text: 'Started (Run now)', project: null },
];

test('contract: now and events pass through clipped; unknown kinds and fields are dropped', () => {
  const out = memoryPagesResponse('/api/memory/scopes/night', 200, {
    settings: { enabled: true, from: '01:00', to: '06:00' }, last: null, running: true, step: 'read',
    now: { ...NOW, secret: 'x', read: -4 },
    events: [...EVENTS, { at: 'x', kind: 'shell', text: 'rm -rf', project: null }, { at: 'y', kind: 'read', text: 7 }, { ...EVENTS[0], extra: 'z', text: 'R'.repeat(900) }],
  });
  assert.deepEqual(Object.keys(out.now).sort(), ['file', 'project', 'read', 'startedAt', 'step']);
  assert.equal(out.now.read, 0, 'a bad count becomes 0');
  assert.equal(out.events.length, 4);
  assert.ok(out.events.every(e => ['read', 'idea', 'start'].includes(e.kind) && !('extra' in e)));
  assert.equal(out.events[3].text.length, 300);
  assert.equal(memoryPagesResponse('/api/memory/scopes/night', 200, { running: false, step: null, now: null }).now, null);
});

test('footer words: running by step, a minute after it ends, then nothing', () => {
  assert.equal(nightPillWord({ running: true, now: NOW, events: EVENTS, finishedAt: null }), 'Night work: reading, 12 files read');
  assert.equal(nightPillWord({ running: true, now: { ...NOW, step: 'summaries' }, events: [], finishedAt: null }), 'Night work: writing summaries');
  assert.equal(nightPillWord({ running: true, now: { ...NOW, step: 'tidy' }, events: [], finishedAt: null }), 'Night work: tidying');
  assert.equal(nightPillWord({ running: true, now: null, events: [], finishedAt: null }), 'Night work: starting');
  const done = [{ at: 'x', kind: 'done', text: 'Done: 40 files read, 2 summaries, 3 ideas', project: null }, ...EVENTS];
  assert.equal(nightPillWord({ running: false, now: null, events: done, finishedAt: 1_000 }, 30_000), 'Done: 40 files read, 2 summaries, 3 ideas');
  assert.equal(nightPillWord({ running: false, now: null, events: done, finishedAt: 1_000 }, 70_000), null, 'gone after a minute');
  assert.equal(nightPillWord({ running: false, now: null, events: done, finishedAt: null }), null, 'not on a fresh page');
});

test('controller: keeps now and events, marks the finish, and keeps watching while it rests', async () => {
  let running = true; const calls = [];
  const client = { request: async r => { calls.push(r.path); return { status: 200, body: memoryPagesResponse('/api/memory/scopes/night', 200, { settings: { enabled: true, from: '01:00', to: '06:00' }, last: null, running, step: running ? 'read' : null, now: running ? NOW : null, events: EVENTS }) }; } };
  const c = new NightWorkController(client);
  await c.load();
  assert.equal(c.getSnapshot().now.file, 'docs/storage-map.md');
  assert.equal(c.getSnapshot().events.length, 3);
  running = false; await c.load();
  assert.ok(typeof c.getSnapshot().finishedAt === 'number', 'the finish is marked');
  c.dispose();
});

test('the live view: steps, the file it is on, and the list with an idea that opens Needs you', () => {
  const steps = renderToStaticMarkup(React.createElement(NightSteps, { step: 'summaries', finished: false }));
  assert.match(steps, /data-state="done"[^]*Read files[^]*data-state="now"[^]*Write summaries[^]*data-state="next"[^]*Tidy/);
  const now = renderToStaticMarkup(React.createElement(NightNowLine, { now: NOW, projectName: s => s === 'girru' ? 'Girru' : s }));
  assert.ok(now.includes('Reading <b>docs/storage-map.md</b>') && now.includes('Girru') && now.includes('12 files read'));
  const list = renderToStaticMarkup(React.createElement(NightEventList, { events: EVENTS, projectName: s => s, onOpenNeeds: () => {}, label: 'What it is doing' }));
  assert.ok(list.indexOf('Read README.md') < list.indexOf('Started (Run now)'), 'newest first');
  assert.match(list, /<button[^>]*>3 ideas wait for you in Needs you<\/button>/);
});

test('after Stop the notice does not say Done', async () => {
  let running = true;
  const stoppedEv = [{ at: '2026-11-28T01:20:00.000Z', kind: 'stopped', text: 'Stopped when you asked. Run now goes on from here.', project: null }];
  const client = { request: async () => ({ status: 200, body: memoryPagesResponse('/api/memory/scopes/night', 200, { settings: { enabled: true, from: '01:00', to: '06:00' }, last: null, running, step: running ? 'read' : null, now: null, events: running ? [] : stoppedEv }) }) };
  const c = new NightWorkController(client);
  await c.load(); running = false; await c.load();
  assert.equal(c.getSnapshot().notice, null);
  c.dispose();
});

test('waiting for free RAM: the contract keeps it, the footer says it, the page explains it', async () => {
  const out = memoryPagesResponse('/api/memory/scopes/night', 200, { running: false, step: null, now: null, events: [], waiting: { reason: 'low_ram', since: '2026-11-28T01:00:00.000Z', extra: 1 } });
  assert.deepEqual(out.waiting, { reason: 'low_ram', since: '2026-11-28T01:00:00.000Z' });
  assert.equal(memoryPagesResponse('/api/memory/scopes/night', 200, { running: false, waiting: { reason: 'other', since: 'x' } }).waiting, null);
  assert.equal(nightPillWord({ running: false, now: null, events: [], finishedAt: null, waiting: { reason: 'low_ram', since: 'x' } }), 'Night work waits: little free RAM');
  assert.equal(nightPillWord({ running: true, now: NOW, events: [], finishedAt: null, waiting: { reason: 'low_ram', since: 'x' } }), 'Night work: reading, 12 files read', 'running wins');
  const client = { request: async () => ({ status: 200, body: out }) };
  const c = new NightWorkController(client); await c.load();
  assert.equal(c.getSnapshot().waiting.reason, 'low_ram');
  c.dispose();
});

test('ideas: the title comes from Needs you, the contract keeps only a safe id, a click opens that idea', () => {
  const out = memoryPagesResponse('/api/memory/scopes/night', 200, { events: [
    { at: 'a', kind: 'idea', text: 'Idea for you in Needs you', project: 'girru', ref: 'prop-1' },
    { at: 'b', kind: 'idea', text: 'Idea for you in Needs you', project: null, ref: '../etc' },
    { at: 'c', kind: 'read', text: 'Read a.md', project: null, ref: 'prop-2' },
  ] });
  assert.equal(out.events[0].ref, 'prop-1');
  assert.equal('ref' in out.events[1], false, 'an unsafe id is dropped');
  assert.equal('ref' in out.events[2], false, 'only ideas carry an id');
  const opened = [];
  const list = renderToStaticMarkup(React.createElement(NightEventList, { events: out.events, projectName: s => s, label: 'Last run',
    ideaTitle: id => (id === 'prop-1' ? 'Release notes are written in English' : undefined), onOpenIdea: id => opened.push(id), onOpenNeeds: () => {} }));
  assert.ok(list.includes('Idea: Release notes are written in English'));
  assert.ok(list.includes('>Idea for you in Needs you<'), 'no title yet: the plain words');
});
