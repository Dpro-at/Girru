'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { stopProcessTree, processTable, descendants } = require('../src/process-tree.cjs');

const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const until = async (check, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

test('descendants lists the whole tree under a process, not its parent or siblings', () => {
  const table = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 13, ppid: 10 }, { pid: 20, ppid: 1 }, { pid: 21, ppid: 20 }];
  assert.deepEqual(descendants(table, 10).sort(), [11, 12, 13]);
  assert.deepEqual(descendants(table, 21), []);
});

test('the process table parses ps and PowerShell output and ignores other lines', async () => {
  assert.deepEqual(await processTable({ platform: 'darwin', exec: async () => '  1     0\n 42  1\nnoise\n' }), [{ pid: 1, ppid: 0 }, { pid: 42, ppid: 1 }]);
  assert.deepEqual(await processTable({ platform: 'win32', exec: async () => '4 0\r\n900 4\r\n' }), [{ pid: 4, ppid: 0 }, { pid: 900, ppid: 4 }]);
  assert.deepEqual(await processTable({ platform: 'linux', exec: async () => '' }), []);
});

test('a reused pid that now belongs to another parent is not signalled', async () => {
  let reads = 0; const signals = [];
  const exec = async () => (reads++ === 0 ? '100 1\n101 100\n102 101\n' : '101 1\n102 555\n555 1\n');
  const kill = (pid, sig) => { if (sig === 0) { if ([101, 102].includes(pid) && !signals.some(s => s[0] === pid)) return true; const e = Error('gone'); e.code = 'ESRCH'; throw e; } signals.push([pid, sig]); return true; };
  await stopProcessTree(100, async () => {}, { platform: 'darwin', exec, kill, graceMs: 200 });
  assert.deepEqual(signals, [[101, 'SIGTERM']], 'only the orphan moved to init is stopped; 102 now belongs to 555');
});

test('stopping the editor server also stops the extension host it left behind', { skip: process.platform === 'win32' && 'POSIX process re-parenting' }, async t => {
  // The parent starts a grandchild that ignores SIGHUP and keeps running when the parent ends (like the extension host).
  const parent = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const c = spawn(process.execPath, ['-e', 'process.on("SIGHUP",()=>{}); setInterval(()=>{}, 1000)'], { stdio: 'ignore' });
    console.log(c.pid); setInterval(()=>{}, 1000);
  `], { stdio: ['ignore', 'pipe', 'ignore'] });
  const grandchild = await new Promise(resolve => parent.stdout.once('data', chunk => resolve(Number(String(chunk).trim()))));
  t.after(() => { for (const pid of [parent.pid, grandchild]) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  assert.ok(alive(grandchild));
  const exited = new Promise(resolve => parent.once('exit', resolve));
  // The runtime's own stop: SIGTERM to its server only.
  await stopProcessTree(parent.pid, async () => { parent.kill('SIGTERM'); await exited; }, { graceMs: 2000 });
  assert.ok(await until(() => !alive(grandchild)), 'the grandchild must not outlive the stop');
});

test('without a pid the child is just stopped (test hosts, never started)', async () => {
  let stopped = 0;
  await stopProcessTree(undefined, async () => { stopped++; }, { exec: async () => { throw Error('must not read the table'); } });
  assert.equal(stopped, 1);
});
