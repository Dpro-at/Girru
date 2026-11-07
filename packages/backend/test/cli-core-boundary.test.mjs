import test from 'node:test';
import assert from 'node:assert/strict';
import { requestChat } from '../src/cli/chat-client.ts';

test('terminal sends authenticated intent to backend only, without selecting a default model', async () => {
  const requests = [];
  const answer = await requestChat({ token: 'synthetic-token', sessionId: 'synthetic-session', messages: [{ role: 'user', content: 'hello' }], fetchImpl: async (url, init) => {
    requests.push(String(url));
    assert.equal(init.headers.Authorization, 'Bearer synthetic-token');
    assert.deepEqual(JSON.parse(init.body), { messages: [{ role: 'user', content: 'hello' }], sessionId: 'synthetic-session', stream: false });
    assert.equal(init.redirect, 'error');
    return Response.json({ message: { content: 'backend answer' } });
  } });
  assert.equal(answer, 'backend answer');
  assert.deepEqual(requests, ['http://127.0.0.1:41522/api/chat']);
});

test('missing authentication and remote/credential-bearing URLs refuse before network', async () => {
  let calls = 0;
  const base = { sessionId: 'fixture', messages: [], fetchImpl: async () => { calls++; throw Error('unexpected'); } };
  await assert.rejects(requestChat(base), /AGENT_PLAYER_TOKEN/);
  for (const url of ['https://example.test', 'http://user:secret@localhost', 'http://localhost/path']) {
    await assert.rejects(requestChat({ ...base, token: 'fixture', url }), /loopback/);
  }
  assert.equal(calls, 0);
});

test('backend refusal never falls back to a model or exposes response secrets', async () => {
  let calls = 0;
  await assert.rejects(requestChat({ token: 'fixture', sessionId: 'fixture', messages: [], fetchImpl: async () => { calls++; return new Response('sensitive-body', { status: 403 }); } }), /Chat failed \(403\)/);
  assert.equal(calls, 1);
});


test('terminal transport accepts completed SSE and refuses an interrupted HTTP-success reply', async () => {
  const base = { token: 'fixture', sessionId: 'fixture', messages: [{ role: 'user', content: 'hello' }] };
  const stream = 'data: {"type":"reasoning","content":"private"}\r\n\r\ndata: {"type":"text","content":"answer"}\r\n\r\ndata: {"type":"done"}\r\n\r\n';
  assert.equal(await requestChat({ ...base, fetchImpl: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }) }), 'answer');
  await assert.rejects(requestChat({ ...base, fetchImpl: async () => new Response('data: {"type":"text","content":"partial"}\n\n') }), /interrupted/);
});
