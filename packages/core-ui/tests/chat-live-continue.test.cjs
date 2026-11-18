// After Allow once (in the chat or on the Approvals page) the server continues the chat in a new run; the open chat follows it without a reload.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ConversationsController, CONTINUE_RETRY_MS } = require('../src/conversations.ts');
const src = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const CID = '9a8b7c6d-1d2a-4f4e-9b1a-6c7d8e9f0a1b', AID = '12345678-1234-4234-8234-123456789abc', RUN = `approval-${AID}`;
const conversation = { id: CID, title: 'T', agentId: null, projectId: null, pinned: false, preview: '', createdAt: '', updatedAt: '' };
const asked = { id: 'm1', role: 'user', content: 'Send the report', parts: null, status: 'complete', runId: 'run-first-0001', durationMs: null, createdAt: '' };
const waited = { id: 'm2', role: 'assistant', content: 'It waits for you.', parts: [{ kind: 'tools', step: 1, calls: [{ id: 't1', name: 'send_email', input: '{}', output: 'Waiting for approval', approvalId: AID }] }], status: 'complete', runId: 'run-first-0001', durationMs: 5, createdAt: '' };
const cont = { id: 'm3', role: 'user', content: 'I decided the waiting approval. Continue the task with its result.', parts: null, status: 'complete', runId: RUN, durationMs: null, createdAt: '' };

/** A fake server: the continuation run starts only after `startAfter` reads of the messages (a moment after the answer). */
function fakeServer({ startAfter = 2, finished = false } = {}) {
  const calls = []; let reads = 0; const streamed = [];
  const client = {
    getSnapshot: () => ({ phase: 'authenticated', epoch: 1, user: { id: 'u', role: 'owner' } }), subscribe: () => () => {},
    runEvents: async (runId, after, onEvent) => {
      streamed.push({ runId, after });
      onEvent({ seq: 1, type: 'text', content: 'The report was sent.' });
      onEvent({ seq: 2, type: 'end', status: 'complete', ms: 40 });
      return { last: 2, ended: true };
    },
    request: async (r) => {
      calls.push(r);
      if (/\/messages(\?|$)/.test(r.path)) {
        reads++;
        const started = reads > startAfter;
        if (finished && started) return { status: 200, body: { conversation, messages: [asked, waited, cont, { id: 'm4', role: 'assistant', content: 'The report was sent.', parts: null, status: 'complete', runId: RUN, durationMs: 40, createdAt: '' }], activeRunId: null } };
        return { status: 200, body: { conversation, messages: started ? [asked, waited, cont] : [asked, waited], activeRunId: started ? RUN : null } };
      }
      return { status: 200, body: { conversations: [conversation], projects: [], agents: [], models: [], last: null } };
    },
  };
  return { client, calls, streamed, reads: () => reads };
}
const until = async (ok, ms = 2000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); };

test('after Allow the open chat picks up the continuation run (bounded retry) and streams its reply without a reload', async () => {
  const server = fakeServer({ startAfter: 2 });
  const c = new ConversationsController(server.client);
  try {
    await c.load(); await c.open(CID);
    assert.equal(c.getSnapshot().runId, null, 'nothing runs while the approval waits');
    // The server answers Allow at once but starts the run a moment later: the first look finds nothing yet.
    await c.pickUpContinuation([0, 10, 10, 10]);
    await until(() => c.getSnapshot().turns.some(t => t.role === 'assistant' && t.runId === RUN && t.status === 'complete'));
    assert.deepEqual(server.streamed, [{ runId: RUN, after: 0 }], 'attached to the continuation run once');
    const reply = c.getSnapshot().turns.find(t => t.role === 'assistant' && t.runId === RUN);
    assert.equal(reply.content, 'The report was sent.');
    assert.equal(c.getSnapshot().runId, null, 'the run ended');
    assert.equal(server.reads(), 3, 'opened once, looked again until the run was there, then stopped');
    assert.ok(c.getSnapshot().turns.some(t => t.key === 'm3'), 'the continue message shows too');
    assert.equal(server.calls.filter(r => r.method === 'POST').length, 0, 'nothing is sent by the window');
  } finally { c.dispose(); }
});

test('a continuation that already finished shows its saved reply; the retry is bounded when nothing comes', async () => {
  const done = fakeServer({ startAfter: 1, finished: true });
  const c = new ConversationsController(done.client);
  try {
    await c.load(); await c.open(CID);
    await c.pickUpContinuation([0, 5]);
    assert.equal(c.getSnapshot().turns.at(-1).content, 'The report was sent.');
    assert.equal(done.streamed.length, 0);
  } finally { c.dispose(); }
  const never = fakeServer({ startAfter: 1000 });
  const d = new ConversationsController(never.client);
  try {
    await d.load(); await d.open(CID);
    await d.pickUpContinuation([0, 1, 1]);
    assert.equal(never.reads(), 1 + 3, 'one look per step, then it stops');
    assert.equal(d.getSnapshot().runId, null);
  } finally { d.dispose(); }
  assert.ok(CONTINUE_RETRY_MS.length <= 8 && CONTINUE_RETRY_MS.reduce((a, b) => a + b, 0) <= 15_000, 'short and bounded');
});

test('switching to another chat stops the look-again for the old one', async () => {
  const server = fakeServer({ startAfter: 1 });
  const c = new ConversationsController(server.client);
  try {
    await c.load(); await c.open(CID);
    const pick = c.pickUpContinuation([20, 20]);
    c.newChat();
    await pick;
    assert.equal(server.reads(), 1, 'no read for a chat that is no longer open');
    assert.equal(server.streamed.length, 0);
  } finally { c.dispose(); }
});

test('wiring: Allow once / Deny in the chat, a decision on the Approvals page and coming back to the chat all look for the continued reply', () => {
  const m = src('ChatMoments.tsx');
  assert.match(m, /if \(r\.status === 200\) \{ setState\('allowed'\); onDecided\?\.\(\); return; \}/);
  assert.match(m, /if \(r\.status === 200\) onDecided\?\.\(\); \}/);
  const v = src('ChatView.tsx');
  assert.match(v, /onDecided: \(\) => \{ void controller\.pickUpContinuation\(\); void controller\.refreshList\(\); \}/); // CP15: the waiting count follows the decision
  assert.match(v, /if \(mode === 'live' && active && s\.activeId\) void controller\.refreshActive\(\);/);
  const shell = src('SignedInShell.tsx');
  assert.match(shell, /const decided=useCallback\(\(\)=>\{reloadApprovals\(\);void chat\?\.pickUpContinuation\(\);\},\[reloadApprovals,chat\]\);/);
  assert.match(shell, /onDecision=\{decided\}/);
  assert.doesNotMatch(src('conversations.ts'), /localStorage|sessionStorage/);
});

test('Allow once that loses to a decision made elsewhere shows the real outcome, not "not allowed"', () => {
  const s = src('ChatMoments.tsx');
  const allow = s.slice(s.indexOf('const allow = async'), s.indexOf('const saveTask'));
  assert.match(allow, /Decided in another place first/);
  assert.match(allow, /GET', path: `\/api\/approvals\/\$\{id\}`/);
  assert.match(allow, /v\.status !== 'pending'/);
  assert.ok(allow.indexOf("setState('allowed'); onDecided?.(); }") > allow.indexOf('Decided in another place first'), 'an approval made elsewhere still picks up the continuation');
  assert.ok(allow.lastIndexOf('It was not allowed') > allow.indexOf("v.status !== 'pending'"), 'the refusal notice shows only while it still waits');
});
