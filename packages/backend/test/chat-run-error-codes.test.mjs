// A reply that ends with a known reason keeps that reason, so the chat says why (not "Something went wrong").
// Run: node --import tsx --test test/chat-run-error-codes.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
const { ChatRun } = await import('../src/services/chat-runs.ts');
const { KEPT_ERROR_CODES } = await import('../src/repositories/chat-conversations.ts');

test('a coding app refused for the organization or out of plan usage keeps its reason on the run and in the saved message', () => {
  for (const code of ['subscription_org_blocked', 'usage_limit', 'model_unavailable']) {
    const run = new ChatRun('run-' + code, 'owner', 'session', 0, () => 0);
    run.push({ type: 'error', code });
    assert.equal(run.error, code);
    assert.ok(KEPT_ERROR_CODES.includes(code), `${code} is saved with the message, so reopening the chat still says why`);
  }
  const other = new ChatRun('run-other', 'owner', 'session', 0, () => 0);
  other.push({ type: 'error', code: 'something_unknown' });
  assert.equal(other.error, 'failed', 'an unknown code stays generic');
});
