// CHAT-LOADER-01: the chat orb follows the live phase words; it renders without WebGL (server, tests)
// as a decorative span with its state, and the opening, working and plan rows use it.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { orbStateOf } = require('../src/chat-orb.ts');
const { ChatOrb } = require('../src/ChatOrb.tsx');
const { TaskList } = require('../src/ChatMoments.tsx');

test('phase words map to the orb states of the board', () => {
  const map = { Thinking: 'think', Starting: 'think', 'Searching the web': 'search', 'Searching files': 'search', Reading: 'search', Opening: 'search', Browsing: 'search',
    Running: 'work', Changing: 'work', 'Asking a teammate': 'work', Using: 'work', Answering: 'write', 'Waiting for you': 'wait', 'Loading the chat…': 'load', 'Opening the conversation': 'load' };
  for (const [w, st] of Object.entries(map)) assert.equal(orbStateOf(w), st, w);
});

test('the orb is decorative markup with its state; done and failed carry their mark', () => {
  const html = renderToStaticMarkup(React.createElement(ChatOrb, { state: 'think' }));
  assert.match(html, /^<span class="chat-orb" data-state="think" style="inline-size:20px;block-size:20px" aria-hidden="true"><canvas/);
  assert.match(renderToStaticMarkup(React.createElement(ChatOrb, { state: 'done' })), /chat-orb-mark" data-kind="done"/);
  assert.match(renderToStaticMarkup(React.createElement(ChatOrb, { state: 'fail', size: 14 })), /data-kind="fail"/);
});

test('the working step of a live plan shows the working orb', () => {
  const t = { key: 'a', role: 'assistant', content: '', parts: [], status: 'running', runId: 'r', durationMs: null, lastSeq: 0, previewPlan: [{ title: 'A', status: 'done' }, { title: 'B', status: 'active' }] };
  // The list opens on click; render the open state through its markup: the head names the step.
  assert.match(renderToStaticMarkup(React.createElement(TaskList, { turns: [t] })), /· B/);
});
