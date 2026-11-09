import test from 'node:test';
import assert from 'node:assert/strict';
import {taskRules, taskRulesChangeOk, decideTask} from '../src/devices/task-rules.ts';
import {computerLook, computerLookChangeOk} from '../src/api/routes/computer-look.ts';

test('tasks from other computers: ask by default, project exceptions, always-allow per computer and project (CP6, CP4b)', () => {
  const none = taskRules(undefined);
  assert.deepEqual(none, {rule: 'ask', projects: {}, always: []});
  const rules = taskRules({rule: 'auto', projects: {p1: 'refuse', p2: 'ask', 'bad id!': 'auto', p3: 'maybe'}, always: [{source: 'mac', projectId: 'p2'}, {source: 'x'}]});
  assert.deepEqual(rules.projects, {p1: 'refuse', p2: 'ask'});
  assert.equal(rules.always.length, 1);
  assert.equal(decideTask(rules, 'mac', 'p9'), 'auto', 'the rule for all');
  assert.equal(decideTask(rules, 'pc', 'p2'), 'ask', 'a project exception wins over the rule for all');
  assert.equal(decideTask(rules, 'mac', 'p2'), 'auto', 'always-allow from that computer in that project');
  assert.equal(decideTask({...rules, always: [{source: 'mac', projectId: 'p1'}]}, 'mac', 'p1'), 'refuse', 'Don’t accept on a project is never overridden');
});

test('task rule changes accept only known shapes', () => {
  assert.equal(taskRulesChangeOk({rule: 'auto'}), true);
  assert.equal(taskRulesChangeOk({rule: 'yes'}), false);
  assert.equal(taskRulesChangeOk({project: {id: 'p1', rule: null}}), true);
  assert.equal(taskRulesChangeOk({project: {id: 'p1', rule: 'auto', extra: 1}}), false);
  assert.equal(taskRulesChangeOk({always: {source: 'mac', projectId: 'p1', on: true}}), true);
  assert.equal(taskRulesChangeOk({always: {source: 'mac', projectId: 'p1'}}), false);
  assert.equal(taskRulesChangeOk({}), false);
  assert.equal(taskRulesChangeOk({other: 1}), false);
});

test('computer pictures and names: known pictures, short plain names (CP9c)', () => {
  assert.deepEqual(computerLook({icons: {a: 'imac', b: 'toaster'}, names: {a: 'Office PC', c: '', d: 'x'.repeat(65)}}), {icons: {a: 'imac'}, names: {a: 'Office PC'}});
  assert.equal(computerLookChangeOk({deviceId: 'a', icon: 'linux'}), true);
  assert.equal(computerLookChangeOk({deviceId: 'a', name: ''}), true, 'an empty name goes back to the account name');
  assert.equal(computerLookChangeOk({deviceId: 'a', icon: 'toaster'}), false);
  assert.equal(computerLookChangeOk({deviceId: 'a'}), false);
  assert.equal(computerLookChangeOk({deviceId: 'a/b', icon: 'linux'}), false);
});
