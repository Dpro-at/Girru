// STORE-MAP-01 P3 parity: ONE departments scenario run on SQLite (test/store-p3-parity.test.mjs)
// and on PostgreSQL (test/pg-store-p3.integration.test.mjs). Both drivers must give the same
// snapshot after every step; the steps use only the driver-neutral SQL helpers and services.
import assert from 'node:assert/strict';

export async function runDepartmentScenario({ q, deps, store, lifecycle, owner, tag }) {
  const id = (s) => `${s}-${tag}`;
  const rows = (s, ...a) => q.all(s, ...a);
  const one = async (s, ...a) => (await q.all(s, ...a))[0];
  // Today's data, made while the switch is off.
  process.env.GIRRU_STORE_P3 = '0';
  const mem = await store.createDepartment(owner, 'Engineering', owner);
  await q.run(`INSERT INTO memory_project_scopes (owner_id, slug, name, department_id) VALUES (?, ?, 'Alpha', ?)`, owner, id('alpha'), mem.id);
  for (const [a, n, d] of [['omar', 'Omar', 'engineering'], ['nora', 'Nora', 'marketing'], ['lina', 'Lina', 'hr']]) {
    await q.run(`INSERT INTO agents_config (id, name, provider, model, department) VALUES (?, ?, 'ollama', 'm', ?)`, id(a), `${n} ${tag}`, d);
  }
  await q.run(`INSERT INTO boards (id, owner_id, name) VALUES (?, ?, 'Board')`, id('b'), owner);
  await q.run(`INSERT INTO board_departments (board_id, department) VALUES (?, 'engineering'), (?, 'marketing')`, id('b'), id('b'));
  await q.run(`INSERT INTO agent_rules (id, text, who, targets) VALUES (?, 'r', 'departments', '["engineering"]'), (?, 'r', 'departments', '["marketing","designers"]')`, id('r1'), id('r2'));

  const snap = async () => ({
    deps: (await rows('SELECT name, norm_name FROM departments WHERE owner_id = ? ORDER BY norm_name', owner)).map((d) => `${d.name}|${d.norm_name}`),
    agents: (await rows('SELECT a.id, a.department, d.norm_name FROM agents_config a LEFT JOIN departments d ON d.id = a.department_id WHERE a.id LIKE ? ORDER BY a.id', `%-${tag}`)).map((r) => `${r.id.replace(`-${tag}`, '')}|${r.department}|${r.norm_name}`),
    boards: (await rows('SELECT department FROM board_departments WHERE board_id = ? ORDER BY department', id('b'))).map((r) => r.department),
    rules: (await rows('SELECT id, targets, paused FROM agent_rules WHERE id LIKE ? ORDER BY id', `%-${tag}`)).map((r) => `${r.id.replace(`-${tag}`, '')}|${r.targets}|${Number(r.paused)}`),
    project: (await one('SELECT department_id FROM memory_project_scopes WHERE owner_id = ? AND slug = ?', owner, id('alpha'))).department_id === mem.id,
  });

  process.env.GIRRU_STORE_P3 = '1';
  const r1 = await deps.syncDepartments(owner);
  assert.deepEqual(r1, { copied: 1, created: 2, filled: 7, questions: 1 });
  assert.deepEqual(await snap(), {
    deps: ['Engineering|engineering', 'People and hiring|hr', 'Marketing|marketing'],
    agents: ['lina|hr|hr', 'nora|marketing|marketing', 'omar|engineering|engineering'],
    boards: ['engineering', 'marketing'],
    rules: ['r1|["engineering"]|0', 'r2|["marketing","designers"]|0'],
    project: true,
  });
  assert.deepEqual(await deps.syncDepartments(owner), { copied: 0, created: 0, filled: 0, questions: 0 });

  await store.renameDepartment(owner, mem.id, 'Platform');
  const mkt = await one("SELECT id FROM departments WHERE owner_id = ? AND norm_name = 'marketing'", owner);
  const { mergeId } = await deps.mergeDepartments(owner, mkt.id, mem.id, owner);
  assert.deepEqual(await snap(), {
    deps: ['People and hiring|hr', 'Platform|platform'],
    agents: ['lina|hr|hr', 'nora|platform|platform', 'omar|platform|platform'],
    boards: ['platform'],
    rules: ['r1|["platform"]|0', 'r2|["platform","designers"]|0'],
    project: true,
  });
  await deps.undoMerge(owner, mergeId);
  const restored = await snap();
  assert.deepEqual(restored.boards, ['marketing', 'platform']);
  assert.deepEqual(restored.agents, ['lina|hr|hr', 'nora|marketing|marketing', 'omar|platform|platform']);

  const preview = await lifecycle.previewDeleteDepartment(owner, mkt.id);
  await lifecycle.deleteDepartment(owner, mkt.id, preview.previewHash);
  const final = await snap();
  assert.deepEqual(final.agents, ['lina|hr|hr', 'nora|null|null', 'omar|platform|platform']);
  assert.deepEqual(final.rules, ['r1|["platform"]|0', 'r2|["designers"]|0']);
  assert.deepEqual(await rows('SELECT COUNT(*) AS n FROM department_merges WHERE owner_id = ? AND undone_at IS NOT NULL', owner).then((r) => Number(r[0].n)), 1);
  return final;
}
