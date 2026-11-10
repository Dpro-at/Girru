import test from 'node:test';
import assert from 'node:assert/strict';
import {taskRules, taskRulesChangeOk, decideTask} from '../src/devices/task-rules.ts';
import {computerLook, computerLookChangeOk} from '../src/api/routes/computer-look.ts';

test('tasks from other computers: ask by default, project exceptions, always-allow per computer and project (CP6, CP4b)', () => {
  const none = taskRules(undefined);
  assert.deepEqual(none, {rule: 'ask', projects: {}, always: [], atOnce: 3, column: null, takes: true});
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
  assert.deepEqual(computerLook({icons: {a: 'imac', b: 'toaster'}, names: {a: 'Office PC', c: '', d: 'x'.repeat(65)}}), {icons: {a: 'imac'}, names: {a: 'Office PC'}, notices: true});
  assert.equal(computerLookChangeOk({deviceId: 'a', icon: 'linux'}), true);
  assert.equal(computerLookChangeOk({deviceId: 'a', name: ''}), true, 'an empty name goes back to the account name');
  assert.equal(computerLookChangeOk({deviceId: 'a', icon: 'toaster'}), false);
  assert.equal(computerLookChangeOk({deviceId: 'a'}), false);
  assert.equal(computerLookChangeOk({deviceId: 'a/b', icon: 'linux'}), false);
});

test('review fixes: Don’t accept for all wins over always-allow; agents may only tighten', async () => {
  const {changeIsStricter} = await import('../src/devices/task-rules.ts');
  const r = taskRules({rule: 'refuse', projects: {}, always: [{source: 'mac', projectId: 'p'}]});
  assert.equal(decideTask(r, 'mac', 'p'), 'refuse');
  const ask = taskRules({rule: 'ask', projects: {p1: 'refuse'}, always: [{source: 'mac', projectId: 'p2'}]});
  assert.equal(changeIsStricter(ask, {rule: 'refuse'}), true);
  assert.equal(changeIsStricter(ask, {rule: 'auto'}), false);
  assert.equal(changeIsStricter(ask, {project: {id: 'p1', rule: null}}), false, 'removing a Don’t accept exception loosens it');
  assert.equal(changeIsStricter(ask, {project: {id: 'p1', rule: 'ask'}}), false);
  assert.equal(changeIsStricter(ask, {always: {source: 'mac', projectId: 'p2', on: false}}), true);
  assert.equal(changeIsStricter(ask, {always: {source: 'pc', projectId: 'p3', on: true}}), false);
  assert.equal(changeIsStricter(taskRules({rule: 'auto', projects: {p: 'ask'}, always: []}), {project: {id: 'p', rule: null}}), false);
});

test('the checked value is the saved value: a change that would be cut off is refused', async () => {
  const {applyTaskRulesChange} = await import('../src/devices/task-rules.ts');
  const full = taskRules({rule: 'ask', projects: Object.fromEntries(Array.from({length: 500}, (_, i) => ['p' + i, 'refuse'])), always: []});
  assert.equal(Object.keys(full.projects).length, 500);
  assert.throws(() => applyTaskRulesChange(full, {project: {id: 'new', rule: 'refuse'}}), /computer_task_rules_full/);
  assert.equal(applyTaskRulesChange(full, {project: {id: 'p1', rule: null}}).projects.p1, undefined);
});

test('tasks at once (1–5) and the landing column are owner choices; fewer at once counts as stricter', async () => {
  const {taskRules, applyTaskRulesChange, changeIsStricter, taskRulesChangeOk} = await import('../src/devices/task-rules.ts');
  const base = taskRules(undefined);
  assert.equal(applyTaskRulesChange(base, {atOnce: 1}).atOnce, 1);
  assert.equal(applyTaskRulesChange(base, {column: 'To do'}).column, 'To do');
  assert.equal(applyTaskRulesChange({...base, column: 'To do'}, {column: null}).column, null);
  for (const bad of [{atOnce: 0}, {atOnce: 6}, {atOnce: 2.5}, {column: ''}, {column: ' padded'}, {column: 'x'.repeat(61)}]) assert.equal(taskRulesChangeOk(bad), false);
  assert.equal(changeIsStricter(base, {atOnce: 2}), true);
  assert.equal(changeIsStricter(base, {atOnce: 5}), false);
  assert.equal(changeIsStricter(base, {column: 'Review'}), false);
  assert.deepEqual(taskRules({atOnce: 9, column: 7}), {...base});
});

test('reserved names never become keys (prototype safety)', async () => {
  const {taskRules, applyTaskRulesChange, taskRulesChangeOk} = await import('../src/devices/task-rules.ts');
  const {computerLookChangeOk, computerLook} = await import('../src/api/routes/computer-look.ts');
  for (const id of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(taskRulesChangeOk({project: {id, rule: 'refuse'}}), false, id);
    assert.equal(computerLookChangeOk({deviceId: id, name: 'x'}), false, id);
  }
  assert.deepEqual(Object.keys(taskRules({projects: {__proto__: 'auto', ok: 'ask'}}).projects), ['ok']);
  assert.equal(Object.hasOwn(computerLook(JSON.parse('{"names":{"__proto__":"x"}}')).names, '__proto__'), false);
  assert.equal(applyTaskRulesChange(taskRules(undefined), {project: {id: 'p1', rule: 'refuse'}}).projects.p1, 'refuse');
});

test('Takes new tasks: off is a stricter choice an agent may make; only the owner turns it back on', async () => {
  const {taskRules, applyTaskRulesChange, changeIsStricter, taskRulesChangeOk} = await import('../src/devices/task-rules.ts');
  const base = taskRules(undefined);
  assert.equal(base.takes, true);
  assert.equal(applyTaskRulesChange(base, {takes: false}).takes, false);
  assert.equal(changeIsStricter(base, {takes: false}), true);
  assert.equal(changeIsStricter({...base, takes: false}, {takes: true}), false);
  assert.equal(taskRulesChangeOk({takes: 'no'}), false);
});
