// DEVICES-PROJECT-01 (boards CP1–CP2): the road a new computer takes, and what “Same as” brings.
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/ComputerStart.tsx');
const devices = [{ id: 'self', label: 'Office PC', status: 'approved' }, { id: 'mac', label: 'This Mac', status: 'approved' }];
test('the road comes from the account after a restart, never from browser storage', () => {
  assert.equal(S.setupRoad(undefined), null);
  assert.equal(S.setupRoad({ connected: false }), null);
  assert.equal(S.setupRoad({ connected: true, view: { deviceId: 'self', deviceStatus: 'pending', devices } }), 'signin');
  assert.equal(S.setupRoad({ connected: true, workspaces: [], view: { deviceId: 'self', deviceStatus: 'approved', devices } }), 'signin');
  assert.equal(S.setupRoad({ connected: true, workspaces: [], view: { deviceId: 'self', deviceStatus: 'approved', devices: [devices[0]] } }), null, 'first computer of an account: the usual first run');
  assert.equal(S.setupRoad({ connected: true, workspaces: [{ id: 'w', label: 'W', mode: 'continuity', state: 'waiting_source_review' }], view: { deviceId: 'self', deviceStatus: 'approved', devices } }), 'same');
  assert.equal(S.setupRoad({ connected: true, workspaces: [{ id: 'w', label: 'W', mode: 'independent', state: 'ready' }], view: { deviceId: 'self', deviceStatus: 'approved', devices } }), null);
  S.writeSetupEntry('signin'); assert.equal(S.readSetupEntry(), 'signin'); S.writeSetupEntry(null); assert.equal(S.readSetupEntry(), null);
});
test('what “Same as” brings is counted in plain words', () => {
  const words = S.whatComes([{ category: 'agent', logicalId: 'a' }, { category: 'agent', logicalId: 'b' }, { category: 'rule', logicalId: 'r' }]).map(i => i.words);
  assert.deepEqual(words, ['2 agents', '1 rule']);
});
