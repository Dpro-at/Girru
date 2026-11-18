import test from 'node:test';
import assert from 'node:assert/strict';
import {runSteps} from '../src/devices/coordinator.ts';
import {statusPayload} from '../src/devices/contracts.ts';

test('CP5 steps: the plan titles when there is a plan, otherwise the newest tool steps; never inputs', () => {
  assert.deepEqual(runSteps({plan: [{title: 'Read the issue', status: 'done'}, {title: 'Run the tests', status: 'active'}, {title: 'detail', status: 'pending', parent: 2}, {title: 'Write the result', status: 'pending'}]}),
    [{title: 'Read the issue', state: 'done'}, {title: 'Run the tests', state: 'now'}, {title: 'Write the result', state: 'next'}]);
  const steps = runSteps({steps: [{name: 'read_file', input: 'secret path', done: true, failed: false}, {name: 'run-tests', input: 'x', done: false, failed: false}]});
  assert.deepEqual(steps, [{title: 'read file', state: 'done'}, {title: 'run tests', state: 'now'}]);
  assert.ok(!JSON.stringify(steps).includes('secret'));
  assert.deepEqual(runSteps({}), []);
});

test('CP5 steps travel in the status message, bounded and plain', () => {
  const base = {taskId: 't1', attemptId: 'a1', state: 'running', sessionId: null, runId: null, detail: ''};
  assert.ok(statusPayload.safeParse({...base, steps: [{title: 'Run the tests', state: 'now'}]}).success);
  assert.ok(statusPayload.safeParse(base).success, 'steps stay optional');
  assert.equal(statusPayload.safeParse({...base, steps: Array.from({length: 13}, () => ({title: 'x', state: 'done'}))}).success, false);
  assert.equal(statusPayload.safeParse({...base, steps: [{title: 'bad\nline', state: 'now'}]}).success, false);
  assert.equal(statusPayload.safeParse({...base, steps: [{title: 'x', state: 'running'}]}).success, false);
});
