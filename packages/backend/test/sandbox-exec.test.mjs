// S0-Q.3: no host-shell fallback when the Docker sandbox is unavailable.
// Run: node --import tsx --test test/sandbox-exec.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { SandboxExecutor } from '../src/sandbox/executor.ts';

const withEnv = async (value, fn) => {
  const saved = process.env.SANDBOX_ALLOW_HOST_EXEC;
  if (value === undefined) delete process.env.SANDBOX_ALLOW_HOST_EXEC;
  else process.env.SANDBOX_ALLOW_HOST_EXEC = value;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.SANDBOX_ALLOW_HOST_EXEC;
    else process.env.SANDBOX_ALLOW_HOST_EXEC = saved;
  }
};

test('sandboxed mode without a container refuses instead of running on the host', async () => {
  await withEnv('true', async () => {
    const executor = new SandboxExecutor({ mode: 'non-main' });
    const result = await executor.execute({ command: 'echo should-not-run' });
    assert.equal(result.blocked, true);
    assert.equal(result.stdout, '');
    assert.match(result.blockReason, /Sandbox is not available/);
  });
});

test("mode 'off' runs on the host only when SANDBOX_ALLOW_HOST_EXEC=true", async () => {
  await withEnv(undefined, async () => {
    const executor = new SandboxExecutor({ mode: 'off' });
    const result = await executor.execute({ command: 'echo should-not-run' });
    assert.equal(result.blocked, true);
    assert.match(result.blockReason, /Host command execution is disabled/);
  });
  await withEnv('true', async () => {
    const executor = new SandboxExecutor({ mode: 'off' });
    const result = await executor.execute({ command: 'echo host-ok' });
    assert.equal(result.blocked, undefined);
    assert.equal(result.stdout.trim(), 'host-ok');
  });
});

test('host execution uses the server directory and refuses a custom working directory', async () => {
  await withEnv('true', async () => {
    const executor = new SandboxExecutor({ mode: 'off' });
    const result = await executor.execute({ command: 'echo refused', cwd: '.' });
    assert.equal(result.blocked, true);
    assert.equal(result.stdout, '');
    assert.match(result.blockReason, /require Docker isolation/);
  });
});

test('the config API cannot switch off isolation or loosen limits', () => {
  const executor = new SandboxExecutor({ mode: 'all' });
  const before = executor.getConfig();
  executor.updateConfig({
    mode: 'off',
    docker: { privileged: true, network: 'host', image: 'evil:1' },
    workspaceAccess: 'write',
    allowedCommands: ['rm'],
    timeout: 5000,
    maxMemory: 999999,
  });
  const config = executor.getConfig();
  assert.equal(config.mode, 'all');
  assert.deepEqual(config.docker, before.docker);
  assert.equal(config.workspaceAccess, before.workspaceAccess);
  assert.equal(config.allowedCommands, before.allowedCommands);
  assert.equal(config.timeout, Math.min(5000, before.timeout));
  assert.equal(config.maxMemory, before.maxMemory);
});
