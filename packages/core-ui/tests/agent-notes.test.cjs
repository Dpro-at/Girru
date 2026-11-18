// STORE-MAP-01 P5 screens (boards P5a–P5c): wire contract for the agent's own notes,
// MEMORY.md changed outside Girru, and agent packages (browser client and bridge).
require('./load.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { allowedRequest } = require('../src/session.ts');
const { allowed } = require('../scripts/application-server.cjs');
const { notesResponse, notesPath, packagePath, PACKAGES_STATUS_PATH } = require('../src/agent-notes-contract.js');

test('the P5 routes pass only in their exact shape', () => {
  const h = 'a'.repeat(64);
  for (const allow of [allowedRequest, allowed]) {
    assert.equal(allow('GET', notesPath('agent-1', '/status')), true);
    assert.equal(allow('GET', notesPath('agent-1', '/history')), true);
    assert.equal(allow('GET', notesPath('agent-1', '/outside')), true);
    assert.equal(allow('PUT', notesPath('agent-1'), { content: 'x', expectedHash: h }), true);
    assert.equal(allow('PUT', notesPath('agent-1'), { content: 'x', expectedHash: null }), false, 'a save names the version read');
    assert.equal(allow('POST', notesPath('agent-1', '/outside'), { pick: 'use', fileHash: h }), true);
    assert.equal(allow('POST', notesPath('agent-1', '/outside'), { pick: 'merge', fileHash: h }), false);
    assert.equal(allow('POST', notesPath('agent-1', '/outside'), { pick: 'keep', fileHash: h, extra: 1 }), false);
    assert.equal(allow('GET', PACKAGES_STATUS_PATH), true);
    assert.equal(allow('GET', packagePath('agent-1')), true);
    assert.equal(allow('POST', '/api/agent-packages/preview', { package: { format: 'girru.agent' } }), true);
    assert.equal(allow('POST', '/api/agent-packages/import', { package: {}, expectedPackageHash: h }), true);
    assert.equal(allow('POST', '/api/agent-packages/import', { package: {} }), false, 'import names the previewed hash');
    assert.equal(allow('POST', '/api/agent-packages/import', { package: {}, expectedPackageHash: h, permissions: [] }), false);
    assert.equal(allow('GET', notesPath('../x', '/status')), false);
  }
});

test('only what the pages show passes back', () => {
  const h = 'b'.repeat(64);
  assert.deepEqual(notesResponse(notesPath('a', '/status'), 200, { imported: true, versions: 3, outsideChange: true, path: '/secret' }), { imported: true, versions: 3, outsideChange: true });
  assert.deepEqual(notesResponse(notesPath('a', '/outside'), 200, { outside: null }), { outside: null });
  assert.deepEqual(notesResponse(notesPath('a', '/outside'), 200, { hash: h, previousHash: h, success: true }), { hash: h, previousHash: h });
  assert.deepEqual(notesResponse(notesPath('a', '/history'), 200, { versions: [{ version: 2, change: 'update', createdAt: 'x', by: 'owner', reason: null, content: 'hi', user_id: 'u' }] }).versions[0],
    { version: 2, change: 'update', createdAt: 'x', by: 'owner', reason: null, content: 'hi' });
  assert.deepEqual(notesResponse(notesPath('a', '/history'), 404, { code: 'not_found' }), { code: 'not_found' });
  assert.deepEqual(notesResponse(PACKAGES_STATUS_PATH, 404, {}), { code: 'not_found' });
  const plan = notesResponse('/api/agent-packages/preview', 200, { packageHash: h, schemaVersion: 1, agent: { name: 'Noor', description: '', emoji: '', role: 'x' }, instructions: '', personality: { text: 'Calm', traits: {} },
    specialties: [], skills: [], knowledge: [{ name: 'a.md', bytes: 3, read: true, content: 'leak' }], refused: [{ field: 'permissions', why: 'never imported' }], missing: [], alreadyImported: null });
  assert.equal(plan.knowledge[0].content, undefined);
  assert.equal(plan.agent.role, undefined);
  assert.throws(() => notesResponse('/api/agent-packages/import', 200, { agentId: '../x' }));
});
