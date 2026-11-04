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
const { backfillProvenance } = await import(join(backendDir, 'src/memory/validity.ts'));
const provenance = { filled: await backfillProvenance(2), again: await backfillProvenance(2) };
// P4 (T7): each agent's PERSONALITY.md text goes into its one personality record, once.
process.env.GIRRU_STORE_P4 = '1';
const firstAgent = q('SELECT id FROM agents_config ORDER BY id LIMIT 1')[0].id;
const files = await import(join(backendDir, 'src/services/agent-files.ts'));
await files.writePersonality(firstAgent, '# Hand-written\nKeep answers short.');
const record = await import(join(backendDir, 'src/services/personality-record.ts'));
const versionsBefore = q('SELECT COUNT(*) AS n FROM agent_personality_versions')[0].n;
const personality = {
  imported: await record.backfillPersonalityRecords(), again: await record.backfillPersonalityRecords(), missing: await record.agentsWithoutRecordText(),
  text: (await record.recordText(firstAgent)).text, versionsBefore, versionsAfter: q('SELECT COUNT(*) AS n FROM agent_personality_versions')[0].n,
};
// P5: each agent's MEMORY.md (with its history) into its own drawer, once.
process.env.GIRRU_STORE_P5 = '1';
const snap = await files.readMemorySnapshot(firstAgent);
await files.writeMemoryCAS(firstAgent, '# Notes\nShip on Fridays.', snap.hash);
const drawer = await import(join(backendDir, 'src/memory/agent-drawer.ts'));
const agentNotes = { imported: await drawer.importAllAgentMemory(), again: await drawer.importAllAgentMemory(), missing: await drawer.agentsWithoutImportedMemory(), text: (await drawer.agentNotes(firstAgent))?.content ?? null };
// P6: expand only (no backfill): new columns start off, no request ids, a change log only where files were on.
process.env.GIRRU_STORE_P6 = '1';
const p6start = await import(join(backendDir, 'src/memory/outbox/p6.ts'));
const p6 = {
  scopes: (await p6start.syncP6Scopes()).length,
  filesOn: q('SELECT COUNT(*) AS n FROM memory_bridge_folders f JOIN chat_projects p ON p.id = f.project_id WHERE f.files_enabled = 1 AND p.folder IS NOT NULL')[0].n,
  companyFacts: q('SELECT COUNT(*) AS n FROM memory_bridge_folders WHERE company_facts <> 0')[0].n,
  requests: q('SELECT COUNT(*) AS n FROM write_requests')[0].n,
  agentColumns: q("SELECT COUNT(*) AS n FROM pragma_table_info('session_capabilities') WHERE name = 'agent_id'")[0].n + q("SELECT COUNT(*) AS n FROM pragma_table_info('memory_bridge_handoffs') WHERE name = 'agent_id'")[0].n,
};
const out = {
  before,
  after: { memories: q("SELECT COUNT(*) AS n FROM memories WHERE COALESCE(drawer_kind, '') <> 'agent'")[0].n, agents: q('SELECT COUNT(*) AS n FROM agents_config')[0].n, migrations: q('SELECT COUNT(*) AS n FROM migrations')[0].n },
  memoryIds: q("SELECT id FROM memories WHERE COALESCE(drawer_kind, '') <> 'agent' ORDER BY id").map((r) => r.id),
  integrity: q('PRAGMA integrity_check')[0].integrity_check,
  departments: q("SELECT id, name, norm_name FROM departments WHERE owner_id = 'fx-owner' ORDER BY norm_name"),
  agentDepartments: q('SELECT id, department, department_id FROM agents_config ORDER BY id'),
  verify: await sql().read(deps.verifyDepartmentsStep('fx-owner')),
  questions: (await deps.openDepartmentQuestions('fx-owner')).map((x) => x.name),
  sync1, sync2, provenance, personality, agentNotes, p6,
  sources: q("SELECT id, source, trust FROM memories WHERE COALESCE(drawer_kind, '') <> 'agent' ORDER BY id"),
};
log(JSON.stringify(out));
process.exit(0);
