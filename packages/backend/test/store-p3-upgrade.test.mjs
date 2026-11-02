// STORE-MAP-01 P3: upgrade from released databases (1.3.2 and 1.4.1).
// Each fixture (test/fixtures/upgrade, made by scripts/store-p3/make-upgrade-fixtures.mjs
// from the release tags, synthetic data only) is loaded into a throwaway file, upgraded by this
// build's start-up, then the P3 backfill runs twice. Nothing may be lost, the file must stay sound,
// the one list of departments must be complete and the second run must change nothing.
// Run: node --import tsx --test test/store-p3-upgrade.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const backendDir = process.cwd();
const fixtures = join(backendDir, 'test/fixtures/upgrade');
const migrations = readdirSync(join(backendDir, 'src/db/migrations')).filter((f) => f.endsWith('.sql'));
const ids = new Set(migrations.map((f) => f.split('_')[0]));

for (const file of ['girru-1.3.2.sql', 'girru-1.4.1.sql']) {
  test(`upgrade from ${file}`, () => {
    const out = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', join(fixtures, 'upgrade-child.mjs'), join(fixtures, file), backendDir], { encoding: 'utf8', cwd: backendDir, maxBuffer: 16 << 20 }).trim().split('\n').pop());
    assert.equal(out.integrity, 'ok');
    assert.equal(out.after.memories, out.before.memories, 'no memory lost');
    assert.deepEqual(out.memoryIds, ['fx-m1', 'fx-m2', 'fx-m3', 'fx-m4']);
    assert.ok(out.after.agents >= out.before.agents, 'no agent lost');
    assert.equal(out.after.migrations, ids.size, 'every migration of this build is applied once');
    const names = out.departments.map((d) => d.name);
    for (const n of ['Engineering', 'Marketing', 'People and hiring']) assert.ok(names.includes(n), `${n} in the one list`);
    assert.equal(new Set(out.departments.map((d) => d.norm_name)).size, out.departments.length, 'one department per name');
    for (const a of out.agentDepartments.filter((x) => x.department)) assert.ok(a.department_id, `${a.id} has its department id`);
    assert.deepEqual(out.verify, []);
    assert.deepEqual(out.sync2, { copied: 0, created: 0, filled: 0, questions: 0 }, 'the backfill is idempotent');
    if (file.includes('1.4')) {
      assert.equal(out.departments.find((d) => d.norm_name === 'engineering').id, 'dept-fx1', 'memory\'s department keeps its id');
      assert.deepEqual(out.questions, ['designers']);
    }
  });
}
