// AGENT-BTW-01: client-side /btw parsing and SSE frame reduction.
// Run: node --import tsx --test packages/core-ui/src/side-questions.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dir = fileURLToPath(new URL('./', import.meta.url));
const {
  parseBtwCommand, applySideFrame, drainSseFrames, initialSideView, streamSideQuestion,
} = await import(join(dir, 'side-questions.ts'));

test('parseBtwCommand recognises /btw with a question', () => {
  assert.deepEqual(parseBtwCommand('/btw why did you do that?'), { kind: 'btw', question: 'why did you do that?' });
  assert.deepEqual(parseBtwCommand('  /BTW   what is in memory?  '), { kind: 'btw', question: 'what is in memory?' });
});

test('parseBtwCommand treats a bare /btw as empty, not a send', () => {
  assert.deepEqual(parseBtwCommand('/btw'), { kind: 'btw-empty' });
  assert.deepEqual(parseBtwCommand('/btw    '), { kind: 'btw-empty' });
});

test('parseBtwCommand ignores non-commands and look-alikes', () => {
  assert.deepEqual(parseBtwCommand('hello /btw'), { kind: 'none' });
  assert.deepEqual(parseBtwCommand('/btweet hi'), { kind: 'none' }, 'word boundary: /btweet is not /btw');
  assert.deepEqual(parseBtwCommand(''), { kind: 'none' });
});

test('applySideFrame builds a cumulative answer from delta tails', () => {
  let v = initialSideView;
  v = applySideFrame(v, { type: 'started', requestId: 'r1' });
  assert.equal(v.phase, 'running');
  assert.equal(v.requestId, 'r1');
  v = applySideFrame(v, { type: 'delta', content: 'Because ' });
  v = applySideFrame(v, { type: 'delta', content: 'it is safer.' });
  assert.equal(v.answer, 'Because it is safer.');
  v = applySideFrame(v, { type: 'done', provider: 'ollama', model: 'qwen' });
  assert.equal(v.phase, 'done');
  assert.equal(v.model, 'qwen');
});

test('applySideFrame surfaces cancelled and error terminal states', () => {
  assert.equal(applySideFrame(initialSideView, { type: 'cancelled' }).phase, 'cancelled');
  const e = applySideFrame(initialSideView, { type: 'error', error: 'boom' });
  assert.equal(e.phase, 'error');
  assert.equal(e.error, 'boom');
});

test('drainSseFrames parses complete frames and keeps the leftover; skips heartbeats', () => {
  const { frames, rest } = drainSseFrames('data: {"type":"started"}\n\n: ping\n\ndata: {"type":"delta","content":"hi"}\n\ndata: {"type":"de');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, 'started');
  assert.equal(frames[1].content, 'hi');
  assert.equal(rest, 'data: {"type":"de', 'partial frame retained');
});

test('streamSideQuestion folds a chunked stream into a final view', async () => {
  const transport = async (_path, _body, onChunk) => {
    onChunk('data: {"type":"started","requestId":"r9"}\n\n');
    onChunk('data: {"type":"delta","content":"one "}\n\ndata: {"type":"delta","content":"two"}\n\n');
    onChunk('data: {"type":"done","model":"qwen"}\n\n');
  };
  const views = [];
  const final = await streamSideQuestion(transport, 'sess', 'q', (v) => views.push(v));
  assert.equal(final.phase, 'done');
  assert.equal(final.answer, 'one two');
  assert.equal(final.requestId, 'r9');
  assert.ok(views.length >= 4, 'intermediate views were emitted');
});
