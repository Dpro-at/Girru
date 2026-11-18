import test from 'node:test';
import assert from 'node:assert/strict';
import { chatReplyText as legacy } from '../src/cli/chat-response.ts';
import { chatReplyText as installed } from '../../cli/src/utils/chat-response.ts';
const frame = row => `data: ${JSON.stringify(row)}\n\n`;
for (const [name, decode] of [['legacy', legacy], ['installed', installed]]) {
  test(`${name} CLI projects JSON and completed backend streams without tool/reasoning output`, () => {
    assert.equal(decode({ message: { content: 'JSON reply' } }), 'JSON reply');
    assert.equal(decode(': ping\n\n' + frame({ type: 'reasoning', content: 'private reasoning' }) + frame({ type: 'tool_result', results: [{ output: 'private tool output' }] }) + frame({ type: 'text', content: 'مرحبا ' }) + frame({ type: 'text', content: 'world' }) + frame({ type: 'done' })), 'مرحبا world');
    assert.equal(decode(frame({ content: 'Legacy text', done: false }) + frame({ content: '', done: true })), 'Legacy text');
  });
  test(`${name} CLI rejects partial/error streams with a safe error`, () => {
    assert.throws(() => decode(frame({ type: 'text', content: 'partial' })), /interrupted/);
    assert.throws(() => decode(frame({ type: 'error', error: 'sensitive-fixture-detail' })), error => error.message === 'Backend chat failed.');
    assert.throws(() => decode({ error: 'not a reply' }), /Invalid backend/);
  });
}
