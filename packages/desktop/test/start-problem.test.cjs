'use strict';
// STORE-MAP-01 P3: the start page reads the backend's start problem and shows only plain text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startProblemOf, failedParams } = require('../src/start-problem.cjs');

test('the newest start problem in the log is found', () => {
  const lines = [
    '[Database] Initializing schema...',
    'GIRRU_START_PROBLEM {"kind":"migration_failed","step":"164_departments","errorId":"E-7F3A-21","thisVersion":"1.6.0"}',
    'other line',
  ];
  assert.deepEqual(failedParams(startProblemOf(lines)), { kind: 'migration_failed', thisVersion: '1.6.0', step: '164_departments', errorId: 'E-7F3A-21' });
});

test('a newer workspace names the version that wrote it', () => {
  const p = startProblemOf(['GIRRU_START_PROBLEM {"kind":"layout_newer","writtenBy":"1.7.0","thisVersion":"1.6.0","unknown":["167"]}']);
  assert.deepEqual(failedParams(p), { kind: 'layout_newer', thisVersion: '1.6.0', writtenBy: '1.7.0' });
});

test('anything else is not a start problem', () => {
  assert.equal(startProblemOf(['Error: boom', 'GIRRU_START_PROBLEM not json', 'GIRRU_START_PROBLEM {"kind":"other"}']), null);
  assert.equal(startProblemOf(undefined), null);
  const p = failedParams({ kind: 'migration_failed', step: 'a\nb'.repeat(100), errorId: 'E-1' });
  assert.ok(!/\n/.test(p.step) && p.step.length <= 80);
});
