// S1.6: file tools (`read`, `write`) are confined to the agent's own
// workspace `.data/workspaces/<agentId>/` (0700): traversal, sibling-prefix,
// symlink escape, NUL/control characters, the always-deny list and size
// limits are refused; write outside the workspace is impossible.
// Throwaway folder as working directory; no DB, no network, no port.
// Run: node --import tsx --test test/file-tools-sandbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, statSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backendDir = process.cwd();
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-file-sandbox-')));
process.chdir(dir);
console.error = () => {};
console.log = () => {};

// Server secrets next to the workspaces (must never be reachable).
writeFileSync(join(dir, '.env'), 'JWT_SECRET=not-a-real-secret\n');
mkdirSync(join(dir, '.data', 'encryption'), { recursive: true });
writeFileSync(join(dir, '.data', 'encryption', 'master.key'), 'k');
writeFileSync(join(dir, '.data', 'agent-player.db'), 'db');
const outside = join(dir, 'outside.txt');
writeFileSync(outside, 'outside data');

const { readTool } = await import(join(backendDir, 'src/tools/core/read.ts'));
const { writeTool } = await import(join(backendDir, 'src/tools/core/write.ts'));
const sb = await import(join(backendDir, 'src/tools/core/file-sandbox.ts'));

const ctx = (agentId, extra = {}) => ({ workspaceDir: dir, agentId, ...extra });
const read = (agentId, path, extra) => readTool.execute({ path }, ctx(agentId, extra));
const write = (agentId, path, content, extra) => writeTool.execute({ path, content }, ctx(agentId, extra));
const ws = (agentId) => join(dir, '.data', 'workspaces', agentId);

test('write inside the workspace works; workspace is created 0700; read returns it', async () => {
  const w = await write('a1', 'notes/today.md', 'hello');
  assert.equal(w.error, undefined, w.content[0].text);
  assert.equal(readFileSync(join(ws('a1'), 'notes', 'today.md'), 'utf8'), 'hello');
  assert.equal(statSync(ws('a1')).mode & 0o777, 0o700);
  assert.equal(statSync(join(ws('a1'), 'notes', 'today.md')).mode & 0o777, 0o600);
  const r = await read('a1', 'notes/today.md');
  assert.equal(r.error, undefined);
  assert.equal(r.content[0].text, 'hello');
  assert.equal(r.details.path, join('notes', 'today.md'));
});

test('path traversal and absolute paths outside the workspace are refused', async () => {
  for (const p of ['../../../.env', '../../agent-player.db', '../../../outside.txt', outside, '/etc/passwd', 'notes/../../../../.env']) {
    const r = await read('a1', p);
    assert.ok(r.error, `read ${p} must fail`);
    assert.doesNotMatch(r.content[0].text, /not-a-real-secret|outside data/);
  }
  const w = await write('a1', '../../../escaped.txt', 'x');
  assert.ok(w.error);
  assert.equal(existsSync(join(dir, 'escaped.txt')), false);
  const abs = await write('a1', join(dir, 'abs.txt'), 'x');
  assert.ok(abs.error);
  assert.equal(existsSync(join(dir, 'abs.txt')), false);
});

test('a sibling folder with the same prefix is not inside (separator-aware)', async () => {
  mkdirSync(ws('a1-evil'), { recursive: true });
  writeFileSync(join(ws('a1-evil'), 'secret.txt'), 'sibling secret');
  await write('a1', 'x.txt', 'x');
  const r = await read('a1', '../a1-evil/secret.txt');
  assert.ok(r.error);
  assert.match(r.content[0].text, /outside the workspace/);
  assert.equal(sb.isInside('/work', '/work-evil/a'), false);
  assert.equal(sb.isInside('/work', '/work/a'), true);
  assert.equal(sb.isInside('/work', '/work'), true);
  assert.equal(sb.isInside('/work', '/'), false);
});

test('agents cannot read each other\'s workspaces', async () => {
  await write('agent-a', 'private.txt', 'from a');
  const r = await read('agent-b', '../agent-a/private.txt');
  assert.ok(r.error);
  assert.doesNotMatch(r.content[0].text, /from a/);
});

test('symlinks pointing outside the workspace are refused (read and write)', async () => {
  await write('s1', 'keep.txt', 'k');
  symlinkSync(outside, join(ws('s1'), 'link.txt'));
  symlinkSync(dir, join(ws('s1'), 'linkdir'));
  symlinkSync(join(dir, '.env'), join(ws('s1'), 'innocent.txt'));
  const r1 = await read('s1', 'link.txt');
  assert.ok(r1.error);
  assert.match(r1.content[0].text, /outside the workspace/);
  const r2 = await read('s1', 'linkdir/.env');
  assert.ok(r2.error);
  const r3 = await read('s1', 'innocent.txt');
  assert.ok(r3.error);
  assert.doesNotMatch(r3.content[0].text, /not-a-real-secret/);
  const w1 = await write('s1', 'linkdir/planted.txt', 'x');
  assert.ok(w1.error);
  assert.equal(existsSync(join(dir, 'planted.txt')), false);
  const w2 = await write('s1', 'link.txt', 'overwrite');
  assert.ok(w2.error);
  assert.equal(readFileSync(outside, 'utf8'), 'outside data');
  // A symlink that stays inside the workspace is fine.
  symlinkSync(join(ws('s1'), 'keep.txt'), join(ws('s1'), 'alias.txt'));
  const r4 = await read('s1', 'alias.txt');
  assert.equal(r4.error, undefined);
  assert.equal(r4.content[0].text, 'k');
});

test('NUL and control characters in the path are refused', async () => {
  for (const p of ['a\u0000.txt', 'a\n.txt', 'a\u001b.txt', '', '   ']) {
    assert.ok((await read('a1', p)).error, JSON.stringify(p));
    assert.ok((await write('a1', p, 'x')).error, JSON.stringify(p));
  }
  assert.ok((await read('a1', undefined)).error);
});

test('the always-deny list holds inside the workspace and with a wider read root', async () => {
  const denied = ['.env', '.env.local', 'sub/.env.production', 'agent.db', 'agent.db-wal', 'x.sqlite', '.git/config',
    'id_rsa', 'id_ed25519.pub', '.ssh/config', 'credentials.json', 'conf/credentials', 'server.pem', 'tls.key',
    'auth.json', 'cfg/instance.json', '.netrc'];
  for (const p of denied) {
    const w = await write('d1', p, 'x');
    assert.ok(w.error, `write ${p} must be denied`);
    assert.match(w.content[0].text, /denied/i, p);
  }
  // Even when trusted code widens the read root to the whole folder,
  // .env, the DB and the encryption keys stay unreadable.
  for (const p of ['.env', '.data/agent-player.db', '.data/encryption/master.key', '.ENV', '.DATA/Encryption/master.key', '.Data/AGENT-PLAYER.DB']) {
    const r = await read('d1', p, { fileReadRoot: dir });
    assert.ok(r.error, `read ${p} must be denied`);
    assert.match(r.content[0].text, /denied/i);
  }
  const ok = await read('d1', 'outside.txt', { fileReadRoot: dir });
  assert.equal(ok.content[0].text, 'outside data');
});

test('write ignores a wider read root: it always stays in the agent workspace', async () => {
  const w = await write('r1', 'here.txt', 'x', { fileReadRoot: dir });
  assert.equal(w.error, undefined);
  assert.equal(existsSync(join(dir, 'here.txt')), false);
  assert.equal(readFileSync(join(ws('r1'), 'here.txt'), 'utf8'), 'x');
  const out = await write('r1', '../../../outside.txt', 'pwned', { fileReadRoot: dir });
  assert.ok(out.error);
  assert.equal(readFileSync(outside, 'utf8'), 'outside data');
});

test('size limits for read and write', async () => {
  const big = 'a'.repeat(sb.MAX_WRITE_BYTES + 1);
  const w = await write('z1', 'big.txt', big);
  assert.ok(w.error);
  assert.match(w.content[0].text, /too large/);
  // CHAT-LIVE-01: over 1 MiB is read in parts; only over MAX_SCAN_BYTES is refused.
  writeFileSync(join(ws('z1'), 'big-ok.txt'), Buffer.alloc(sb.MAX_READ_BYTES + 1, 97));
  assert.equal((await read('z1', 'big-ok.txt')).error, undefined);
  writeFileSync(join(ws('z1'), 'huge.txt'), Buffer.alloc(sb.MAX_SCAN_BYTES + 1, 97));
  const r = await read('z1', 'huge.txt');
  assert.ok(r.error);
  assert.match(r.content[0].text, /too large/);
  assert.ok((await write('z1', 'n.txt', 42)).error, 'non-string content refused');
});

test('directories and missing files give clean errors; odd agent ids get a hashed folder', async () => {
  await write('a1', 'folder/f.txt', 'x');
  assert.match((await read('a1', 'folder')).content[0].text, /^Folder folder \(1 entries\):\nf\.txt/); // CHAT-LIVE-01: a folder lists itself
  assert.match((await read('a1', 'nope.txt')).content[0].text, /not found/i);
  assert.equal(sb.workspaceDirName('../../etc'), sb.workspaceDirName('../../etc'));
  assert.match(sb.workspaceDirName('../../etc'), /^h-[0-9a-f]{32}$/);
  assert.equal(sb.workspaceDirName(undefined), '_default');
  const w = await write('../../evil', 'f.txt', 'x');
  assert.equal(w.error, undefined);
  assert.equal(existsSync(join(dir, 'f.txt')), false);
});

test('secrets.env, any *.env file and the data folder outside workspaces are denied (INST-02)', async () => {
  writeFileSync(join(dir, '.data', 'secrets.env'), 'JWT_SECRET=not-a-real-secret\n');
  writeFileSync(join(dir, '.data', 'instance.json'), '{"secret":"not-a-real-secret"}');
  mkdirSync(join(dir, '.data', 'logs'), { recursive: true });
  writeFileSync(join(dir, '.data', 'logs', 'agent-player.log'), 'not-a-real-secret');
  writeFileSync(join(dir, 'prod.env'), 'X=not-a-real-secret\n');
  for (const p of ['secrets.env', 'conf/prod.env', 'SECRETS.ENV', 'x.Env']) {
    const w = await write('e1', p, 'x');
    assert.ok(w.error, `write ${p} must be denied`);
    assert.match(w.content[0].text, /denied/i, p);
  }
  // On a case-sensitive disk (Linux) .DATA is another, missing folder: still refused, maybe as not found.
  const caseInsensitive = existsSync(join(dir, '.DATA'));
  for (const p of ['.data/secrets.env', '.data/instance.json', '.data/logs/agent-player.log', 'prod.env',
    '.DATA/Secrets.env', '.Data/LOGS/agent-player.log']) {
    const r = await read('e1', p, { fileReadRoot: dir });
    assert.ok(r.error, `read ${p} must be denied`);
    if (caseInsensitive || p === p.toLowerCase()) assert.match(r.content[0].text, /denied/i, p);
    assert.doesNotMatch(r.content[0].text, /not-a-real-secret/);
  }
  // a read root inside .data (but not a workspace) exposes nothing either
  const r = await read('e1', 'agent-player.log', { fileReadRoot: join(dir, '.data', 'logs') });
  assert.ok(r.error);
  // a symlink in the workspace that points into .data is refused
  await write('e1', 'keep.txt', 'mine');
  symlinkSync(join(dir, '.data', 'logs', 'agent-player.log'), join(ws('e1'), 'link.log'));
  assert.ok((await read('e1', 'link.log', { fileReadRoot: dir })).error);
  // workspaces stay usable, including from a wider read root
  assert.equal((await read('e1', 'keep.txt')).content[0].text, 'mine');
  assert.equal((await read('e1', '.data/workspaces/e1/keep.txt', { fileReadRoot: dir })).content[0].text, 'mine');
  assert.equal(sb.isProtectedDataPath(join(dir, '.data', 'secrets.env')), true);
  assert.equal(sb.isProtectedDataPath(join(dir, '.data', 'workspaces', 'e1', 'keep.txt')), false);
  assert.equal(sb.isProtectedDataPath(join(dir, 'outside.txt')), false);
});

test('with AGENT_PLAYER_DATA_DIR set, every protected data folder is refused (read, write, symlink); exec-policy agrees', async () => {
  // RUN-ISO: the data root, the legacy <cwd>/.data and dirname(DATABASE_PATH)
  // all stay off limits; the shared protectedDataDirs() list drives both
  // the file sandbox and exec-policy. Workspaces (now under the root) stay usable.
  const root = join(dir, 'isoroot');
  const dbDir = join(dir, 'dbdir');
  const dirs = { legacy: join(dir, '.data'), root, db: dbDir };
  for (const d of Object.values(dirs)) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'note.txt'), 'not-a-real-secret');
  }
  const saved = { root: process.env.AGENT_PLAYER_DATA_DIR, db: process.env.DATABASE_PATH };
  process.env.AGENT_PLAYER_DATA_DIR = root;
  process.env.DATABASE_PATH = join(dbDir, 'main.sqlite');
  try {
    const { protectedDataDirs } = await import(join(backendDir, 'src/config/data-root.ts'));
    const { isInsideDataDir } = await import(join(backendDir, 'src/tools/exec-policy.ts'));
    const isoWs = join(root, 'workspaces', 'iso1');

    // The workspaces subtree stays usable (directly and from a wider read root).
    const w = await write('iso1', 'ok.txt', 'fine');
    assert.equal(w.error, undefined, w.content[0].text);
    assert.equal(readFileSync(join(isoWs, 'ok.txt'), 'utf8'), 'fine');
    assert.equal((await read('iso1', 'ok.txt')).content[0].text, 'fine');
    assert.equal((await read('iso1', 'isoroot/workspaces/iso1/ok.txt', { fileReadRoot: dir })).content[0].text, 'fine');
    assert.equal(sb.isProtectedDataPath(join(isoWs, 'ok.txt')), false);

    for (const [name, d] of Object.entries(dirs)) {
      const rel = join(d, 'note.txt').slice(dir.length + 1);
      const r = await read('iso1', rel, { fileReadRoot: dir });
      assert.ok(r.error, `read ${rel} must be refused`);
      assert.doesNotMatch(r.content[0].text, /not-a-real-secret/);
      const wOut = await write('iso1', `../../../${rel}`, 'x');
      assert.ok(wOut.error, `write into ${name} must be refused`);
      assert.equal(readFileSync(join(d, 'note.txt'), 'utf8'), 'not-a-real-secret');

      // A symlink inside the workspace that points into the protected folder.
      symlinkSync(d, join(isoWs, `link-${name}`));
      const rl = await read('iso1', `link-${name}/note.txt`, { fileReadRoot: dir });
      assert.ok(rl.error, `read through link-${name} must be refused`);
      assert.doesNotMatch(rl.content[0].text, /not-a-real-secret/);
      const wl = await write('iso1', `link-${name}/planted.txt`, 'x');
      assert.ok(wl.error, `write through link-${name} must be refused`);
      assert.equal(existsSync(join(d, 'planted.txt')), false);
      // The predicate itself, for an existing file, a file not created yet and the symlinked alias.
      for (const p of [join(d, 'note.txt'), join(d, 'new', 'file.txt'), join(isoWs, `link-${name}`, 'note.txt'), join(isoWs, `link-${name}`, 'new.txt')]) {
        assert.equal(sb.isProtectedDataPath(p), true, `sandbox: ${p}`);
        assert.equal(isInsideDataDir(p), true, `exec-policy: ${p}`);
      }
    }

    // Parity: both gates refuse every folder of the one shared list.
    const list = protectedDataDirs();
    for (const d of Object.values(dirs)) assert.ok(list.includes(realpathSync(d)), `${d} is in the shared list`);
    for (const d of list) {
      assert.equal(sb.isProtectedDataPath(join(d, 'probe.txt')), true, `sandbox refuses ${d}`);
      assert.equal(isInsideDataDir(join(d, 'probe.txt')), true, `exec-policy refuses ${d}`);
    }
  } finally {
    if (saved.root === undefined) delete process.env.AGENT_PLAYER_DATA_DIR; else process.env.AGENT_PLAYER_DATA_DIR = saved.root;
    if (saved.db === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = saved.db;
  }
});
