import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalManager } from '../src/terminal/manager.ts';

/** A real platform PTY, with a throwaway working folder and no provider calls. */
test('native command session runs once and retains the real exit/transcript', { timeout: 75000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'girru-command-native-'));
  const env = { ...process.env, AGENT_TERMINAL: 'true', SHELL: process.platform === 'win32' ? undefined : '/bin/sh', HOME: root, USERPROFILE: root };
  const manager = new TerminalManager({ env, cwd: root });
  t.after(async () => { manager.closeAll(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const command = process.platform === 'win32' ? "Write-Output 'NATIVE_COMMAND_OK';\nWrite-Output 'NATIVE_QUOTED_\"_VALUE'; exit 7" : "printf '%s\\n' 'NATIVE_COMMAND_OK' 'NATIVE_QUOTED_\"_VALUE'; exit 7";
  const session = await manager.create('fixture-owner', { command, cwd: root });
  let unsubscribe = () => {};
  const events = await new Promise((resolve, reject) => {
    const frames = [], timer = setTimeout(() => reject(new Error('Native command did not exit within 60 seconds')), 60000);
    unsubscribe = manager.subscribe('fixture-owner', session.id, 0, frame => {
      frames.push(frame);
      if (frame.type === 'exit') { clearTimeout(timer); resolve(frames); }
    });
  });
  unsubscribe();
  assert.equal(events.at(-1).type, 'exit');
  assert.equal(events.at(-1).exitCode, 7);
  assert.match(events.filter(f => f.type === 'data').map(f => f.chunk.data).join(''), /NATIVE_COMMAND_OK/);
  const replay = []; manager.subscribe('fixture-owner', session.id, 0, frame => replay.push(frame))();
  assert.equal(replay.at(-1).exitCode, 7);
  assert.match(replay.filter(f => f.type === 'data').map(f => f.chunk.data).join(''), /NATIVE_COMMAND_OK/);
  assert.match(replay.filter(f => f.type === 'data').map(f => f.chunk.data).join(''), /NATIVE_QUOTED_\"_VALUE/);
  assert.equal(manager.list('fixture-owner').length, 1);
  assert.throws(() => manager.stop('another-owner', session.id));
});

for (const action of ['stop', 'close']) test(`native command ${action} terminates its live platform PTY`, { timeout: 75000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'girru-command-lifecycle-'));
  const { ensureSpawnHelper } = await import('../src/terminal/manager.ts');
  ensureSpawnHelper();
  const mod = await import('node-pty');
  const spawn = mod.spawn ?? mod.default.spawn;
  let pid;
  const manager = new TerminalManager({ cwd: root, env: { ...process.env, AGENT_TERMINAL: 'true', SHELL: process.platform === 'win32' ? undefined : '/bin/sh', HOME: root, USERPROFILE: root }, spawn: (...args) => { const pty = spawn(...args); pid = pty.pid; return pty; } });
  t.after(async () => { manager.closeAll(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const command = process.platform === 'win32' ? "Write-Output 'LIFECYCLE_READY'; Start-Sleep 60" : "printf 'LIFECYCLE_READY\\n'; sleep 60";
  const session = await manager.create('owner', { command });
  let unsubscribe = () => {}, output = '';
  let exited;
  const exit = new Promise(resolve => { exited = resolve; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Native lifecycle readiness timed out')), 60000);
    unsubscribe = manager.subscribe('owner', session.id, 0, frame => {
      if (frame.type === 'exit') exited(frame);
      if (frame.type === 'data') { output += frame.chunk.data; if (output.includes('LIFECYCLE_READY')) { clearTimeout(timer); resolve(); } }
    });
  });
  manager[action]('owner', session.id);
  if (action === 'stop') {
    let timer;
    const frame = await Promise.race([exit, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Stop did not report native exit')), 10000); })]).finally(() => clearTimeout(timer));
    assert.equal(frame.type, 'exit');
  }
  const deadline = Date.now() + 10000;
  while (true) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
    assert.ok(Date.now() < deadline, 'Native shell PID must be gone after termination');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  unsubscribe();
});
