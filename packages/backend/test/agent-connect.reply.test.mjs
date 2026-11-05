import './fixtures/channel-library.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAgentReply } from '../extensions/shared/agent-reply.js';

test('agent reply extraction handles JSON/SSE and rejects partial or error responses', () => {
  const response = (body, contentType = 'application/json', statusCode = 200) => ({ body, headers: { 'content-type': contentType }, statusCode });
  assert.equal(extractAgentReply(response(JSON.stringify({ message: { content: 'hello' } }))), 'hello');
  assert.equal(extractAgentReply(response('data: {"type":"text","content":"hello"}\n\ndata: {"type":"done"}\n\n', 'text/event-stream')), 'hello');
  assert.throws(() => extractAgentReply(response('data: {"type":"text","content":"partial"}\n\n', 'text/event-stream')));
  assert.throws(() => extractAgentReply(response('data: {"type":"error","error":"secret"}\n\n', 'text/event-stream')), /Agent request failed/);
  assert.throws(() => extractAgentReply(response('{}', 'application/json', 500)));
});
