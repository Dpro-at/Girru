// STORE-MAP-01 P7 (GIRRU_STORE_P7), SUB2: subscription replies on Windows through a Job Object.
//  - everywhere: arguments are quoted so the Windows C runtime reads each one back unchanged; the
//    leader script joins a KILL_ON_JOB_CLOSE job before it starts the CLI and hides its spec from
//    the CLI; only absolute .exe programs, P7 on and Windows are accepted;
//  - Windows only (CI): the CLI's answer and exit code come back, the prompt goes through stdin,
//    and stopping the leader ends the CLI's own child processes too.
// Run: node --import tsx --test test/subscription-launcher-win.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const win = await import(pathToFileURL(join(backendDir, 'src/services/subscription-launcher-win.ts')).href);
const onWindows = process.platform === 'win32';
const withP7 = async (fn) => { process.env.GIRRU_STORE_P7 = '1'; try { return await fn(); } finally { process.env.GIRRU_STORE_P7 = '0'; } };

/** CommandLineToArgvW's rules (arguments after the program name). */
function parseWindows(line) {
  const out = []; let i = 0;
  while (i < line.length) {
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (i >= line.length) break;
    let arg = '', quoted = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') {
        let n = 0; while (line[i] === '\\') { n++; i++; }
        if (line[i] === '"') { arg += '\\'.repeat(n >> 1); if (n % 2) { arg += '"'; continue; } i--; continue; }
        arg += '\\'.repeat(n); i--; continue;
      }
      if (c === '"') { if (quoted && line[i + 1] === '"') { arg += '"'; i++; continue; } quoted = !quoted; continue; }
      if (!quoted && (c === ' ' || c === '\t')) break;
      arg += c;
    }
    out.push(arg);
  }
  return out;
}

test('quoting: every argument comes back as it was', () => {
  const args = ['-p', '', 'two words', 'say "hi"', 'C:\\path with space\\', 'trail\\', 'a\\\\"b', '{"mcpServers":{}}', '\t', 'ü مرحبا'];
  assert.deepEqual(parseWindows(win.windowsCommandLine(args)), args);
  assert.equal(win.quoteWindowsArg('plain'), 'plain');
  assert.equal(win.quoteWindowsArg(''), '""');
});

test('leader: joins a kill-on-close job before the CLI starts; the spec never reaches the CLI', () => {
  const s = win.WINDOWS_LEADER;
  assert.match(s, /LimitFlags = 0x2000/);
  assert.ok(s.indexOf('[GirruJob]::Enter()') < s.indexOf('Diagnostics.Process]::Start'), 'the job comes first');
  assert.match(s, /EnvironmentVariables\.Remove\('GIRRU_LAUNCH_SPEC'\)/);
  assert.match(s, /UseShellExecute = \$false/);
  assert.match(s, /\$parent\.HasExited/);
  assert.match(s, /-TypeDefinition @'$/m, 'here-string opens at the end of its line'); assert.match(s, /^'@$/m, 'and closes at the start of one');
  assert.equal(win.windowsPowerShell({ SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('refused: P7 off, not Windows, not an absolute .exe, a NUL in an argument', async () => {
  const opts = { cwd: 'C:\\work', env: {}, platform: 'win32' };
  const before = process.env.GIRRU_STORE_P7; process.env.GIRRU_STORE_P7 = '0';
  try { await assert.rejects(win.launchWindowsSubscription('C:\\bin\\claude.exe', [], opts), /subscription_launch_invalid/); }
  finally { if (before !== undefined) process.env.GIRRU_STORE_P7 = before; }
  await withP7(async () => {
    await assert.rejects(win.launchWindowsSubscription('C:\\bin\\claude.exe', [], { ...opts, platform: 'darwin' }), /subscription_launch_invalid/);
    await assert.rejects(win.launchWindowsSubscription('C:\\bin\\codex.cmd', [], opts), /subscription_launch_invalid/);
    await assert.rejects(win.launchWindowsSubscription('claude.exe', [], opts), /subscription_launch_invalid/);
    await assert.rejects(win.launchWindowsSubscription('C:\\bin\\claude.exe', ['a\0b'], opts), /subscription_launch_invalid/);
    await assert.rejects(win.launchWindowsSubscription('C:\\bin\\claude.exe', ['x'.repeat(31000)], opts), /subscription_launch_invalid/);
  });
});

const read = (stream) => { let s = ''; stream.on('data', (d) => { s += d; }); return () => s; };

test('Windows: answer, exit code and stdin go through the job leader', { skip: !onWindows && 'Windows only (CI)' }, async () => {
  await withP7(async () => {
    const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write('got:'+s);process.exit(3);});";
    const l = await win.launchWindowsSubscription(process.execPath, ['-e', script], { cwd: tmpdir(), env: { PATH: process.env.PATH } });
    const out = read(l.child.stdout);
    l.start('hello "there"');
    assert.equal(await l.completion, 3);
    assert.equal(out(), 'got:hello "there"');
  });
});

test('Windows: stopping the leader ends the CLI\'s own children too', { skip: !onWindows && 'Windows only (CI)' }, async () => {
  await withP7(async () => {
    const script = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1000);";
    const l = await win.launchWindowsSubscription(process.execPath, ['-e', script], { cwd: tmpdir(), env: { PATH: process.env.PATH } });
    const out = read(l.child.stdout);
    l.start('');
    const deadline = Date.now() + 20000;
    while (!/\d+\n/.test(out()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const pid = Number(out().trim());
    assert.ok(pid > 0, 'the grandchild started');
    const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
    assert.ok(alive(pid));
    l.child.kill();
    await l.completion;
    const until = Date.now() + 5000;
    while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(pid), false, 'the job took the grandchild with it');
  });
});
