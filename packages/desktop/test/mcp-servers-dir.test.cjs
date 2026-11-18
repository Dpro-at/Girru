'use strict';
// The desktop gives the backend a folder for local MCP servers beside the data, never inside it.
// Without it the backend's default sat inside the data folder, was refused, and GenVR's MCP showed "blocked".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');

test('main passes MCP_SERVERS_DIR: one folder per workspace under the app folder, beside the data', () => {
  assert.match(main, /extraEnv: \{ MCP_SERVERS_DIR: mcpServersDir\(\),/);
  assert.match(main, /const mcpServersDir = \(\) => path\.join\(settingsDir\(\), 'mcp-servers', path\.basename\(dataDir\(\)\)\);/);
});

test('that folder is accepted by the backend work-dir check, the old default is refused', { skip: !fs.existsSync(path.join(__dirname, '..', '..', 'backend', 'node_modules')) && 'backend packages not installed' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-mcp-dir-'));
  const data = path.join(root, 'workspaces', 'w1'); fs.mkdirSync(data, { recursive: true });
  const run = env => execFileSync(process.execPath, ['--import', 'tsx', '-e', "import('./src/mcp-client/config.ts').then(m=>{try{m.ensureServerWorkDir('genvr-local');console.log('ok')}catch(e){console.log('refused')}})"],
    { cwd: path.join(__dirname, '..', '..', 'backend'), env: { ...process.env, AGENT_PLAYER_DATA_DIR: data, ...env }, encoding: 'utf8' }).trim();
  try {
    assert.equal(run({ MCP_SERVERS_DIR: '' }), 'refused', 'the default inside the data folder fails closed');
    assert.equal(run({ MCP_SERVERS_DIR: path.join(root, 'mcp-servers', path.basename(data)) }), 'ok');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
