// STORE-MAP-01 P3 (FD2a): the departments wire contract. Only known routes, shapes and fields pass,
// in the browser gate and the desktop bridge; a second read of an answer keeps it unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
let C;
test.before(async () => { C = await import('../src/departments-contract.js'); });

test('routes: only the known calls and bodies pass', () => {
  const ok = (m, p, b) => C.allowedDepartments(m, p, b);
  assert.ok(ok('GET', '/api/departments'));
  assert.ok(ok('POST', '/api/departments', { name: 'Research' }));
  assert.ok(!ok('POST', '/api/departments', { name: 'R', extra: 1 }));
  assert.ok(ok('PATCH', '/api/departments/dept-1', { version: 2, name: 'Platform' }));
  assert.ok(ok('PATCH', '/api/departments/dept-1', { version: 2, color: '#2F8A5B', letter: 'P', leadAgentId: null }));
  assert.ok(!ok('PATCH', '/api/departments/dept-1', { name: 'X' }), 'a change needs the version it was read at');
  assert.ok(!ok('PATCH', '/api/departments/dept-1', { version: 1, color: 'red' }));
  assert.ok(ok('POST', '/api/departments/dept-1/merge', { into: 'dept-2' }));
  assert.ok(ok('POST', '/api/departments/merges/m-1/undo'));
  assert.ok(ok('POST', '/api/departments/questions/q-1', { departmentId: null }));
  assert.ok(ok('POST', '/api/departments/dept-1/delete-preview'));
  assert.ok(ok('POST', '/api/departments/dept-1/delete', { expectedPreviewHash: 'a'.repeat(64) }));
  assert.ok(!ok('POST', '/api/departments/dept-1/delete', {}));
  assert.ok(!ok('DELETE', '/api/departments/dept-1'));
  assert.ok(ok('POST', '/api/agents/departments/rename', { from: 'hr', to: 'people' }), 'the old rename still passes');
});

test('answers: only known fields; reading twice changes nothing', () => {
  const list = C.departmentsResponse(200, { departments: [{ id: 'dept-1', name: 'Platform', version: 3, color: '#2F8A5B', letter: 'P', leadAgentId: 'a-1', secret: 'x',
    agents: [{ id: 'a-1', name: 'Rafid', prompt: 'x' }], projects: [{ key: 'p-1', name: 'Alpha' }] }], questions: [{ id: 'q1', kind: 'rule_target', subjectId: 'r1', name: 'designers' }] }, '/api/departments');
  assert.deepEqual(list.departments[0], { id: 'dept-1', name: 'Platform', letter: 'P', color: '#2F8A5B', leadAgentId: 'a-1', version: 3, agents: [{ id: 'a-1', name: 'Rafid' }], projects: [{ key: 'p-1', name: 'Alpha' }] });
  assert.deepEqual(C.departmentsResponse(200, list, '/api/departments'), list, 'the bridge and the browser both read it');
  const preview = C.departmentsResponse(200, { department: { name: 'Sales' }, effects: { projectsToGeneral: 2, agentsToNone: 1 }, previewHash: 'b'.repeat(64) }, '/api/departments/d/delete-preview');
  assert.deepEqual(preview, { name: 'Sales', effects: { projects: 2, agents: 1, pinnedFacts: 0, accessRules: 0 }, previewHash: 'b'.repeat(64) });
  assert.deepEqual(C.departmentsResponse(200, preview, '/api/departments/d/delete-preview'), preview);
  assert.deepEqual(C.departmentsResponse(409, { code: 'name_taken', error: 'x' }, '/api/departments/d'), { code: 'conflict', reason: 'name_taken' });
  assert.throws(() => C.departmentsResponse(200, { mergeId: 'bad id!' }, '/api/departments/d/merge'), /protocol/);
});

// STORE-MAP-01 P3 (FD3): the memory page contract passes source, trust, validity, the checked route,
// the trust / replaced filters, and the newer text of a memory changed while it was edited.
test('memory details: validity and trust pass; the edit check carries the newer text', async () => {
  const M = await import('../src/memory-pages-contract.js');
  const A = await import('../src/agent-card-contract.js');
  const detail = M.memoryPagesResponse('/api/memory/scopes/memories/m1', 200, { memory: { id: 'm1', type: 'fact', content: 'x', drawerId: 'owner', importance: 5, layer: 'working', createdAt: '2026-11-02T10:00:00',
    usage: {}, graph: {}, readers: {}, validity: { source: 'agent', sourceRef: 'a-1', trust: 'unchecked', validFrom: '2026-11-02T10:00:00', validTo: null, supersededBy: null, replaces: ['m0', 'bad id!'], version: 3, secret: 'x' } } });
  assert.deepEqual(detail.memory.validity, { source: 'agent', sourceRef: 'a-1', trust: 'unchecked', validFrom: '2026-11-02T10:00:00', validTo: null, supersededBy: null, replaces: ['m0'], version: 3 });
  const gate = M.allowedMemoryPages;
  assert.ok(gate('PUT', '/api/memory/scopes/memories/m1/checked', { checked: true }));
  assert.ok(!gate('PUT', '/api/memory/scopes/memories/m1/checked', { checked: 'yes' }));
  assert.ok(gate('GET', '/api/memory/scopes/memories?scope=company&trust=imported&replaced=show'));
  assert.ok(!gate('GET', '/api/memory/scopes/memories?scope=company&trust=maybe'));
  assert.ok(A.allowedAgentCard('PUT', '/api/memory/b61ce5c2-c2e6-4c7e-8a21-f0ac8be25dd6', { content: 'new', expectedVersion: 3 }));
  assert.ok(!A.allowedAgentCard('PUT', '/api/memory/b61ce5c2-c2e6-4c7e-8a21-f0ac8be25dd6', { expectedVersion: 3 }), 'a version alone changes nothing');
  assert.deepEqual(A.agentCardResponse('/api/memory/b61ce5c2-c2e6-4c7e-8a21-f0ac8be25dd6', 409, { code: 'version_conflict', error: 'x', current: { content: 'theirs', version: 4, type: 'fact', importance: 5, secret: 'x' } }),
    { code: 'version_conflict', current: { content: 'theirs', version: 4, importance: 5 } });
});
