// B2.2d-5 (SQLite): the Anthropic skills service (GitHub fetch stubbed, no
// network) and the skills marketplace DB routes on the async driver API.
// The PostgreSQL side: test/pg-skills.integration.test.mjs.
// Scenario: test/fixtures/skills-scenario.mjs.
// Run: node --import tsx --test test/skills-marketplace.test.mjs
// Throwaway DB + cwd, random test-only secrets, no network.
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { skillsScenario } from './fixtures/skills-scenario.mjs';

const dir = mkdtempSync(join(tmpdir(), 'ap-skills-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
delete process.env.AGENT_PLAYER_DB;
// The legacy marketplace code path, reachable while GIRRU_STORE_P4 is off; with P4 on the routes answer 410
// retired (test/store-p4-marketplace.test.mjs, test/skills-auth.test.mjs).
delete process.env.GIRRU_STORE_P4;

const quiet = { log: console.log, info: console.info };
console.log = () => {}; console.info = () => {};
const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
await getDatabase().initialize();
const { default: Fastify } = await import('fastify');
const { registerAuthGate } = await import('../src/auth/auth-gate.ts');
const { generateToken } = await import('../src/auth/jwt.ts');
const { skillsRoutes } = await import('../src/api/routes/skills.ts');
const app = Fastify();
registerAuthGate(app);
await app.register(skillsRoutes);
await app.ready();
const ctx = {
  app,
  q: (await import('../src/repositories/sql-steps.ts')).q,
  auth: (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` }),
  svc: (await import('../src/services/anthropic-skills-service.ts')).anthropicSkillsService,
};

skillsScenario(test, () => ctx, { tag: randomBytes(4).toString('hex') });

test.after(async () => {
  await app.close();
  Object.assign(console, quiet);
  closeDatabase();
  process.chdir('/');
  rmSync(dir, { recursive: true, force: true });
});
