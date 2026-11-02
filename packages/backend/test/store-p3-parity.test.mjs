// STORE-MAP-01 P3: the shared departments scenario on SQLite. The same scenario runs on
// PostgreSQL in test/pg-store-p3.integration.test.mjs (scripts/pg/integration.sh).
// Run: node --import tsx --test test/store-p3-parity.test.mjs
import test from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p3-parity-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.GIRRU_STORE_P3 = '1';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
await getDatabase().initialize();
const { q } = await import(join(backendDir, 'src/repositories/sql-steps.ts'));
const { runDepartmentScenario } = await import(join(backendDir, 'test/fixtures/store-p3-scenario.mjs'));
await q.run(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES ('par-owner', 'par@example.test', 'par', 'x', 'owner', 'active', 1)`);

test('departments scenario (SQLite)', async () => {
  await runDepartmentScenario({
    q, owner: 'par-owner', tag: 'sq',
    deps: await import(join(backendDir, 'src/services/departments.ts')),
    store: await import(join(backendDir, 'src/memory/scopes/store.ts')),
    lifecycle: await import(join(backendDir, 'src/memory/scopes/lifecycle.ts')),
  });
});
