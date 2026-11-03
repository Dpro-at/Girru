// STORE-MAP-01 P7 (GIRRU_STORE_P7), SEC2-6 + OPS7/CX8: the one safe file writer for project folders.
//  - only inside the folder: `..`, absolute, drive, UNC, `\`, `:`, device names, trailing dot/space refused;
//  - never through a link: a linked file, a linked folder (a Windows junction is the same case; it runs
//    for real on Windows CI) and a hard link are refused, nothing written outside;
//  - case collisions refused; long paths refused with the Windows limit;
//  - size and type: too large, NUL bytes and broken UTF-8 refused;
//  - atomic: an interrupted write leaves the old file and no temp file; a crash's leftover temp is
//    removed on the next write; a swap between the checks and the rename is caught (re-check after open);
//  - compare-and-set by hash; a locked file is retried and then reported, never half written;
//  - no directory fsync on Windows; modes kept;
//  - the switch: with P7 on, the managed files and the rules files go through it; off, nothing changes.
// Run: node --import tsx --test test/safe-file.test.mjs
// Throwaway folders only; no DB, no network. Modules load by file URL (Windows-safe dynamic import).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const backendDir = process.cwd();
const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'ap-safe-file-')));
// Nothing here opens a database; should a module ever do so, it lands in this throwaway folder.
process.chdir(base);
process.env.HOME = base;
process.env.DATABASE_PATH = join(base, 'never-used.db');
process.env.NODE_ENV = 'test';
const load = (rel) => import(pathToFileURL(join(backendDir, rel)).href);
const S = await load('src/services/safe-file.ts');
const { storeP7Enabled } = await load('src/services/store-p7.ts');

const win = process.platform === 'win32';
let n = 0;
const folder = () => { const d = join(base, `p${++n}`); fs.mkdirSync(d); return d; };
const code = (c) => (e) => { assert.ok(e instanceof S.SafeFileError, `expected SafeFileError, got ${e}`); assert.equal(e.code, c, e.message); return true; };
const tempsIn = (d) => fs.readdirSync(d).filter((x) => x.includes('.girru-') && x.endsWith('.tmp'));
test.after(() => { S.setSafeFileHooksForTests(null); process.chdir(backendDir); fs.rmSync(base, { recursive: true, force: true }); });

test('switch is off by default and reads the usual values', () => {
  assert.equal(storeP7Enabled({}), false);
  for (const v of ['1', 'true', 'on', 'YES']) assert.equal(storeP7Enabled({ GIRRU_STORE_P7: v }), true);
  assert.equal(storeP7Enabled({ GIRRU_STORE_P7: '0' }), false);
});

test('creates, updates and leaves unchanged, with folders on the way', () => {
  const d = folder();
  assert.equal(S.safeWriteFile(d, '.girru/tasks.md', '# Tasks\n').action, 'create');
  assert.equal(fs.readFileSync(join(d, '.girru', 'tasks.md'), 'utf8'), '# Tasks\n');
  assert.equal(S.safeWriteFile(d, '.girru/tasks.md', '# Tasks\n').action, 'unchanged');
  const r = S.safeWriteFile(d, '.girru/tasks.md', '# Tasks\n\nمرحبا\n');
  assert.equal(r.action, 'update');
  assert.equal(r.sha256, S.sha256('# Tasks\n\nمرحبا\n'));
  assert.deepEqual(tempsIn(join(d, '.girru')), []);
  assert.throws(() => S.safeWriteFile(d, 'x/y.md', 'a', { createDirs: false }), code('no_folder'));
});

test('paths outside the folder or not allowed on some system are refused', () => {
  const d = folder();
  for (const p of ['../x.md', 'a/../../x.md', '/etc/x', '']) assert.throws(() => S.safeWriteFile(d, p, 'a'), (e) => e instanceof S.SafeFileError && ['outside_folder', 'bad_path'].includes(e.code));
  for (const p of ['C:/x.md', 'a\\b.md', '\\\\server\\share\\x', 'a/./b.md', 'a//b.md', 'nul', 'CON.md', 'lpt1.txt', 'notes.', 'notes ', 'a?.md', 'AGENTS.md:stream']) assert.throws(() => S.safeWriteFile(d, p, 'a'), code('bad_path'), p);
  assert.deepEqual(fs.readdirSync(d), []);
  assert.throws(() => S.safeWriteFile(join(d, 'missing'), 'a.md', 'a'), code('no_folder'));
  assert.throws(() => S.safeWriteFile(null, 'a.md', 'a'), code('no_folder'));
});

test('a linked file, a linked folder and a hard link are never written through', { skip: win && 'symlinks need rights on Windows; the junction case runs below' }, () => {
  const d = folder(), outside = folder();
  fs.writeFileSync(join(outside, 'secret.md'), 'keep');
  fs.symlinkSync(join(outside, 'secret.md'), join(d, 'AGENTS.md'));
  assert.throws(() => S.safeWriteFile(d, 'AGENTS.md', 'x'), code('link'));
  fs.symlinkSync(outside, join(d, '.girru'));
  assert.throws(() => S.safeWriteFile(d, '.girru/tasks.md', 'x'), code('link'));
  fs.linkSync(join(outside, 'secret.md'), join(d, 'CLAUDE.md'));
  assert.throws(() => S.safeWriteFile(d, 'CLAUDE.md', 'x'), code('link'));
  assert.deepEqual(fs.readdirSync(outside).sort(), ['secret.md']);
  assert.equal(fs.readFileSync(join(outside, 'secret.md'), 'utf8'), 'keep');
});

test('a Windows junction on the way is refused', { skip: !win && 'junctions exist only on Windows (Windows CI)' }, () => {
  const d = folder(), outside = folder();
  fs.symlinkSync(outside, join(d, '.girru'), 'junction');
  assert.throws(() => S.safeWriteFile(d, '.girru/tasks.md', 'x'), code('link'));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('the project folder itself may be reached through a link (its real path is used)', { skip: win && 'symlinks need rights on Windows' }, () => {
  const d = folder();
  const alias = join(base, `alias-${n}`);
  fs.symlinkSync(d, alias);
  assert.equal(S.safeWriteFile(alias, 'AGENTS.md', 'a').file, join(d, 'AGENTS.md'));
});

test('names that differ only by case are refused', () => {
  const d = folder();
  fs.writeFileSync(join(d, 'AGENTS.md'), 'mine');
  assert.throws(() => S.safeWriteFile(d, 'agents.md', 'x'), code('case_collision'));
  fs.mkdirSync(join(d, '.Girru'));
  assert.throws(() => S.safeWriteFile(d, '.girru/tasks.md', 'x'), code('case_collision'));
  assert.equal(fs.readFileSync(join(d, 'AGENTS.md'), 'utf8'), 'mine');
  // Unicode forms: é composed vs decomposed.
  fs.writeFileSync(join(d, 'caf\u00e9.md'), 'mine');
  assert.throws(() => S.safeWriteFile(d, 'cafe\u0301.md', 'x'), (e) => e instanceof S.SafeFileError && ['case_collision', 'link'].includes(e.code));
});

test('long paths are refused with the Windows limit, allowed within it', () => {
  const d = folder();
  const long = 'a'.repeat(240);
  assert.throws(() => S.safeWriteFile(d, `${long}.md`, 'x', { platform: 'win32' }), code('path_too_long'));
  assert.throws(() => S.safeWriteFile(d, `${'b/'.repeat(2100)}x.md`, 'x'), code('path_too_long'));
  assert.equal(S.safeWriteFile(d, 'short.md', 'x', { platform: 'win32' }).action, 'create');
});

test('size and type: too large, binary and broken UTF-8 are refused', () => {
  const d = folder();
  assert.throws(() => S.safeWriteFile(d, 'a.md', 'x'.repeat(11), { maxBytes: 10 }), code('too_large'));
  assert.throws(() => S.safeWriteFile(d, 'a.md', 'a\0b'), code('not_text'));
  assert.throws(() => S.safeWriteFile(d, 'a.md', Buffer.from([0x61, 0xff, 0x62])), code('not_text'));
  fs.mkdirSync(join(d, 'dir.md'));
  assert.throws(() => S.safeWriteFile(d, 'dir.md', 'x'), (e) => e instanceof S.SafeFileError && ['not_regular', 'link'].includes(e.code));
  assert.deepEqual(fs.readdirSync(d), ['dir.md']);
});

test('an interrupted write leaves the old file and no temp file', () => {
  const d = folder();
  S.safeWriteFile(d, 'AGENTS.md', 'old');
  S.setSafeFileHooksForTests({ beforeRename: () => { throw Object.assign(new Error('power cut'), { code: 'EIO' }); } });
  try { assert.throws(() => S.safeWriteFile(d, 'AGENTS.md', 'new'), /power cut/); } finally { S.setSafeFileHooksForTests(null); }
  assert.equal(fs.readFileSync(join(d, 'AGENTS.md'), 'utf8'), 'old');
  assert.deepEqual(tempsIn(d), []);
});

test('a temp file a crash left behind is removed on the next write; a fresh one is left alone', () => {
  const d = folder();
  const stale = join(d, '.AGENTS.md.girru-1-dead.tmp');
  const fresh = join(d, '.AGENTS.md.girru-2-live.tmp');
  fs.writeFileSync(stale, 'half');
  fs.writeFileSync(fresh, 'other writer');
  const old = (Date.now() - 5 * 60_000) / 1000;
  fs.utimesSync(stale, old, old);
  S.safeWriteFile(d, 'AGENTS.md', 'whole');
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.readFileSync(join(d, 'AGENTS.md'), 'utf8'), 'whole');
});

test('re-check after open: a file or folder swapped before the rename is caught', { skip: win && 'symlinks need rights on Windows' }, () => {
  const d = folder(), outside = folder();
  S.safeWriteFile(d, 'AGENTS.md', 'old');
  S.setSafeFileHooksForTests({ beforeRename: (_tmp, target) => { fs.rmSync(target); fs.symlinkSync(join(outside, 'x.md'), target); } });
  try { assert.throws(() => S.safeWriteFile(d, 'AGENTS.md', 'new'), code('changed')); } finally { S.setSafeFileHooksForTests(null); }
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(tempsIn(d), []);

  const e = folder();
  S.safeWriteFile(e, '.girru/tasks.md', 'old');
  S.setSafeFileHooksForTests({ beforeRename: () => { fs.renameSync(join(e, '.girru'), join(e, 'moved')); fs.symlinkSync(outside, join(e, '.girru')); } });
  try { assert.throws(() => S.safeWriteFile(e, '.girru/tasks.md', 'new'), code('changed')); } finally { S.setSafeFileHooksForTests(null); }
  assert.deepEqual(fs.readdirSync(outside), []);

  const f = folder();
  S.setSafeFileHooksForTests({ beforeRename: (_tmp, target) => fs.writeFileSync(target, 'someone else') });
  try { assert.throws(() => S.safeWriteFile(f, 'AGENTS.md', 'new'), code('changed')); } finally { S.setSafeFileHooksForTests(null); }
  assert.equal(fs.readFileSync(join(f, 'AGENTS.md'), 'utf8'), 'someone else');
});

test('compare-and-set by hash', () => {
  const d = folder();
  assert.equal(S.safeWriteFile(d, 'a.md', 'one', { expectSha256: null }).action, 'create');
  assert.throws(() => S.safeWriteFile(d, 'a.md', 'two', { expectSha256: null }), code('changed'));
  assert.throws(() => S.safeWriteFile(d, 'a.md', 'two', { expectSha256: S.sha256('zero') }), code('changed'));
  assert.equal(S.safeWriteFile(d, 'a.md', 'two', { expectSha256: S.sha256('one') }).action, 'update');
  S.setSafeFileHooksForTests({ beforeRename: (_tmp, target) => { const fd = fs.openSync(target, 'r+'); fs.writeSync(fd, 'TWO', 0); fs.closeSync(fd); } });
  try { assert.throws(() => S.safeWriteFile(d, 'a.md', 'three', { expectSha256: S.sha256('two') }), code('changed')); } finally { S.setSafeFileHooksForTests(null); }
  assert.equal(fs.readFileSync(join(d, 'a.md'), 'utf8'), 'TWO');
});

test('a locked file is retried, then reported; never half written', () => {
  const d = folder();
  S.safeWriteFile(d, 'AGENTS.md', 'old');
  let tries = 0;
  const busy = () => Object.assign(new Error('busy'), { code: 'EBUSY' });
  S.setSafeFileHooksForTests({ rename: (a, b) => { if (++tries < 3) throw busy(); fs.renameSync(a, b); } });
  try { assert.equal(S.safeWriteFile(d, 'AGENTS.md', 'new').action, 'update'); } finally { S.setSafeFileHooksForTests(null); }
  assert.equal(tries, 3);
  S.setSafeFileHooksForTests({ rename: () => { throw Object.assign(new Error('perm'), { code: 'EPERM' }); } });
  try { assert.throws(() => S.safeWriteFile(d, 'AGENTS.md', 'newer', { platform: 'win32' }), code('locked')); } finally { S.setSafeFileHooksForTests(null); }
  assert.equal(fs.readFileSync(join(d, 'AGENTS.md'), 'utf8'), 'new');
  assert.deepEqual(tempsIn(d), []);
});

test('no directory fsync on Windows; one elsewhere; modes kept', () => {
  const d = folder();
  const synced = [];
  S.setSafeFileHooksForTests({ fsyncDir: (dir) => synced.push(dir) });
  try {
    S.safeWriteFile(d, 'a.md', 'x', { platform: 'win32' });
    assert.deepEqual(synced, []);
    S.safeWriteFile(d, 'b.md', 'x', { platform: 'linux' });
    assert.deepEqual(synced, [d]);
  } finally { S.setSafeFileHooksForTests(null); }
  if (!win) {
    fs.chmodSync(join(d, 'b.md'), 0o600);
    S.safeWriteFile(d, 'b.md', 'y');
    assert.equal(fs.statSync(join(d, 'b.md')).mode & 0o777, 0o600);
    S.safeWriteFile(d, 'c.md', 'y', { mode: 0o640 });
    assert.equal(fs.statSync(join(d, 'c.md')).mode & 0o777, 0o640);
  }
});

test('safeWriteAt: inside the root by relative path; outside it, only the file\'s own folder', () => {
  const d = folder(), gitDir = folder();
  assert.equal(S.safeWriteAt(d, join(d, '.git', 'info', 'exclude'), 'x').file, join(d, '.git', 'info', 'exclude'));
  assert.equal(S.safeWriteAt(d, join(gitDir, 'exclude'), 'y').file, join(gitDir, 'exclude'));
});

test('switch on: managed files go through the safe writer; off: unchanged', { skip: win && 'symlinks need rights on Windows' }, async () => {
  const M = await load('src/memory/bridge/managed-files.ts');
  const marks = M.GIRRU_MARKS;
  const d = folder(), outside = folder();
  fs.mkdirSync(join(d, 'docs'));
  const prev = process.env.GIRRU_STORE_P7;
  try {
    process.env.GIRRU_STORE_P7 = '1';
    assert.equal(M.writeSection(d, 'docs/DESIGN.md', 'Design notes', marks).action, 'create');
    // A folder swapped for a link between Girru's read and its write is refused by the writer itself.
    S.setSafeFileHooksForTests({ beforeRename: () => { fs.renameSync(join(d, 'docs'), join(d, 'docs-old')); fs.symlinkSync(outside, join(d, 'docs')); } });
    try { assert.throws(() => M.writeSection(d, 'docs/DESIGN.md', 'Changed', marks), (e) => e.code === 'unsafe_path' && e.status === 409); } finally { S.setSafeFileHooksForTests(null); }
    assert.deepEqual(fs.readdirSync(outside), []);
    delete process.env.GIRRU_STORE_P7;
    fs.rmSync(join(d, 'docs')); fs.renameSync(join(d, 'docs-old'), join(d, 'docs'));
    assert.equal(M.writeSection(d, 'docs/DESIGN.md', 'Off again', marks).action, 'update');
    assert.match(fs.readFileSync(join(d, 'docs', 'DESIGN.md'), 'utf8'), /Off again/);
  } finally { if (prev === undefined) delete process.env.GIRRU_STORE_P7; else process.env.GIRRU_STORE_P7 = prev; }
});

test('switch on: the rules and task writer refuses a linked target and stays inside the folder', { skip: win && 'symlinks need rights on Windows' }, async () => {
  const R = await load('src/services/agent-rule-files.ts');
  const d = folder(), outside = folder();
  const prev = process.env.GIRRU_STORE_P7;
  try {
    process.env.GIRRU_STORE_P7 = '1';
    fs.mkdirSync(join(d, '.girru'));
    await R.writeAtomic(join(d, '.girru', 'rules.md'), '# Rules\n', d);
    assert.equal(fs.readFileSync(join(d, '.girru', 'rules.md'), 'utf8'), '# Rules\n');
    fs.symlinkSync(join(outside, 'x.md'), join(d, '.girru', 'tasks.md'));
    await assert.rejects(R.writeAtomic(join(d, '.girru', 'tasks.md'), 'x', d), (e) => e.code === 'unsafe');
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally { if (prev === undefined) delete process.env.GIRRU_STORE_P7; else process.env.GIRRU_STORE_P7 = prev; }
});
