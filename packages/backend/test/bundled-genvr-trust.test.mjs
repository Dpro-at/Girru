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

test('migration recognises only managed entries and exact current or historical pinned loaders', async () => {
 const path=await import('node:path');
 const {isManagedGenvrLaunch,GENVR_PACKAGE_HASH}=await import('../src/mcp-client/bundled-genvr.ts');
 const {genvrBundledRoot,genvrRuntimesRoot}=await import('../src/config/genvr-runtime.ts');
 const {pinnedEntryArgs}=await import('../src/mcp-client/pinned-entry.ts');
 const old='4d209c9e8fc7028ed5dbcba8b0d38c59a299f433afc3bb69af7d3f75d80afbab';
 const vendor=path.join(genvrBundledRoot(),'package/dist/mcp.js');
 const cache=path.join(genvrRuntimesRoot(),'genvr/0.3.0-preview.21-1234abcd/package/dist/mcp.js');
 const row=args=>({...bundled,args:JSON.stringify(args)});
 for(const file of [vendor,cache])for(const hash of [old,GENVR_PACKAGE_HASH])assert.equal(isManagedGenvrLaunch(row(pinnedEntryArgs(file,hash))),true);
 assert.equal(isManagedGenvrLaunch(row([vendor])),true);
 for(const args of [[cache],pinnedEntryArgs(path.join(genvrRuntimesRoot(),'elsewhere/package/dist/mcp.js'),old),[...pinnedEntryArgs(cache,old),'--inspect'],pinnedEntryArgs(cache,'0'.repeat(64))])assert.equal(isManagedGenvrLaunch(row(args)),false);
 assert.equal(isManagedGenvrLaunch({...row([vendor]),command:path.join(path.parse(vendor).root,'old-install/node')}),true);
 const moved=path.join(path.parse(vendor).root,'old-app/core-ui/vendor/genvr/package/dist/mcp.js');
 assert.equal(isManagedGenvrLaunch({...row(pinnedEntryArgs(moved,old)),command:path.join(path.parse(vendor).root,'old-app/node')}),true);
 assert.equal(isManagedGenvrLaunch({...row([vendor]),command:'node --eval'}),false);
});
