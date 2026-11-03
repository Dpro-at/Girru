// STORE-MAP-01 P7 (GIRRU_STORE_P7), A7 / S9 / OPS8: Cursor and GitHub Copilot CLI in the memory bridge.
//  - off: neither is a client (status lists the four, the API refuses them);
//  - one test per format: Cursor ~/.cursor/mcp.json and Copilot ~/.copilot/mcp-config.json get Girru's
//    server next to the user's own, with no token or secret; undo restores the file byte for byte;
//  - turning a tool off removes only Girru's entry (the user's servers stay); clean up does it for all;
//  - tool configs go through the safe file writer: a linked config is refused;
//  - the project layout adds .cursor/rules/girru.mdc while Cursor is on.
// Run: node --import tsx --test test/store-p7-clients.test.mjs
// Throwaway HOME/DB, random test-only secrets, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-store-p7-clients-')));
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_CONFIG_DIR = join(dir, 'cli-config');
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
process.env.MEMORY_EMBEDDINGS = 'hash';
process.env.MEMORY_GRAPH_MODEL = 'off';
for (const k of ['GIRRU_STORE_P2', 'GIRRU_STORE_P6', 'GIRRU_STORE_P7', 'GIRRU_STORE_PILOT']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.info = quiet; console.warn = quiet;

const { getDatabase } = await load('src/db/database.ts');
const db = getDatabase();
await db.initialize();
const { getCredentialStorage } = await load('src/credentials/storage.ts');
await getCredentialStorage().initialize();
const OWNER = 'p7c-owner';
db.prepare(`INSERT INTO users (id, email, username, password_hash, role, status, email_verified) VALUES (?, ?, ?, 'x', 'owner', 'active', 1)`).run(OWNER, `${OWNER}@example.test`, OWNER);
const svc = await load('src/memory/bridge/service.ts');
const { isBridgeClient } = await load('src/memory/bridge/clients.ts');
const { createProject } = await load('src/repositories/chat-conversations.ts');
const { layoutPreview, layoutApply, CURSOR_RULE, CURSOR_RULE_TEXT } = await load('src/memory/bridge/layout.ts');
svc.setBridgeEnv({ home: dir, env: {} });

const on = async (fn, extra = {}) => {
  const keys = { GIRRU_STORE_P7: '1', ...extra };
  for (const [k, v] of Object.entries(keys)) process.env[k] = v;
  try { return await fn(); } finally { for (const k of Object.keys(keys)) delete process.env[k]; }
};
const SECRETS = /token|secret|password|bearer|api[_-]?key/i;
const register = async (client) => {
  const preview = await svc.registrationPreview(OWNER, client);
  return svc.registrationApply(OWNER, client, { previewHash: preview.previewHash, confirm: true });
};

test('off: Cursor and Copilot are not clients', async () => {
  assert.equal(isBridgeClient('cursor'), false);
  assert.deepEqual((await svc.bridgeStatus(OWNER)).clients.map((c) => c.client), ['claude-code', 'codex', 'gemini-cli', 'antigravity']);
  await assert.rejects(svc.registrationPreview(OWNER, 'cursor'), (e) => e.status === 400);
  await on(async () => {
    assert.equal(isBridgeClient('copilot'), true);
    assert.deepEqual((await svc.bridgeStatus(OWNER)).clients.map((c) => c.client).slice(4), ['cursor', 'copilot']);
  });
});

for (const [client, file, check] of [
  ['cursor', '.cursor/mcp.json', (e) => assert.ok(e.command && Array.isArray(e.args) && e.env && !e.type)],
  ['copilot', '.copilot/mcp-config.json', (e) => { assert.equal(e.type, 'local'); assert.deepEqual(e.tools, ['*']); assert.ok(e.command && e.env); }],
]) {
  test(`${client}: Girru's server next to the user's own, no secret; undo restores byte for byte`, async () => {
    const path = join(dir, file);
    mkdirSync(join(path, '..'), { recursive: true });
    const original = '{\n  "mcpServers": {\n    "mine": { "command": "my-server" }\n  }\n}\n';
    writeFileSync(path, original);
    await on(async () => {
      const r = await register(client);
      assert.equal(r.preview.action, 'update');
      const cfg = JSON.parse(readFileSync(path, 'utf8'));
      assert.deepEqual(cfg.mcpServers.mine, { command: 'my-server' });
      check(cfg.mcpServers['dpro-memory']);
      assert.doesNotMatch(JSON.stringify(cfg.mcpServers['dpro-memory'].env), SECRETS);
      assert.equal((await svc.bridgeStatus(OWNER)).clients.find((c) => c.client === client).enabled, true);
      const u = await svc.registrationUndo(OWNER, r.registration.id);
      assert.equal(u.mode, 'restored');
      assert.equal(readFileSync(path, 'utf8'), original);
    });
  });
}

test('OPS8: turning a tool off removes only Girru\'s entry; clean up does it for every tool', async () => {
  await on(async () => {
    const cursor = join(dir, '.cursor/mcp.json');
    await register('cursor');
    // The user adds a server after Girru wrote the file: undo keeps it.
    const cfg = JSON.parse(readFileSync(cursor, 'utf8'));
    cfg.mcpServers.later = { command: 'later' };
    writeFileSync(cursor, JSON.stringify(cfg, null, 2) + '\n');
    const off = await svc.setClient(OWNER, 'cursor', false);
    assert.deepEqual([off.enabled, off.undone, off.failed], [false, 1, []]);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(cursor, 'utf8')).mcpServers).sort(), ['later', 'mine']);
    await register('cursor');
    await register('copilot');
    const clean = await svc.cleanUpTools(OWNER);
    assert.deepEqual(clean.undone.map((u) => u.client).sort(), ['copilot', 'cursor']);
    assert.equal(clean.failed.length, 0);
    for (const f of ['.cursor/mcp.json', '.copilot/mcp-config.json']) assert.equal(JSON.parse(readFileSync(join(dir, f), 'utf8')).mcpServers['dpro-memory'], undefined);
  });
  await assert.rejects(svc.cleanUpTools(OWNER), (e) => e.code === 'p7_off');
});

test('a linked tool config is refused by the safe file writer', async () => {
  const real = join(dir, 'elsewhere.json');
  writeFileSync(real, '{}\n');
  mkdirSync(join(dir, '.copilot'), { recursive: true });
  const linked = join(dir, '.copilot', 'mcp-config.json');
  writeFileSync(linked, '');
  const { rmSync } = await import('node:fs');
  rmSync(linked);
  symlinkSync(real, linked);
  await on(async () => {
    const p = await svc.registrationPreview(OWNER, 'copilot');
    assert.equal(p.action, 'conflict');
    await assert.rejects(svc.registrationApply(OWNER, 'copilot', { previewHash: p.previewHash, confirm: true }), (e) => e.status === 409);
  });
  assert.equal(readFileSync(real, 'utf8'), '{}\n');
  rmSync(linked);
});

test('layout: .cursor/rules/girru.mdc while Cursor is on', async () => {
  const folder = join(dir, 'proj');
  mkdirSync(join(folder, '.git', 'info'), { recursive: true });
  const project = await createProject(OWNER, { name: 'Proj', folder });
  await on(async () => {
    await svc.setClient(OWNER, 'cursor', false);
    assert.equal((await layoutPreview(OWNER, project.id)).files.some((f) => f.relative === CURSOR_RULE), false);
    await svc.setClient(OWNER, 'cursor', true);
    const p = await layoutPreview(OWNER, project.id);
    assert.equal(p.files.find((f) => f.relative === CURSOR_RULE)?.action, 'create');
    await layoutApply(OWNER, project.id, { previewHash: p.previewHash, confirm: true });
    assert.equal(readFileSync(join(folder, CURSOR_RULE), 'utf8'), CURSOR_RULE_TEXT);
    assert.match(CURSOR_RULE_TEXT, /alwaysApply: true/);
    assert.equal((await layoutPreview(OWNER, project.id)).files.find((f) => f.relative === CURSOR_RULE).action, 'unchanged');
  }, { GIRRU_STORE_P2: '1' });
  assert.ok(existsSync(join(folder, 'AGENTS.md')));
});
