// CHAT-BUILD-01 stage 3 (CH3, CH5): the composer controls, Mode/Thinking, waiting messages, project folders and variables.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const React = require('../node_modules/react');
const { renderToStaticMarkup } = require('../node_modules/react-dom/server');
const { allowedConversation: allow, conversationResponse: res } = require('../src/conversation-contract.js');
const { answersLabel, ModeButton, MODES, slashMatches, COMPOSER_KEYS } = require('../src/ChatComposerControls.tsx');
const { ConversationsController } = require('../src/conversations.ts');
const CID = '3f0c2b6e-1d2a-4f4e-9b1a-6c7d8e9f0a1b', PID = '9a8b7c6d-1d2a-4f4e-9b1a-6c7d8e9f0a1b';

test('the model button says Auto, each agent’s own, or provider · model · thinking', () => {
  const models = [{ id: 'subscription:claude', provider: 'subscription', label: 'Claude Code', size: '', think: true, variants: [{ id: 'sonnet', label: 'Sonnet' }] }, { id: 'qwen3:8b', provider: 'ollama', label: 'qwen3 8b', size: '', think: true }];
  assert.equal(answersLabel('auto', models, 'normal'), 'Auto');
  assert.equal(answersLabel('', models, 'normal'), 'Each agent’s own');
  assert.equal(answersLabel('subscription:claude/sonnet', models, 'deep'), 'Claude Code · Sonnet · Deep');
  assert.equal(answersLabel('qwen3:8b', models, 'quick'), 'qwen3 8b · Quick');
});

test('Mode: four choices, Accept edits shows amber; "/" lists the chat commands; keys are listed', () => {
  assert.deepEqual(MODES.map(m => m.id), ['auto', 'ask', 'accept_edits', 'plan']);
  const html = renderToStaticMarkup(React.createElement(ModeButton, { value: 'accept_edits', onChange() {}, open: false, setOpen() {} }));
  assert.match(html, /data-looser="true"/);
  assert.match(html, /aria-label="Mode: Accept edits"/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(ModeButton, { value: 'ask', onChange() {}, open: false, setOpen() {} })), /data-looser/);
  assert.deepEqual(slashMatches('/r').map(x => x.c), ['/remember']);
  assert.ok(COMPOSER_KEYS.some(([t, k]) => t === 'Who answers' && k === '⌘J'));
});

test('contract: mode, thinking and waiting messages; project folders; variables by name only', () => {
  const one = `/api/chat/conversations/${CID}`;
  assert.equal(allow('PUT', one, { mode: 'plan', thinking: 'deep' }), true);
  assert.equal(allow('PUT', one, { mode: 'yolo' }), false);
  assert.equal(allow('PUT', one, { queued: [{ key: 'q-12345678', text: 'next' }] }), true);
  assert.equal(allow('PUT', one, { queued: [{ key: 'q', text: 'next' }] }), false);
  const conv = res(one, 200, { conversation: { id: CID, title: 't', agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '', mode: 'ask', thinking: 'quick', queued: [{ key: 'q-12345678', text: 'next' }] } }).conversation;
  assert.deepEqual([conv.mode, conv.thinking, conv.queued.length], ['ask', 'quick', 1]);
  assert.equal(allow('POST', '/api/chat/projects', { name: 'Site', folder: '/x', folders: [{ path: '/y', write: true }] }), true);
  assert.equal(allow('POST', '/api/chat/projects', { name: 'Site', folder: '/x', folders: [{ path: '/y', write: 'yes' }] }), false);
  assert.equal(allow('GET', `/api/chat/projects/${PID}/variables`, undefined), true);
  assert.equal(allow('PUT', `/api/chat/projects/${PID}/variables/API_URL`, { value: 'x' }), true);
  assert.equal(allow('PUT', `/api/chat/projects/${PID}/variables/lower`, { value: 'x' }), false);
  assert.deepEqual(res(`/api/chat/projects/${PID}/variables`, 200, { variables: ['API_URL', 'bad name', { v: 1 }] }).variables, ['API_URL']);
});

test('waiting messages come back when the chat opens again (they wait for Send now)', async t => {
  const rows = new Map([[CID, { id: CID, title: 'T', agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '', queued: [{ key: 'q-12345678', text: 'Do the next part' }], mode: 'plan' }]]);
  const puts = [];
  const client = { getSnapshot: () => ({ phase: 'authenticated', epoch: 1, user: { role: 'owner' } }), subscribe: () => () => {}, request: async r => {
    if (/\/messages(\?|$)/.test(r.path)) return { status: 200, body: { conversation: { ...rows.get(CID) }, messages: [], activeRunId: null } };
    if (r.method === 'PUT') { puts.push(r.body); return { status: 200, body: { conversation: { ...rows.get(CID), ...r.body } } }; }
    if (r.path === '/api/chat/conversations') return { status: 200, body: { conversations: [{ ...rows.get(CID), queued: undefined }] } };
    return { status: 200, body: { projects: [], agents: [], sidebar: {} } };
  } };
  const c = new ConversationsController(client); t.after(() => c.dispose());
  await c.load(); await c.open(CID);
  const s = c.getSnapshot();
  assert.deepEqual(s.queue.map(q => q.text), ['Do the next part']);
  assert.equal(s.queuePaused, true);
  assert.equal(s.mode, 'plan');
  c.removeQueued('q-12345678');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(puts.at(-1), { queued: [] }, 'removing it is saved too');
  await c.setThinking('deep');
  assert.deepEqual(puts.at(-1), { thinking: 'deep' });
});


test('project sheet uses the native directory picker, preserves cancel and supports Windows and Unix paths',async()=>{
 const {chooseProjectDirectories}=require('../src/ChatComposerControls.tsx');const calls=[];
 const bridge={chooseProjectFolders:async options=>{calls.push(options);return ['/home/user/project','C:\\Users\\owner\\Project','/home/user/project','relative','bad\0path'];}};
 assert.deepEqual(await chooseProjectDirectories(false,bridge),['/home/user/project']);assert.deepEqual(calls[0],{multiple:false});
 assert.deepEqual(await chooseProjectDirectories(true,bridge),['/home/user/project','C:\\Users\\owner\\Project']);assert.deepEqual(calls[1],{multiple:true});
 assert.deepEqual(await chooseProjectDirectories(true,{chooseProjectFolders:async()=>[]}),[]);
 assert.equal(await chooseProjectDirectories(false,{}),null,'browser fallback only without the native bridge');
 await assert.rejects(chooseProjectDirectories(false,{chooseProjectFolders:async()=>{throw Error('closed');}}));
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/ChatComposerControls.tsx'),'utf8');
 assert.match(source,/void choose\('main'\)/);assert.match(source,/void choose\('add'\)/);
});


test('Code chat resizing preserves editor space and supports narrow windows',()=>{
 const {codeChatWidth}=require('../src/CodeChatResize.tsx');assert.equal(codeChatWidth(420,1280),420);assert.equal(codeChatWidth(1200,1280),960);assert.equal(codeChatWidth(100,1280),280);assert.equal(codeChatWidth(780,800),480);
 const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../src/ChatView.tsx'),'utf8');assert.match(source,/!embeddedCode && mode === 'live'.*<Meetings/);assert.match(source,/embeddedCode&&<CodeChatResize/);
});

test('two window controllers reuse the queued item identity and keep failed admission paused', async t => {
  const key = 'queued-fixture-1234', queued = [{ key, text: 'Do this once' }], calls = [];
  let fail = false;
  const conversation = { id: CID, title: 'Queued', agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '', queued };
  const client = {
    getSnapshot: () => ({ phase: 'authenticated', epoch: 1, user: { role: 'owner' } }), subscribe: () => () => {},
    request: async r => {
      if (r.method === 'POST' && r.path.endsWith('/runs')) { calls.push(r); return fail ? { status: 409, body: { code: 'queued_turn_changed' } } : { status: 202, body: { runId: r.body.runId } }; }
      if (/\/messages/.test(r.path)) return { status: 200, body: { conversation, messages: [], activeRunId: null } };
      if (r.method === 'PUT') return { status: 200, body: { conversation: { ...conversation, ...r.body } } };
      return { status: 200, body: { conversations: [conversation], projects: [], agents: [], sidebar: {} } };
    },
    runEvents: async (_id, _after, callback) => { callback({ seq: 1, type: 'end', status: 'complete', ms: 1 }); return { last: 1, ended: true }; },
  };
  const windows = [new ConversationsController(client), new ConversationsController(client)];
  t.after(() => windows.forEach(c => c.dispose()));
  for (const c of windows) { await c.load(); await c.open(CID); assert.equal(c.getSnapshot().queuePaused, true); }
  for (const c of windows) c.sendQueued(key);
  for (let i = 0; calls.length < 2 && i < 100; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(r => [r.body.runId, r.body.queuedKey]), [[key, key], [key, key]]);
  fail = true;
  await windows[0].open(CID);
  windows[0].sendQueued(key);
  for (let i = 0; (calls.length < 3 || windows[0].getSnapshot().starting) && i < 100; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(calls.length, 3);
  assert.equal(windows[0].getSnapshot().queuePaused, true);
  assert.deepEqual(windows[0].getSnapshot().queue, queued);
  assert.equal(windows[0].getSnapshot().draft, '');
  assert.match(windows[0].getSnapshot().notice, /changed or was removed/);
});

test('queued admission wire contract binds queuedKey to the exact stable run identity', () => {
  const path = `/api/chat/conversations/${CID}/runs`;
  assert.equal(allow('POST', path, { runId: 'queue-fixture-1', queuedKey: 'queue-fixture-1', message: 'Next' }), true);
  assert.equal(allow('POST', path, { runId: 'new-run-1234', queuedKey: 'queue-fixture-1', message: 'Next' }), false);
});

test('queue conflict projection keeps only the reviewed code through repeated projection', () => {
  const path = `/api/chat/conversations/${CID}/runs`;
  const projected = res(path, 409, { code: 'queued_turn_changed', error: 'private text', queued: ['private'] });
  assert.deepEqual(projected, { code: 'queued_turn_changed' });
  assert.deepEqual(res(path, 409, projected), projected);
});

test('queued admission waits for the backend canonical text instead of revaulting stale raw text', async t => {
  const calls = [], canonical = '[SECRET:password:fixture123]', active = 'active-fixture-run';
  let finish;
  const conversation = { id: CID, title: 'Queued', agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '' };
  const client = {
    getSnapshot: () => ({ phase: 'authenticated', epoch: 1, user: { role: 'owner' } }), subscribe: () => () => {},
    request: async r => {
      if (/\/messages/.test(r.path)) return { status: 200, body: { conversation, messages: [], activeRunId: active } };
      if (r.method === 'PUT' && r.body.queued) return { status: 200, body: { conversation: { ...conversation, queued: r.body.queued.map(item => ({ ...item, text: canonical })) } } };
      if (r.method === 'POST' && r.path.endsWith('/runs')) { calls.push(r); return { status: 202, body: { runId: r.body.runId } }; }
      return { status: 200, body: { conversations: [conversation], agents: [], projects: [], sidebar: {} } };
    },
    runEvents: async (id, _after, callback, signal) => {
      if (id !== active) { callback({ seq: 1, type: 'end', status: 'complete', ms: 1 }); return { last: 1, ended: true }; }
      return new Promise(resolve => { finish = () => { callback({ seq: 1, type: 'end', status: 'stopped', ms: 1 }); resolve({ last: 1, ended: true }); }; signal.addEventListener('abort', () => resolve({ last: 0, ended: false }), { once: true }); });
    },
  };
  const c = new ConversationsController(client, () => 'queued-secret-fixture'); t.after(() => c.dispose());
  await c.load(); await c.open(CID);
  c.edit('raw fixture input'); await c.send();
  for (let i = 0; c.getSnapshot().queue[0]?.text !== canonical && i < 100; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(c.getSnapshot().queue[0].text, canonical);
  finish();
  for (let i = 0; c.getSnapshot().runId && i < 100; i++) await new Promise(r => setTimeout(r, 5));
  c.sendQueued('queued-secret-fixture');
  for (let i = 0; !calls.length && i < 100; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.message, canonical);
  assert.equal(calls[0].body.runId, 'queued-secret-fixture');
});
