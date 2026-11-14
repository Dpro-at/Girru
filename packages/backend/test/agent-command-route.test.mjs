// CP15 (MCP): POST /api/commands/run — the same command rules for agents connected by MCP. Throwaway DB, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-cmd-')));
mkdirSync(join(dir, '.data'), { recursive: true });
const project = join(dir, 'project'); mkdirSync(project);
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.HOME = join(dir, 'home'); mkdirSync(process.env.HOME);
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
const quiet = { log: console.log, warn: console.warn };
console.log = () => {}; console.warn = () => {};

const { getDatabase, closeDatabase } = await import('../src/db/database.ts');
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('cr-owner', 'owner');
addUser('cr-user', 'user');
const { createProject } = await import('../src/repositories/chat-conversations.ts');
const p = await createProject('cr-owner', { name: 'Demo', folder: project });
const { registerAuthGate } = await import('../src/auth/auth-gate.ts');
const { agentCommandRunRoutes, agentCommandsRoutes } = await import('../src/api/routes/ui-footer.ts');
const { generateToken } = await import('../src/auth/jwt.ts');
const { default: Fastify } = await import('fastify');
const app = Fastify();
registerAuthGate(app);
await app.register(agentCommandsRoutes);
await app.register(agentCommandRunRoutes);
await app.ready();
console.log = quiet.log; console.warn = quiet.warn;
test.after(async () => { await app.close(); closeDatabase(); rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const call = (who, payload, url = '/api/commands/run', method = 'POST') => app.inject({ method, url, headers: who ? { authorization: `Bearer ${generateToken(who, 1)}` } : {}, payload });

test('CP15 MCP: off until the owner turns it on; owner only; known commands run, others wait for Run in Approvals', async () => {
  assert.equal((await call(null, { projectId: p.id, command: 'pwd' })).statusCode, 401);
  assert.equal((await call('cr-user', { projectId: p.id, command: 'pwd' })).statusCode, 403);
  assert.equal((await call('cr-owner', { projectId: p.id, command: 'pwd', cwd: '/' })).statusCode, 400);
  assert.equal((await call('cr-owner', { projectId: 'missing', command: 'pwd' })).statusCode, 404);
  assert.equal((await call('cr-owner', { projectId: p.id, command: 'pwd' })).json().code, 'agent_commands_off');
  assert.equal((await call('cr-owner', { on: true }, '/api/me/agent-commands', 'PUT')).statusCode, 200);
  const ran = (await call('cr-owner', { projectId: p.id, command: 'node --version' })).json();
  assert.equal(ran.ran, true); assert.match(ran.output, /v\d+\./);
  const waits = (await call('cr-owner', { projectId: p.id, command: 'rm -rf build' })).json();
  assert.equal(waits.code, 'waiting_for_run'); assert.equal(typeof waits.approvalId, 'string');
  const row = db.prepare('SELECT status, tool_name FROM tool_approvals WHERE id = ?').get(waits.approvalId);
  assert.deepEqual({ ...row }, { status: 'pending', tool_name: 'run_command_owner' });
  // The owner's Run in Approvals runs it in the same project folder.
  const { writeFileSync, existsSync } = await import('node:fs');
  writeFileSync(join(project, 'version'), "require('node:fs').writeFileSync('unexpected.txt', 'executed')");
  const script = (await call('cr-owner', { projectId: p.id, command: 'node version' })).json();
  assert.equal(script.code, 'waiting_for_run', 'a project script is not a version probe');
  assert.equal(existsSync(join(project, 'unexpected.txt')), false, 'no side effects before owner approval');
  writeFileSync(join(project, 'note.txt'), 'x');
  const asked = (await call('cr-owner', { projectId: p.id, command: `node -e "require('node:fs').unlinkSync('note.txt')"` })).json();
  const { approveAndRun } = await import('../src/tools/approvals.ts');
  const hash = db.prepare('SELECT params_hash FROM tool_approvals WHERE id = ?').get(asked.approvalId).params_hash;
  const done = await approveAndRun(asked.approvalId, 'cr-owner', hash);
  assert.equal(done.result.error, undefined, JSON.stringify(done.result));
  assert.equal(existsSync(join(project, 'note.txt')), false);
});
