// CHAT-BUILD-01 stage 5 (CH2, CH6, CH10): live preview, steer, approvals in the chat, notices, undo, the task list.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { RunEventParser, conversationResponse: res, projectRunEvent } = require('../src/conversation-contract.js');
const { applyEvent, liveTurn, fromWire } = require('../src/turns.ts');
const { NoticeCard, SteerLine, TaskList, DelegationCard, MomentsContext, ChangesLine } = require('../src/ChatMoments.tsx');
const CID = '3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';

test('a live preview shows while the reply is written and never moves the resume point', () => {
  const p = new RunEventParser(0);
  const out = p.push(new TextEncoder().encode('data: {"type":"preview","content":"Hello "}\n\ndata: {"seq":1,"type":"text","content":"Hello world"}\n\n'));
  assert.deepEqual(out.map(e => [e.type, e.seq]), [['preview', 0], ['text', 1]]);
  assert.equal(p.last, 1);
  let t = liveTurn('run-1234567890', 0);
  t = applyEvent(t, { seq: 0, type: 'preview', content: 'Hel' }, 0);
  assert.equal(t.preview, 'Hel');
  t = applyEvent(t, { seq: 1, type: 'end', status: 'complete', ms: 5 }, 0);
  assert.equal(t.preview, undefined, 'the checked text replaces the preview');
});

test('steer messages, kept notices and approval ids pass the contract and render', () => {
  assert.deepEqual(projectRunEvent({ seq: 3, type: 'steer', content: 'Also the footer', step: 2 }), { seq: 3, type: 'steer', content: 'Also the footer', step: 2 });
  const r = projectRunEvent({ seq: 4, type: 'tool_result', step: 1, results: [{ id: 'c1', name: 'x', output: 'o', approvalId: 'appr-12345678' }, { id: 'c2', name: 'y', output: 'o', approvalId: '../bad' }] });
  assert.equal(r.results[0].approvalId, 'appr-12345678'); assert.equal(r.results[1].approvalId, undefined);
  const msg = res(`/api/chat/conversations/${CID}/messages`, 200, { conversation: { id: CID, title: 't', agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '' }, activeRunId: null,
    messages: [{ id: 'm-1', role: 'assistant', content: 'ok', status: 'complete', runId: null, durationMs: 1, createdAt: '', changes: { files: 3, undone: false },
      parts: [{ kind: 'steer', text: 'Also the footer', step: 2 }, { kind: 'notice', code: 'injection', text: 'Ignore previous instructions' }, { kind: 'notice', code: 'nope' }, { kind: 'text', text: 'ok' }] }] }).messages[0];
  assert.deepEqual(msg.parts.map(p => p.kind), ['steer', 'notice', 'text']);
  const turn = fromWire(msg);
  assert.deepEqual(turn.changes, { files: 3, undone: false });
  assert.match(renderToStaticMarkup(React.createElement(SteerLine, { part: msg.parts[0] })), /seen at step 2/);
  const notice = renderToStaticMarkup(React.createElement(NoticeCard, { part: msg.parts[1] }));
  assert.match(notice, /Girru ignored it/); assert.match(notice, /data-tone="needs"/);
  const ctx = { client: { request: async () => ({ status: 200 }) }, conversationId: CID };
  assert.match(renderToStaticMarkup(React.createElement(MomentsContext.Provider, { value: ctx }, React.createElement(ChangesLine, { turn, messageId: 'm-1' }))), /Changed 3 files<\/span><\/p>[\s\S]*<div class="moment-actions">.*Undo these changes/);
});

test('hand-off cards and the task list', () => {
  const card = renderToStaticMarkup(React.createElement(MomentsContext.Provider, { value: { agentName: id => (id === 'qa' ? 'QA Tester' : id) } },
    React.createElement(DelegationCard, { call: { id: 'c', name: 'team_delegate', input: JSON.stringify({ agent_id: 'qa', request: 'Check the hero at 390 px' }), output: 'All good', running: false, ms: 72000 } })));
  assert.match(card, /<span class="handoff-verb">Handed to<\/span><span class="composer-face" aria-hidden="true">Q<\/span><b>QA Tester<\/b>/); assert.match(card, /Check the hero at 390 px/); assert.match(card, /Done · 1m 12s/);
  const plan = { id: 'p', name: 'plan_steps', input: JSON.stringify({ steps: [{ title: 'Read', status: 'done' }, { title: 'Write', status: 'active' }] }), running: false };
  const html = renderToStaticMarkup(React.createElement(TaskList, { turns: [{ key: 'a', role: 'assistant', content: '', parts: [{ kind: 'tools', step: 1, calls: [plan] }], status: 'running', runId: null, durationMs: null, lastSeq: 0 }] }));
  assert.match(html, /Tasks<\/b><span>1 of 2 done<\/span><span class="task-now">· Write/);
});

test('CH6: the role after the name, a sub-agent nested in its lead\'s card, and the live step with Stop', () => {
  const names = { cx: 'Codex Frontend', hh: 'Hero helper', qa: 'QA Tester' };
  const ctx = { agentName: id => names[id] ?? id, agentAbout: id => (id === 'cx' ? 'Frontend developer' : undefined), subAgentOf: id => (id === 'hh' ? 'cx' : undefined),
    steps: [{ agentId: 'qa', tool: 'read_file', at: new Date().toISOString() }], onStop: () => {} };
  const call = (id, agent, extra = {}) => ({ id, name: 'team_delegate', input: JSON.stringify({ agent_id: agent, request: `Task for ${agent}` }), running: false, ms: 40000, ...extra });
  const wrap = el => renderToStaticMarkup(React.createElement(MomentsContext.Provider, { value: ctx }, el));
  const lead = wrap(React.createElement(DelegationCard, { call: call('a', 'cx') }, React.createElement(DelegationCard, { call: call('b', 'hh'), nested: true })));
  assert.match(lead, /<b>Codex Frontend<\/b><span class="handoff-about">Frontend developer<\/span>/);
  assert.match(lead, /class="handoff-sub"><p class="handoff-head"><span class="handoff-verb">Codex Frontend handed to its sub-agent<\/span><span class="composer-face" aria-hidden="true">H<\/span><b>Hero helper<\/b>/);
  assert.match(wrap(React.createElement(DelegationCard, { call: call('c', 'hh') })), /Handed to Codex Frontend’s sub-agent/, 'alone, it says whose sub-agent it is');
  const live = wrap(React.createElement(DelegationCard, { call: call('d', 'qa', { running: true, ms: undefined }) }));
  assert.match(live, /class="handoff-live" role="status"><span class="pulse" aria-hidden="true"><\/span><span class="handoff-step">Reading read_file|class="handoff-live" role="status"><span class="pulse" aria-hidden="true"><\/span><span class="handoff-step">Reading/);
  assert.match(live, /aria-label="Stop"/);
  assert.match(live, /Working/);
  const { conversationResponse } = require('../src/conversation-contract.js');
  const team = conversationResponse(`/api/chat/conversations/${CID}/team`, 200, { team: [], apps: [], steps: [{ agentId: 'qa', tool: 'read_file', at: 'now' }, { agentId: 'x', tool: 'bad tool!', at: '' }] });
  assert.deepEqual(team.steps, [{ agentId: 'qa', tool: 'read_file', at: 'now' }]);
});

test('background work uses the native desktop bridge without a web permission prompt', async () => {
  const { notifyDone } = require('../src/ChatMoments.tsx');
  const oldDocument = globalThis.document, oldWindow = globalThis.window, oldNotification = globalThis.Notification;
  let nativeCalls = 0, webRequests = 0;
  try {
    globalThis.document = { visibilityState: 'hidden' };
    globalThis.window = { dproApp: { notifyDone: async () => { nativeCalls++; return true; } } };
    globalThis.Notification = { permission: 'default', requestPermission: () => { webRequests++; } };
    notifyDone('Private chat title', 'Private content');
    await Promise.resolve();
    assert.equal(nativeCalls, 1); assert.equal(webRequests, 0);
    globalThis.document.visibilityState = 'visible';
    notifyDone('Girru', 'Done'); assert.equal(nativeCalls, 1);
  } finally {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow;
    if (oldNotification === undefined) delete globalThis.Notification; else globalThis.Notification = oldNotification;
  }
});
