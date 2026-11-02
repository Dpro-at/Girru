// STORE-MAP-01 P3 upgrade check, one fixture per process (the database is a
// process-wide singleton). Loads a released schema + synthetic data, runs this
// build's start-up (schema.sql + pending migrations) on it, then the P3 backfill,
// and prints what it found as JSON. Used by test/store-p3-upgrade.test.mjs.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const [fixture, backendDir] = process.argv.slice(2);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-p3-upgrade-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
globalThis.fetch = async (url) => { throw new Error(`unexpected network call: ${url}`); };
const log = console.log.bind(console);
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const seed = new Database(process.env.DATABASE_PATH);
seed.exec(readFileSync(fixture, 'utf8'));
const count = (d, t) => d.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
const before = { memories: count(seed, 'memories'), agents: count(seed, 'agents_config'), migrations: count(seed, 'migrations') };
seed.close();

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const q = (s, ...a) => db.prepare(s).all(...a);
process.env.GIRRU_STORE_P3 = '1';
const deps = await import(join(backendDir, 'src/services/departments.ts'));
const { sql } = await import(join(backendDir, 'src/repositories/sql-steps.ts'));
const sync1 = await deps.syncDepartments();
const sync2 = await deps.syncDepartments();
const out = {
  before,
  after: { memories: q('SELECT COUNT(*) AS n FROM memories')[0].n, agents: q('SELECT COUNT(*) AS n FROM agents_config')[0].n, migrations: q('SELECT COUNT(*) AS n FROM migrations')[0].n },
  memoryIds: q('SELECT id FROM memories ORDER BY id').map((r) => r.id),
  integrity: q('PRAGMA integrity_check')[0].integrity_check,
  departments: q("SELECT id, name, norm_name FROM departments WHERE owner_id = 'fx-owner' ORDER BY norm_name"),
  agentDepartments: q('SELECT id, department, department_id FROM agents_config ORDER BY id'),
  verify: await sql().read(deps.verifyDepartmentsStep('fx-owner')),
  questions: (await deps.openDepartmentQuestions('fx-owner')).map((x) => x.name),
  sync1, sync2,
};
log(JSON.stringify(out));
process.exit(0);
