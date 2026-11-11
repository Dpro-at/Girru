import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TerminalManager } from '../src/terminal/manager.ts';

/** A real platform PTY, with a throwaway working folder and no provider calls. */
test('native command session runs once and retains the real exit/transcript', { timeout: 75000, skip: process.platform === 'win32' && 'chat commands are off on Windows until verified there' }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'girru-command-native-'));
  const env = { ...process.env, AGENT_TERMINAL: 'true', SHELL: process.platform === 'win32' ? undefined : '/bin/sh', HOME: root, USERPROFILE: root };
  const manager = new TerminalManager({ env, cwd: root });
  t.after(async () => { manager.closeAll(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const command = process.platform === 'win32' ? "Write-Output 'NATIVE_COMMAND_OK'; exit 7" : "printf 'NATIVE_COMMAND_OK\\n'; exit 7";
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
  assert.equal(manager.list('fixture-owner').length, 1);
  assert.throws(() => manager.stop('another-owner', session.id));
});
