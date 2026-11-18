// Synthetic UI projection versus the authoritative backend evaluator. No DB/model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAccessController } from '../../core-ui/src/memory-access.ts';
import { projectRuleCell, ruleView, effectiveMask, columnsOf, maskOf, ACCESS_COLUMNS, simulate, parseAccessChanges } from '../src/memory/scopes/access.ts';

const now = Date.parse('2026-11-07T12:00:00Z');
const scopes = ['company', 'department:engineering', 'project:fixture'];
const levels = scopes.map(scope => ({ scope, agentId: null }));
levels.push({ scope: 'project:fixture', agentId: 'fixture-agent' });
const modes = ['allow', 'deny', 'inherit'];
function snapshot(seed) {
  const rules = [];
  let n = seed;
  const next = () => { n = (Math.imul(n, 1664525) + 1013904223) >>> 0; return n; };
  for (const scope of scopes) for (const agent of ['', 'fixture-agent']) for (const kind of ['owner', 'project', 'people']) {
    if (next() % 3 === 0) continue;
    const [scope_kind, scope_id = ''] = scope.split(':');
    rules.push({ id: `r${rules.length}`, scope_kind, scope_id, agent_id: agent, drawer_kind: kind,
      read_mode: modes[next() % 3], write_mode: modes[next() % 3],
      ends_at: agent && next() % 3 === 0 ? new Date(now - 1000).toISOString() : null,
      reason: null, created_by: 'fixture', created_at: new Date(now - 2000).toISOString() });
  }
  return { ownerId: 'fixture', version: seed, rules, roles: new Map(), templates: new Map(), projectDept: new Map([['fixture', 'engineering']]) };
}
async function controller(snap) {
  const c = new MemoryAccessController({ request: async r => {
    if (r.path === '/api/memory/access') return { status: 200, body: { version: snap.version, rules: snap.rules.map(r => ruleView(r, now)), templates: [] } };
    if (r.path === '/api/agents') return { status: 200, body: { agents: [] } };
    return { status: 404, body: null };
  } });
  await c.load();
  return c;
}
test('presentation-only grid matches backend rule order, expiry and read-required write across 100 synthetic policies', async () => {
  for (let seed = 1; seed <= 100; seed++) {
    const snap = snapshot(seed), c = await controller(snap);
    try {
      for (let i = 0; i < levels.length; i++) for (const kind of ['owner', 'project', 'people']) {
        const path = i === 3 ? scopes : scopes.slice(0, i + 1);
        const expected = projectRuleCell(snap, path, levels[i].scope, levels[i].agentId, kind, now);
        assert.deepEqual(c.cell(levels, i, kind), expected, `seed=${seed} row=${i} kind=${kind}`);
      }
      const mask = columnsOf(effectiveMask(snap, 'fixture-agent', maskOf(ACCESS_COLUMNS, ACCESS_COLUMNS), 'fixture', now));
      for (const kind of ACCESS_COLUMNS) {
        const cell = projectRuleCell(snap, scopes, scopes[2], 'fixture-agent', kind, now);
        assert.equal(cell.read, mask.read.includes(kind));
        assert.equal(cell.write, mask.write.includes(kind));
      }
      // A displayed allow cannot bypass own grants: the runtime's empty own mask stays denied.
      assert.deepEqual(columnsOf(effectiveMask(snap, 'fixture-agent', 0, 'fixture', now)), { read: [], write: [] });
    } finally { c.dispose(); }
  }
});
test('optimistic cell draft agrees with backend simulation without granting authority or saving policy', async () => {
  const snap = snapshot(42), c = await controller(snap);
  try {
    const before = c.cell(levels, 3, 'project');
    c.cycle(levels[3], 'project', before);
    const changes = c.getSnapshot().changes;
    const after = simulate(snap, parseAccessChanges(changes, now), 'fixture', now);
    assert.deepEqual(c.cell(levels, 3, 'project'), projectRuleCell(after, scopes, scopes[2], 'fixture-agent', 'project', now));
    assert.equal(snap.version, 42);
    assert.equal(c.getSnapshot().preview, null);
  } finally { c.dispose(); }
});
