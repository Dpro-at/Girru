// STORE-MAP-01 P7 (GIRRU_STORE_P7), SEC2-4: an optional user-level agent file for Claude Code,
// ~/.claude/agents/girru-<name>.md, generated from the agent's package:
//  - preview first, write with the preview's hash, into the home folder only (never a project);
//  - the file holds name, description, personality and instructions, never memory or secrets;
//  - a file that is not Girru's is never changed or removed; remove takes only Girru's file;
//  - P7 off: the routes answer 404.
// Run: node --import tsx --test test/store-p7-user-export.test.mjs
// Throwaway DB/keys/home; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { clearEnv } from './helpers/switches.mjs';
const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-store-p7-uexp-'));
mkdirSync(join(dir, '.data', 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
for (const k of ['GIRRU_STORE_P5', 'GIRRU_STORE_P6', 'GIRRU_STORE_P7']) clearEnv(k);
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.info = quiet; console.warn = quiet; console.error = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await import(join(backendDir, 'src/credentials/storage.ts'));
await getCredentialStorage().initialize();
const OWNER = 'ux-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, 'ux@example.test', 'ux', 'x', 'owner', 'active', 1)`).run(OWNER);
db.prepare(`INSERT INTO agents_config (id, name, description, provider, model, is_primary, department, role, system_prompt) VALUES
  ('ux-sara', 'Sara Builder', 'Builds the backend', 'ollama', 'qwen-test', 0, 'development', 'specialist', 'Write tests first. Token ghp_abcdefghijklmnopqrstuvwxyz0123456789')`).run();
const home = mkdtempSync(join(dir, 'home-'));
const projectFolder = mkdtempSync(join(dir, 'proj-'));

const ux = await import(join(backendDir, 'src/services/agent-user-export.ts'));
const { setBridgeEnv } = await import(join(backendDir, 'src/memory/bridge/service.ts'));
const { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts'));
const { buildServer } = await import(join(backendDir, 'src/api/app.ts'));
setBridgeEnv({ home, env: {} });
const app = await buildServer({ logger: false });
await app.ready();
const call = (method, url, payload) => app.inject({ method, url, headers: { authorization: `Bearer ${generateToken(OWNER, 1)}` }, ...(payload ? { payload } : {}) });
const on = async (fn) => { process.env.GIRRU_STORE_P7 = '1'; try { return await fn(); } finally { process.env.GIRRU_STORE_P7 = '0'; } };
const FILE = join(home, '.claude', 'agents', 'girru-sara-builder.md');

test('P7 off: the routes answer 404', async () => {
  assert.equal((await call('GET', '/api/agents/ux-sara/user-export')).statusCode, 404);
  assert.equal((await call('POST', '/api/agents/ux-sara/user-export', { previewHash: 'x', confirm: true })).statusCode, 404);
});

test('preview -> apply writes ~/.claude/agents/girru-<name>.md only; no secret, no memory', async () => {
  await on(async () => {
    const p = (await call('GET', '/api/agents/ux-sara/user-export')).json();
    assert.equal(p.action, 'create');
    assert.equal(p.file, '~/.claude/agents/girru-sara-builder.md');
    assert.ok(!existsSync(FILE), 'the preview writes nothing');
    assert.equal((await call('POST', '/api/agents/ux-sara/user-export', { previewHash: 'stale', confirm: true })).statusCode, 409);
    assert.equal((await call('POST', '/api/agents/ux-sara/user-export', { previewHash: p.previewHash })).statusCode, 400);
    const r = await call('POST', '/api/agents/ux-sara/user-export', { previewHash: p.previewHash, confirm: true });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().action, 'unchanged');
    const text = readFileSync(FILE, 'utf8');
    assert.match(text, /^---\nname: girru-sara-builder\ndescription: "Builds the backend"\n---\n<!-- girru:agent id=ux-sara package=[a-f0-9]{16} /);
    assert.match(text, /Write tests first\./);
    assert.ok(!text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'the secret never reaches the file');
    assert.deepEqual(readdirSync(projectFolder), [], 'nothing goes into a project folder');
  });
});

test('an owner file of the same name is never changed or removed', async () => {
  await on(async () => {
    writeFileSync(FILE, '---\nname: girru-sara-builder\n---\nMy own agent.\n');
    const p = await ux.userExportPreview('ux-sara', 'claude-code', home);
    assert.equal(p.action, 'conflict');
    await assert.rejects(ux.userExportApply('ux-sara', { previewHash: p.previewHash, confirm: true }, home), (e) => e.code === 'conflict');
    await assert.rejects(ux.userExportRemove('ux-sara', 'claude-code', home), (e) => e.code === 'not_girru');
    assert.equal(readFileSync(FILE, 'utf8'), '---\nname: girru-sara-builder\n---\nMy own agent.\n');
  });
});

test('a link in place of the file is refused', async () => {
  await on(async () => {
    const real = join(dir, 'elsewhere.md');
    writeFileSync(real, 'x');
    const { rmSync } = await import('node:fs');
    rmSync(FILE);
    symlinkSync(real, FILE);
    const p = await ux.userExportPreview('ux-sara', 'claude-code', home);
    assert.equal(p.action, 'conflict');
    assert.equal(readFileSync(real, 'utf8'), 'x');
    rmSync(FILE);
  });
});

test('remove takes Girru\'s file only; unknown tool is refused', async () => {
  await on(async () => {
    const p = await ux.userExportPreview('ux-sara', 'claude-code', home);
    await ux.userExportApply('ux-sara', { previewHash: p.previewHash, confirm: true }, home);
    assert.ok(existsSync(FILE));
    const r = await call('DELETE', '/api/agents/ux-sara/user-export');
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().removed, true);
    assert.ok(!existsSync(FILE));
    assert.equal((await call('GET', '/api/agents/ux-sara/user-export?tool=vim')).statusCode, 400);
    assert.equal((await call('GET', '/api/agents/nope/user-export')).statusCode, 404);
  });
});

test('names: ASCII slug, or the id when no letters are left', () => {
  assert.equal(ux.userExportName('Sara Builder', 'a1'), 'girru-sara-builder');
  assert.equal(ux.userExportName('Café Ünal', 'a1'), 'girru-cafe-unal');
  assert.equal(ux.userExportName('سارة', 'Ab-12_cd'), 'girru-agent-ab12cd');
});
