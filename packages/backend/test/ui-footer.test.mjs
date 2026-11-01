// SH3: footer choices per person. Throwaway DB, test-only secrets, no network.
// Run: node --import tsx --test test/ui-footer.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-footer-'));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
const quiet = { log: console.log, warn: console.warn };
console.log = () => {}; console.warn = () => {};

const { getDatabase, closeDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const addUser = (id, role) => db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status) VALUES (?, ?, ?, 'x', ?, 'active')`).run(id, `${id}@example.test`, id, role);
addUser('ft-owner', 'owner');
addUser('ft-user', 'user');
const { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts'));
const { uiFooterRoutes } = await import(join(backendDir, 'src/api/routes/ui-footer.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { default: Fastify } = await import('fastify');
const app = Fastify();
registerAuthGate(app);
await app.register(uiFooterRoutes);
await app.ready();
console.log = quiet.log; console.warn = quiet.warn;
test.after(async () => { await app.close(); closeDatabase(); rmSync(dir, { recursive: true, force: true }); });
const call = (method, who, payload) => app.inject({ method, url: '/api/me/footer', headers: who ? { authorization: `Bearer ${generateToken(who, 1)}` } : {}, payload });

test('footer: usual footer first, each person saves their own, unknown values refused', async () => {
  assert.equal((await call('GET')).statusCode, 401);
  const first = (await call('GET', 'ft-owner')).json().footer;
  assert.deepEqual(first.order.slice(0, 7), ['chat', 'agents', 'library', 'board', 'memory', 'approvals', 'store']);
  assert.ok(first.hidden.includes('skills') && !first.hidden.includes('chat') && !first.hidden.includes('library'));
  assert.ok(!first.order.includes('mcp'));
  assert.equal(first.approvalsWhenWaiting, true);
  const saved = await call('PUT', 'ft-owner', { hidden: ['board'], iconsOnly: true });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().footer.hidden, ['board']);
  assert.equal((await call('GET', 'ft-owner')).json().footer.iconsOnly, true);
  assert.notDeepEqual((await call('GET', 'ft-user')).json().footer.hidden, ['board']);
  const moved = (await call('PUT', 'ft-owner', { order: ['store', 'chat'] })).json().footer;
  assert.deepEqual(moved.order.slice(0, 2), ['store', 'chat']);
  assert.equal(moved.order.length, 14);
  assert.ok(moved.order.includes('browser'), 'Browser remains available after reordering an older footer');
  assert.equal((await call('PUT', 'ft-owner', { order: ['apps'] })).statusCode, 400, 'SA6: Apps is no footer section any more');
  assert.deepEqual((await import(join(backendDir, 'src/api/routes/ui-footer.ts'))).footerPrefs({ order: ['apps', 'chat'] }).order.slice(0, 2), ['store', 'chat'], 'an older saved Apps place becomes the Store');
  for (const bad of [{}, { hidden: ['settings'] }, { hidden: ['mcp'] }, { hidden: ['chat', 'chat'] }, { order: ['nope'] }, { iconsOnly: 'yes' }, { other: true }, []])
    assert.equal((await call('PUT', 'ft-owner', bad)).statusCode, 400, JSON.stringify(bad));
});

test('footer: an older saved footer gets Library after Agents, shown, and loses MCP connections', async () => {
  const { footerPrefs } = await import(join(backendDir, 'src/api/routes/ui-footer.ts'));
  const old = footerPrefs({ order: ['board', 'chat', 'agents', 'memory', 'approvals', 'apps', 'mcp'], hidden: ['memory', 'mcp'] });
  assert.deepEqual(old.order.slice(0, 4), ['board', 'chat', 'agents', 'library']);
  assert.ok(!old.order.includes('mcp') && !old.hidden.includes('library'));
  assert.deepEqual(old.hidden, ['memory']);
});
