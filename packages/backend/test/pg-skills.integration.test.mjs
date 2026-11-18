// B2.2d-5: the skills-marketplace scenario (test/fixtures/skills-scenario.mjs)
// on PostgreSQL: the Anthropic skills service (GitHub fetch stubbed, no
// network) and the marketplace DB routes (behind the auth gate).
// Runs ONLY when AGENT_PLAYER_PG_TEST_URL names a THROWAWAY database on
// 127.0.0.1 that the PostgreSQL runner has already migrated (it writes test
// rows and never cleans up: drop the database afterwards). Otherwise every
// test skips. scripts/pg/integration.sh runs it.
//
// The SQLite file (a temp file, never the real .data) is watched: any
// skills statement that reaches SQLite fails the last test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { skillsScenario } from './fixtures/skills-scenario.mjs';

// The legacy marketplace code path, reachable while GIRRU_STORE_P4 is off (as in skills-marketplace.test.mjs);
// with P4 on the routes answer 410 (store-p4-marketplace.test.mjs).
process.env.GIRRU_STORE_P4 = '0';
const URL_ = process.env.AGENT_PLAYER_PG_TEST_URL;
const skip = URL_ ? false : 'AGENT_PLAYER_PG_TEST_URL is not set (PostgreSQL integration test)';
const sqliteHits = [];

let ctx = {};
let dir;
let closeAll = async () => {};
if (URL_) {
  dir = mkdtempSync(join(tmpdir(), 'ap-pg-skills-'));
  mkdirSync(join(dir, '.data'), { recursive: true });
  process.chdir(dir);
  process.env.HOME = dir;
  // SQLite still backs the modules that are not ported yet: a temp file, never the real .data.
  process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
  process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
  process.env.AGENT_PLAYER_DB = 'postgres';
  process.env.AGENT_PLAYER_PG_URL = URL_;

  const quiet = { log: console.log, info: console.info };
  console.log = () => {}; console.info = () => {};
  const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
  await getDatabase({ path: process.env.DATABASE_PATH }).initialize(); // B2.2d-17: an explicit temp SQLite file, watched for strays
  const mgr = getDatabase();
  for (const target of [mgr, mgr.getDb()]) {
    const original = target.prepare;
    target.prepare = function (sql) {
      if (/\b(installed_skills|skill_sources|skill_usage_log)\b/i.test(String(sql))) sqliteHits.push(String(sql).replace(/\s+/g, ' ').slice(0, 120));
      return original.call(this, sql);
    };
  }
  const pool = await import('../src/db/pg/pool.ts');
  const { default: Fastify } = await import('fastify');
  const { registerAuthGate } = await import('../src/auth/auth-gate.ts');
  const { generateToken } = await import('../src/auth/jwt.ts');
  const { skillsRoutes } = await import('../src/api/routes/skills.ts');
  const app = Fastify();
  registerAuthGate(app);
  await app.register(skillsRoutes);
  await app.ready();
  ctx = {
    app,
    q: (await import('../src/repositories/sql-steps.ts')).q,
    auth: (id) => ({ authorization: `Bearer ${generateToken(id, 1)}` }),
    svc: (await import('../src/services/anthropic-skills-service.ts')).anthropicSkillsService,
  svc: (await import('../src/services/anthropic-skills-service.ts')).anthropicSkillsService,
  };
  closeAll = async () => {
    await app.close();
    Object.assign(console, quiet);
    await pool.closePgPool();
    closeDatabase();
  };
}

skillsScenario(test, () => ctx, { tag: randomBytes(4).toString('hex'), skip });

test('no skills statement reached SQLite', { skip }, () => {
  assert.deepEqual(sqliteHits, []);
});

test.after(async () => {
  await closeAll();
  if (dir) {
    process.chdir('/');
    rmSync(dir, { recursive: true, force: true });
  }
});
