// CHAT-LIVE-01: a running reply shows its steps, its phase words and its plan
// (with sub-steps) from the live preview; the agent's question shows buttons
// and a click sends the answer; one plan per task.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { RunEventParser } = require('../src/conversation-contract.js');
const { applyEvent, liveTurn, livePhase, liveCalls, turnChoice, turnSessions, planOf, withoutPlan } = require('../src/turns.ts');
const { TaskList, ChoiceCard, SessionsCard, StartedByLine, MomentsContext } = require('../src/ChatMoments.tsx');

const frame = (o) => new TextEncoder().encode(`data: ${JSON.stringify(o)}\n\n`);

test('the preview carries steps and a plan; bad shapes are dropped; the end clears them', () => {
  const p = new RunEventParser(0);
  const [e] = p.push(frame({ type: 'preview', content: '', steps: [{ name: 'read', input: '{"path":"docs/HANDOFF.md","tail":40}', done: true, failed: false }, { name: 'web_fetch', input: '{"url":"https://nodejs.org/en"}', done: false, failed: false }, { bad: 1 }],
    plan: [{ title: 'Read', status: 'done' }, { title: 'Part', status: 'active', parent: 1 }, { title: '', status: 'done' }, { title: 'Odd', status: 'weird', parent: 'x' }] }));
  assert.equal(e.steps.length, 2);
  assert.deepEqual(e.plan, [{ title: 'Read', status: 'done' }, { title: 'Part', status: 'active', parent: 1 }, { title: 'Odd', status: 'pending' }]);
  let t = applyEvent(liveTurn('run-1234567890', 0), e, 0);
  assert.deepEqual(livePhase(t), { verb: 'Opening', target: 'nodejs.org/en' });
  assert.deepEqual(liveCalls(t.previewSteps).map(c => [c.name, c.running]), [['read', false], ['web_fetch', true]]);
  assert.equal(planOf(t).length, 3);
  t = applyEvent(t, { seq: 1, type: 'end', status: 'complete', ms: 5 }, 0);
  assert.equal(t.previewSteps, undefined); assert.equal(t.previewPlan, undefined);
});

test('phase words: thinking, answering, reading, waiting for you', () => {
  assert.deepEqual(livePhase({}), { verb: 'Thinking', target: '' });
  assert.deepEqual(livePhase({ preview: 'Hello' }), { verb: 'Answering', target: '' });
  assert.equal(livePhase({ previewSteps: [{ name: 'read', input: '{"path":"a/notes.md"}', done: false, failed: false }] }).verb, 'Reading');
  assert.equal(livePhase({ previewSteps: [{ name: 'ask_choice', input: '{}', done: false, failed: false }] }).verb, 'Waiting for you');
});

test('the plan panel shows sub-steps live and goes away for the next task', () => {
  const running = { key: 'a', role: 'assistant', content: '', parts: [], status: 'running', runId: 'r', durationMs: null, lastSeq: 0,
    previewPlan: [{ title: 'Write names', status: 'done' }, { title: 'Pick one', status: 'active' }, { title: 'Check free', status: 'active', parent: 2 }] };
  const html = renderToStaticMarkup(React.createElement(TaskList, { turns: [running] }));
  assert.match(html, /1 of 2 done/, 'sub-steps do not count as main steps');
  assert.match(html, /· Check free/, 'the working sub-step shows');
  const plan = { id: 'p', name: 'plan_steps', input: JSON.stringify({ steps: [{ title: 'A', status: 'done' }] }), running: false, output: 'ok' };
  const done = { key: 'b', role: 'assistant', content: 'x', parts: [{ kind: 'tools', step: 1, calls: [plan] }], status: 'complete', runId: null, durationMs: 1, lastSeq: 0 };
  const next = { key: 'c', role: 'assistant', content: 'Node is 26', parts: [{ kind: 'text', text: 'Node is 26' }], status: 'complete', runId: null, durationMs: 1, lastSeq: 0 };
  assert.equal(renderToStaticMarkup(React.createElement(TaskList, { turns: [done] })), '', 'a finished plan leaves the box (the reply keeps its line)');
  const left = { ...done, parts: [{ kind: 'tools', step: 1, calls: [{ ...plan, input: JSON.stringify({ steps: [{ title: 'A', status: 'done' }, { title: 'B', status: 'pending' }] }) }] }] };
  assert.match(renderToStaticMarkup(React.createElement(TaskList, { turns: [left] })), /1 of 2 done/, 'a plan with steps left stays');
  assert.equal(renderToStaticMarkup(React.createElement(TaskList, { turns: [done, next] })), '', 'a finished plan does not stay for an unrelated reply');
});

test('a choice shows buttons (suggested first) and a click sends the answer', () => {
  const call = { id: 'q', name: 'ask_choice', input: JSON.stringify({ question: 'Lunch?', options: ['Pizza', 'Sushi', 'Salad'], suggested: 2 }), running: false, output: 'asked' };
  const parts = [{ kind: 'tools', step: 1, calls: [call] }, { kind: 'text', text: 'Waiting for your choice.' }];
  const choice = turnChoice(parts);
  assert.deepEqual(choice, { question: 'Lunch?', options: ['Pizza', 'Sushi', 'Salad'], multiple: false, suggested: 2 });
  assert.deepEqual(withoutPlan(parts).map(p => p.kind), ['text'], 'the question is not listed as tool work');
  assert.equal(turnChoice([{ kind: 'tools', step: 1, calls: [{ ...call, isError: true }] }]), null);
  const sent = [];
  const html = renderToStaticMarkup(React.createElement(MomentsContext.Provider, { value: { onAnswer: t => sent.push(t) } }, React.createElement(ChoiceCard, { choice, open: true })));
  assert.match(html, /Needs your choice/);
  assert.match(html, /<button[^>]*data-suggested="true"[^>]*><span dir="auto">Sushi<\/span><small>· suggested<\/small>.*Pizza.*Salad/s);
  assert.match(html, /Or say it your way/);
  const closed = renderToStaticMarkup(React.createElement(ChoiceCard, { choice, open: false }));
  assert.doesNotMatch(closed, /<button/, 'an older question is one quiet line');
});

test('started sessions show with their live state and Open; a sub-session says where it reports', () => {
  const id = '3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b', id2 = '4f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';
  const start = (sid, title, extra = {}) => ({ id: sid.slice(0, 4), name: 'session_start', input: JSON.stringify({ agent_id: 'milo', task: 'Write 5 slogans', title }), running: false, output: `Started the session "${title}" with Milo (id ${sid}). It works on its own; check it with session_list.`, ...extra });
  const parts = [{ kind: 'tools', step: 1, calls: [start(id, 'Slogan'), start(id2, 'Logo'), start('5f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b', 'Bad', { isError: true })] }];
  const sessions = turnSessions(parts);
  assert.deepEqual(sessions.map(x => x.title), ['Slogan', 'Logo'], 'a refused start shows nothing');
  assert.deepEqual(withoutPlan(parts), [], 'starts are shown as the card, not as tool work');
  const opened = [];
  const ctx = { onOpenChat: x => opened.push(x), agentName: () => 'Milo', chatState: x => (x === id ? { running: true, waiting: 0 } : { running: false, waiting: 1 }) };
  const html = renderToStaticMarkup(React.createElement(MomentsContext.Provider, { value: ctx }, React.createElement(SessionsCard, { sessions })));
  assert.match(html, /Started 2 sessions · 1 working · 1 needs you/);
  assert.match(html, /data-state="working".*Slogan.*Milo · Working.*Open/s);
  assert.match(html, /data-state="needs".*Logo.*Needs you/s);
  assert.match(renderToStaticMarkup(React.createElement(MomentsContext.Provider, { value: ctx }, React.createElement(StartedByLine, { parentId: id, parentTitle: 'Coffee shop launch' }))), /Started from <button[^>]*>Coffee shop launch<\/button> · reports back there/);
});

test('LW6: search hits read as plain text; a saved failed reply keeps its reason', () => {
  const { plainSnippet } = require('../src/ChatSearch.tsx');
  assert.equal(plainSnippet('2. **Write:** I replaced `Name: TBD` with [the file](x.md)'), '2. Write: I replaced Name: TBD with the file');
  assert.equal(plainSnippet('## Plan\n> quote'), 'Plan\nquote');
  const { conversationResponse: res } = require('../src/conversation-contract.js');
  const CID = '3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b';
  const m = res(`/api/chat/conversations/${CID}/messages`, 200, { conversation: { id: CID, title: 't', agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '' }, activeRunId: null,
    messages: [{ id: 'm-1', role: 'assistant', content: '', status: 'error', runId: null, durationMs: 1, createdAt: '', code: 'model_unavailable', parts: [] }, { id: 'm-2', role: 'assistant', content: '', status: 'error', runId: null, durationMs: 1, createdAt: '', code: 'made_up', parts: [] }] }).messages;
  assert.equal(m[0].code, 'model_unavailable'); assert.equal(m[1].code, undefined);
});
