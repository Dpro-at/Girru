import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src/', import.meta.url));
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
}
test('agent domain cannot import HTTP routes or the web framework', () => {
  for (const file of sources(join(root, 'agent'))) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /(?:from\s*|import\s*\()(['"])(?:[^'"]*\/api\/|fastify)/, file);
  }
});
test('chat HTTP adapter contains admission and projection, no inference or tool execution', () => {
  const source = readFileSync(join(root, 'api/routes/chat.ts'), 'utf8');
  assert.doesNotMatch(source, /ClaudeClient|runOllamaAgentLoop|runLmStudioAgentLoop|createAgentToolsRegistry|\/api\/chat['"]\s*,\s*\{\s*method/);
  assert.match(source, /authenticateActiveUser/);
  assert.match(source, /beginChatTurn/);
  assert.match(source, /vaultChatFrames/);
  assert.match(source, /agent\/public/);
});
test('public execution refuses unknown strategies without importing a driver', async () => {
  const { executeAgent } = await import('../src/agent/execution/runtime.ts');
  await assert.rejects(executeAgent({ strategy: 'unknown' }), /unsupported_execution_strategy/);
});

test('public boundary import does not create a data/config directory or start a runtime', async () => {
  const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'core-public-import-'));
  try {
    const entry = new URL('../src/agent/public.ts', import.meta.url).href;
    execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', `await import(${JSON.stringify(entry)});`], {
      cwd: dir, timeout: 10000,
      env: { ...process.env, HOME: dir, USERPROFILE: dir, DATABASE_PATH: join(dir, 'fixture.db'), AGENT_PLAYER_CONFIG_DIR: join(dir, 'config'), AGENT_PLAYER_DB: 'sqlite' },
    });
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('backend checked-event sequence wins over frame fields and frontend retains only reviewed data', async () => {
  const { runEventWire } = await import('../src/agent/contracts/events.ts');
  const { projectRunEvent } = await import('../../core-ui/src/conversation-contract.js');
  const event = { seq: 7, frame: { type: 'text', content: 'Hello', seq: 999, ownerId: 'private-fixture' } };
  const projected = projectRunEvent(runEventWire(event));
  assert.equal(projected.seq, 7);
  assert.equal(projected.content, 'Hello');
  assert.equal(projected.ownerId, undefined);
  assert.equal(event.frame.seq, 999);
});
