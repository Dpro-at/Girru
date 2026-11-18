// AGENT-BTW-01: the side question honours the main turn's local/cloud (P9)
// policy — a local-only stage routes local with no API key, and local-sourced
// history is never carried into a cloud request.
// Run: node --import tsx --test test/side-question-policy.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const backendDir = fileURLToPath(new URL('../', import.meta.url));
const { decideSideRouting } = await import(join(backendDir, 'src/services/side-question/policy.ts'));

test('local-only stage forces the local model and drops the API key (even for a cloud snapshot)', () => {
  const d = decideSideRouting({ localOnly: true, snapshotProviderLocal: false, hasApiKey: true, historyExists: false, historyLocal: null });
  assert.equal(d.providerLocal, true, 'routed local');
  assert.equal(d.forceLocalProvider, true, 'cloud snapshot provider replaced by local');
  assert.equal(d.useApiKey, false, 'no API key sent to a local model');
});

test('a local snapshot never sends an API key', () => {
  const d = decideSideRouting({ localOnly: false, snapshotProviderLocal: true, hasApiKey: false, historyExists: false, historyLocal: null });
  assert.equal(d.providerLocal, true);
  assert.equal(d.useApiKey, false);
  assert.equal(d.forceLocalProvider, false);
});

test('a cloud snapshot (no local-only) uses the cloud provider and its API key', () => {
  const d = decideSideRouting({ localOnly: false, snapshotProviderLocal: false, hasApiKey: true, historyExists: false, historyLocal: null });
  assert.equal(d.providerLocal, false);
  assert.equal(d.useApiKey, true);
  assert.equal(d.forceLocalProvider, false);
});

test('local-sourced history is dropped before a cloud request', () => {
  const d = decideSideRouting({ localOnly: false, snapshotProviderLocal: false, hasApiKey: true, historyExists: true, historyLocal: true });
  assert.equal(d.providerLocal, false, 'this request is cloud');
  assert.equal(d.dropHistory, true, 'local-sourced history must not ride into the cloud');
});

test('cloud-sourced history is dropped before a forced-local request too (symmetric clear)', () => {
  const d = decideSideRouting({ localOnly: true, snapshotProviderLocal: false, hasApiKey: true, historyExists: true, historyLocal: false });
  assert.equal(d.providerLocal, true);
  assert.equal(d.dropHistory, true);
});

test('matching locality keeps the history', () => {
  const cloud = decideSideRouting({ localOnly: false, snapshotProviderLocal: false, hasApiKey: true, historyExists: true, historyLocal: false });
  assert.equal(cloud.dropHistory, false);
  const local = decideSideRouting({ localOnly: false, snapshotProviderLocal: true, hasApiKey: false, historyExists: true, historyLocal: true });
  assert.equal(local.dropHistory, false);
});
