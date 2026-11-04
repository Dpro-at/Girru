// Only GenVR's exact bundled MCP launch is trusted without AGENT_EXEC_TOOLS (Mohamed, 2026-11-04).
// Run: node --import tsx --test test/bundled-genvr-trust.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
const { isTrustedBundledLaunch, genvrLaunch, GENVR_MCP_NAME, GENVR_MCP_DESCRIPTION } = await import('../src/mcp-client/bundled-genvr.ts');
const { isServerActive } = await import('../src/mcp-client/store.ts');
const { isToolObjectAllowedByExecPolicy, markTrustedBundledTool } = await import('../src/tools/exec-policy.ts');

delete process.env.AGENT_EXEC_TOOLS;
const launch = genvrLaunch();
const bundled = { name: GENVR_MCP_NAME, description: GENVR_MCP_DESCRIPTION, transport: 'stdio', command: launch.command, args: JSON.stringify(launch.args), env_names: JSON.stringify(['GENVR_WORLD_DIR', 'GENVR_STUDIO_CONNECTION']) };
const approved = row => ({ ...row, enabled: 1, launch_hash: 'h', approved_launch_hash: 'h' });

test('the exact bundled GenVR launch is trusted and active without the switch', () => {
  assert.equal(isTrustedBundledLaunch(bundled), true);
  assert.equal(isServerActive(approved(bundled)), true);
});

test('any change to the launch makes it an ordinary stdio server again', () => {
  const cases = {
    'other name': { name: 'genvr-local-2' },
    'other description': { description: 'mine' },
    'other command': { command: '/usr/bin/node' },
    'extra argument': { args: JSON.stringify([...launch.args, '--inspect']) },
    'unpinned entry': { args: JSON.stringify([launch.args.at(-1)]) },
    'NODE_OPTIONS in env': { env_names: JSON.stringify(['GENVR_WORLD_DIR', 'NODE_OPTIONS']) },
    'http transport': { transport: 'http' },
  };
  for (const [label, change] of Object.entries(cases)) {
    const row = { ...bundled, ...change };
    assert.equal(isTrustedBundledLaunch(row), false, label);
    if (row.transport === 'stdio') assert.equal(isServerActive(approved(row)), false, `${label}: stays behind AGENT_EXEC_TOOLS`);
  }
});

test('the launch approval is still needed', () => {
  assert.equal(isServerActive({ ...bundled, enabled: 1, launch_hash: 'h', approved_launch_hash: null }), false);
  assert.equal(isServerActive({ ...approved(bundled), enabled: 0 }), false);
});

test('only marked tool objects pass the switch; other exec tools are still refused', () => {
  const tool = markTrustedBundledTool({ name: 'mcp__genvr-local__x', execClass: true });
  assert.equal(isToolObjectAllowedByExecPolicy(tool), true);
  assert.equal(isToolObjectAllowedByExecPolicy({ ...tool }), false, 'a copy is not trusted');
  assert.equal(isToolObjectAllowedByExecPolicy({ name: 'mcp__other__x', execClass: true }), false);
  assert.equal(isToolObjectAllowedByExecPolicy({ name: 'execute_code' }), false, 'built-in exec tools stay off');
});
