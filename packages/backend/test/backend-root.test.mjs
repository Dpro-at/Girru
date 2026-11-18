// MACAPP-01: parts that ship with the program (extensions, skills) are found next to
// it, not in the working folder. The installed app starts the backend with the data
// folder's parent as working folder; Telegram and Discord (then separate extensions) failed to load because of it.
// Run: node --import tsx --test test/backend-root.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backendDir = process.cwd();

test('extensions and skills come from the program folder, whatever the working folder is', async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'ap-backend-root-'));
  process.chdir(elsewhere);
  try {
    const { BACKEND_ROOT, backendPath } = await import(join(backendDir, 'src/config/backend-root.ts'));
    assert.equal(BACKEND_ROOT, backendDir);
    assert.equal(existsSync(backendPath('extensions','agent-connect')),false,'the channel app no longer ships with the program');
    assert.ok(existsSync(backendPath('extensions','shared','channel-host.js')),'the small channel integration host stays with the program');
    assert.ok(existsSync(backendPath('skills', 'dpro-workspace', 'SKILL.md')), 'the shipped skills');
    const { ExtensionRunner } = await import(join(backendDir, 'src/plugins/extension-runner.ts'));
    assert.equal(new ExtensionRunner().extensionsDir, backendPath('extensions'));
  } finally { process.chdir(backendDir); }
});

test('no code reads shipped parts from the working folder', () => {
  for (const file of ['src/plugins/extension-runner.ts', 'src/plugins/manager.ts', 'src/api/routes/extensions.ts', 'src/middleware/extension-permissions.ts', 'src/api/startup.ts']) {
    const src = readFileSync(join(backendDir, file), 'utf8');
    assert.doesNotMatch(src, /['"]\.\/(extensions|skills|plugins)['"]/, file);
  }
});
