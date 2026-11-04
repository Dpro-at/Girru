// CODE-STORE-01 (D-CODE-STORE): the Code app is a Store app. Girru downloads the archive for this
// computer from the release the reviewed index lists, checks its size and SHA-256, unpacks it (plain
// files only, every path inside the folder) into Girru's per-computer app folder, and points
// current.json at it; an update is the same job. No network: the Store and the release are fakes.
// Run: node --import tsx --test test/code-store-install.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-code-store-'));
const data = join(dir, '.data');
const runtimes = join(dir, 'Girru', 'app-runtimes');
mkdirSync(join(data, 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.DATABASE_PATH = join(data, 'agent-player.db');
process.env.GIRRU_STORE_URL = 'https://store.test';
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
delete process.env.GIRRU_APP_RUNTIMES_DIR; delete process.env.GIRRU_CODE_RUNTIME_BUNDLED;
const quiet = () => {}; console.log = quiet; console.warn = quiet; console.error = quiet;

const sha = (b) => createHash('sha256').update(b).digest('hex');
/** A ustar archive written by hand: entries of { name, body?, type? ('0' file, '5' folder, '2' link), link?, mode? }; long names get a pax header. */
function header(name, size, type, mode, link) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write(mode.toString(8).padStart(7, '0') + '\0', 100);
  h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  if (link) h.write(link, 157);
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const padded = (body) => { const pad = (512 - (body.length % 512)) % 512; return pad ? [body, Buffer.alloc(pad)] : [body]; };
function tar(entries) {
  const blocks = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    const type = e.type ?? '0';
    let name = e.name;
    if (Buffer.byteLength(name) > 100) {
      const rest = ` path=${name}\n`;
      let len = Buffer.byteLength(rest) + 1; while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
      const rec = Buffer.from(`${len}${rest}`);
      blocks.push(header('PaxHeader', rec.length, 'x', 0o644), ...padded(rec));
      name = name.slice(0, 90);
    }
    const size = type === '0' ? body.length : 0;
    blocks.push(header(name, size, type, e.mode ?? (type === '5' ? 0o755 : 0o644), e.link));
    if (size) blocks.push(...padded(body));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
const runtimeEntries = (version) => [
  { name: 'nabu/', type: '5' },
  { name: 'nabu/runtime.json', body: JSON.stringify({ protocolVersion: 1, entry: 'dpro/editor-runtime.mjs', version }) },
  { name: 'nabu/dpro/editor-runtime.mjs', body: 'export const protocolVersion = 1;\n' },
  { name: 'editor/out/server-main.js', body: '// server\n' },
  { name: 'editor/product.json', body: '{}' },
  { name: 'editor/node_modules/@vscode/ripgrep/bin/rg', body: '#!/bin/sh\n', mode: 0o755 },
  { name: `editor/extensions/${'a'.repeat(60)}/${'b'.repeat(60)}/package.json`, body: '{}' },
];
const archive = (version, entries = runtimeEntries(version)) => gzipSync(tar(entries));

const URL_BASE = 'https://github.com/Dpro-at/girru-store/releases/download';
let served = {}; // url -> bytes
let tamper = false;
const item = (version, bytes, extra = {}) => ({
  id: 'code', kind: 'app', source: 'girru', name: 'Code', summary: 'The project editor beside your chats.', description: 'Edit your project next to your chats.', icon: 'code', maker: 'Girru', verified: true, version, updated: '2026-11-04', category: 'developer',
  permissions: ['Opens only in the Girru desktop app', 'Edits files in the project folder you open'], worksWith: [], languages: ['English'],
  runtime: { version, protocolVersion: 1, archives: Object.fromEntries(['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'].map((p) => [p, { url: `${URL_BASE}/code-v${version}/girru-code-${version}-${p}.tar.gz`, sha256: sha(bytes), size: bytes.length }])) },
  ...extra,
});
let index = { schema: 1, featured: null, collections: [], items: [] };
function publish(version, bytes = archive(version), extra) {
  index = { ...index, items: [item(version, bytes, extra)] };
  for (const p of ['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64']) served[`${URL_BASE}/code-v${version}/girru-code-${version}-${p}.tar.gz`] = bytes;
}
async function* chunks(bytes) { for (let i = 0; i < bytes.length; i += 700) yield bytes.subarray(i, i + 700); }
const requested = [];
globalThis.fetch = async (url) => {
  const u = String(url); requested.push(u);
  if (u === 'https://store.test/index.json') { const t = JSON.stringify(index); return { ok: true, status: 200, text: async () => t }; }
  let bytes = served[u];
  if (!bytes) return { ok: false, status: 404, text: async () => '', body: null };
  if (tamper) { bytes = Buffer.from(bytes); bytes[bytes.length - 30] ^= 0xff; }
  return { ok: true, status: 200, body: chunks(bytes) };
};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { readStore, localCatalogue, installFromStore, uninstallFromStore } = await import(join(backendDir, 'src/services/store-catalogue.ts'));
const { addJob } = await import(join(backendDir, 'src/services/store-install.ts'));
const { codeRuntimeStatus, unpackTarGz, safeEntryPath, runtimePlatform } = await import(join(backendDir, 'src/services/code-runtime.ts'));
const { parseRuntime, runtimesFrom } = await import(join(backendDir, 'src/services/store-repo.ts'));

db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)');
const forget = () => db.prepare("DELETE FROM app_settings WHERE key = 'store.girru-store'").run();
const codeItem = async () => (await readStore('owner-1', localCatalogue({ home: dir }))).items.find((i) => i.id === 'girru:code');
async function finish(job) { for (let i = 0; i < 400; i++) { const j = addJob(job); if (j?.done) return j; await new Promise((r) => setTimeout(r, 10)); } throw new Error('job did not finish'); }
async function install() {
  const x = await codeItem();
  const r = await installFromStore('owner-1', 'girru:code', x.hash);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.state, 'adding');
  return finish(r.job);
}
const current = () => JSON.parse(readFileSync(join(runtimes, 'code', 'current.json'), 'utf8'));

test('outside the desktop app Code stays as it was (included, nothing to install)', async () => {
  forget(); publish('1.0.0');
  assert.equal((await codeItem()).state, 'included');
  assert.equal((await codeRuntimeStatus()).state, 'unavailable');
  const x = await codeItem();
  const r = await installFromStore('owner-1', 'girru:code', x.hash);
  assert.equal(r.ok, false); assert.equal(r.code, 'not_installable');
});

test('in the desktop app without Code: the Store offers it only when it has this computer\'s archive', async () => {
  process.env.GIRRU_APP_RUNTIMES_DIR = runtimes;
  forget(); index = { ...index, items: [] };
  assert.equal((await codeItem()).state, 'elsewhere');
  assert.equal((await codeRuntimeStatus()).state, 'unsupported');
  forget(); publish('1.0.0');
  const x = await codeItem();
  assert.equal(x.state, 'available'); assert.equal(x.version, '1.0.0');
  const s = await codeRuntimeStatus();
  assert.equal(s.state, 'missing'); assert.equal(s.platform, runtimePlatform()); assert.equal(s.available.version, '1.0.0');
});

test('install: downloads this computer\'s archive, checks it, unpacks it and makes it current', async () => {
  forget(); publish('1.0.0'); requested.length = 0;
  const x = await codeItem();
  const r = await installFromStore('owner-1', 'girru:code', x.hash);
  assert.equal(r.ok, true);
  const j = await finish(r.job);
  assert.equal(j.ok, true, j.message); assert.equal(j.restart, 'none'); assert.match(j.message, /Code 1\.0\.0 is installed/);
  assert.equal(j.received, j.total);
  assert.deepEqual(requested.filter((u) => u.includes('/releases/')), [`${URL_BASE}/code-v1.0.0/girru-code-1.0.0-${runtimePlatform()}.tar.gz`]);
  const c = current();
  assert.equal(c.version, '1.0.0'); assert.match(c.dir, /^1\.0\.0-[a-f0-9]{8}$/);
  const root = join(runtimes, 'code', c.dir);
  assert.equal(readFileSync(join(root, 'editor/product.json'), 'utf8'), '{}');
  assert.ok(existsSync(join(root, `editor/extensions/${'a'.repeat(60)}/${'b'.repeat(60)}/package.json`)), 'long names through pax headers');
  if (process.platform !== 'win32') { const { statSync } = await import('node:fs'); assert.equal(statSync(join(root, 'editor/node_modules/@vscode/ripgrep/bin/rg')).mode & 0o777, 0o755); }
  assert.deepEqual(readdirSync(join(runtimes, 'code')).filter((n) => n.startsWith('.')), [], 'no leftovers');
  assert.equal((await codeItem()).state, 'installed');
  const s = await codeRuntimeStatus();
  assert.equal(s.state, 'installed'); assert.equal(s.version, '1.0.0'); assert.equal(s.update, null);
});

test('update: a newer Store version shows as the update and replaces the old folder', async () => {
  forget(); publish('1.1.0');
  const x = await codeItem();
  assert.equal(x.state, 'installed'); assert.equal(x.update, '1.1.0');
  assert.equal((await codeRuntimeStatus()).update, '1.1.0');
  const old = current().dir;
  const j = await install();
  assert.equal(j.ok, true, j.message);
  assert.equal(current().version, '1.1.0');
  assert.ok(!existsSync(join(runtimes, 'code', old)), 'the old version is removed');
  assert.equal((await codeRuntimeStatus()).update, null);
});

test('a download that does not match the reviewed checksum is never unpacked', async () => {
  forget(); publish('1.2.0'); tamper = true;
  try {
    const j = await install();
    assert.equal(j.ok, false); assert.match(j.message, /does not match the Girru Store checksum/);
  } finally { tamper = false; }
  assert.equal(current().version, '1.1.0', 'the installed Code is untouched');
  assert.deepEqual(readdirSync(join(runtimes, 'code')).filter((n) => n.startsWith('.')), []);
});

test('a short or oversized download, or a different version inside, is refused', async () => {
  const good = archive('1.3.0');
  forget(); publish('1.3.0', good);
  for (const p of Object.keys(served)) if (p.includes('1.3.0')) served[p] = good.subarray(0, good.length - 10);
  assert.match((await install()).message, /stopped at .* of .*check the internet connection/);
  forget(); publish('1.3.0', good);
  for (const p of Object.keys(served)) if (p.includes('1.3.0')) served[p] = Buffer.concat([good, Buffer.alloc(5)]);
  assert.match((await install()).message, /larger than the Girru Store lists/);
  const wrong = archive('1.3.0', runtimeEntries('9.9.9'));
  forget(); publish('1.3.0', wrong);
  assert.match((await install()).message, /different Code version/);
  assert.equal(current().version, '1.1.0');
});

test('archives with links, escaping paths or special files are refused', async () => {
  const cases = [
    [[...runtimeEntries('1.4.0'), { name: 'editor/evil', type: '2', link: '/etc/passwd' }], /link or a special file/],
    [[...runtimeEntries('1.4.0'), { name: '../outside.txt', body: 'x' }], /leaves the app folder/],
    [[...runtimeEntries('1.4.0'), { name: '/abs.txt', body: 'x' }], /leaves the app folder/],
    [[...runtimeEntries('1.4.0'), { name: 'editor/a\\b', body: 'x' }], /leaves the app folder/],
    [[...runtimeEntries('1.4.0'), { name: 'editor/c:stream', body: 'x' }], /leaves the app folder/],
    [[...runtimeEntries('1.4.0'), { name: 'editor/fifo', type: '6' }], /link or a special file/],
    [[{ name: 'just/a/file.txt', body: 'x' }], /not a Code editor/],
  ];
  for (const [entries, message] of cases) {
    forget(); publish('1.4.0', archive('1.4.0', entries));
    const j = await install();
    assert.equal(j.ok, false); assert.match(j.message, message);
  }
  assert.ok(!existsSync(join(dir, 'outside.txt')) && !existsSync(join(runtimes, 'outside.txt')) && !existsSync(join(runtimes, 'code', 'outside.txt')));
  assert.equal(current().version, '1.1.0');
  for (const bad of ['', '/x', '../x', 'a/../b', 'a/./b', 'a\\b', 'c:x', 'a//b', 'a\0b']) assert.equal(safeEntryPath(bad), null, bad);
  assert.deepEqual(safeEntryPath('./a/b/'), ['a', 'b']);
});

test('the unpacker keeps to its limits', async () => {
  const file = join(dir, 'limits.tar.gz');
  writeFileSync(file, archive('1.0.0'));
  const to = (n) => { const d = join(dir, `unpack-${n}`); mkdirSync(d); return d; };
  await assert.rejects(unpackTarGz(file, to(1), { entries: 3 }), /too many files/);
  await assert.rejects(unpackTarGz(file, to(2), { bytes: 20 }), /more than Girru allows/);
  const r = await unpackTarGz(file, to(3));
  assert.equal(r.files, 6);
  const broken = Buffer.from(tar(runtimeEntries('1.0.0'))); broken[600] ^= 0x01; // a header byte: the checksum no longer matches
  writeFileSync(file, gzipSync(broken));
  await assert.rejects(unpackTarGz(file, to(4)), /damaged/);
});

test('the Add is bound to what the owner saw; the Store lists only girru-store release archives', async () => {
  forget(); publish('1.5.0');
  const r = await installFromStore('owner-1', 'girru:code', 'f'.repeat(64));
  assert.equal(r.ok, false); assert.equal(r.code, 'changed');
  const ok = { version: '1.0.0', protocolVersion: 1, archives: { 'darwin-arm64': { url: `${URL_BASE}/v1/a.tar.gz`, sha256: 'a'.repeat(64), size: 10 } } };
  assert.equal(parseRuntime(ok).version, '1.0.0');
  for (const url of ['https://github.com/someone/else/releases/download/v1/a.tar.gz', 'http://github.com/a/b/releases/download/v1/a.tar.gz', 'https://example.com/a/b/releases/download/v1/a.tar.gz', 'https://github.com/a/b/raw/main/a.tar.gz', 'https://github.com/a/b/releases/download/v1/a.zip', 'https://user:pw@github.com/a/b/releases/download/v1/a.tar.gz', `${URL_BASE}/v1/a.tar.gz?x=1`]) {
    assert.throws(() => parseRuntime({ ...ok, archives: { 'darwin-arm64': { ...ok.archives['darwin-arm64'], url } } }), /store runtime/, url);
  }
  assert.throws(() => parseRuntime({ ...ok, archives: { 'beos-ppc': ok.archives['darwin-arm64'] } }), /store runtime/);
  assert.throws(() => parseRuntime({ ...ok, protocolVersion: 2 }), /store runtime/);
  assert.deepEqual(Object.keys(runtimesFrom({ items: [{ id: 'code', kind: 'app', runtime: { ...ok, version: 'latest' } }] })), []);
});

test('a Girru that carries Code inside never downloads it', async () => {
  process.env.GIRRU_CODE_RUNTIME_BUNDLED = '1';
  try {
    forget(); publish('1.6.0');
    const x = await codeItem();
    assert.equal(x.state, 'included'); assert.equal(x.update, null);
    assert.equal((await codeRuntimeStatus()).state, 'bundled');
    requested.length = 0;
    const r = await installFromStore('owner-1', 'girru:code', x.hash);
    assert.equal(r.ok, false);
    assert.deepEqual(requested.filter((u) => u.includes('/releases/')), []);
  } finally { delete process.env.GIRRU_CODE_RUNTIME_BUNDLED; }
});

test('routes: GET /api/apps/code is owner-only; the job reports download progress', async () => {
  const { default: Fastify } = await import('fastify'), { registerAuthGate } = await import(join(backendDir, 'src/auth/auth-gate.ts')), { generateToken } = await import(join(backendDir, 'src/auth/jwt.ts')), { storeRoutes } = await import(join(backendDir, 'src/api/routes/store.ts'));
  for (const [id, role] of [['code-owner', 'owner'], ['code-admin', 'admin']]) db.prepare("INSERT OR IGNORE INTO users(id,email,username,password_hash,role,status) VALUES(?,?,?,'fixture',?,'active')").run(id, id + '@example.invalid', id, role);
  const app = Fastify(); registerAuthGate(app); await app.register(storeRoutes, { home: dir }); await app.ready();
  try {
    const h = (id) => ({ authorization: 'Bearer ' + generateToken(id, 1) });
    assert.equal((await app.inject({ url: '/api/apps/code' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/apps/code', headers: h('code-admin') })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/apps/code?x=1', headers: h('code-owner') })).statusCode, 400);
    forget(); publish('2.0.0');
    const s = (await app.inject({ url: '/api/apps/code', headers: h('code-owner') })).json();
    assert.equal(s.state, 'installed'); assert.equal(s.version, '1.1.0'); assert.equal(s.update, '2.0.0'); assert.equal(s.available.version, '2.0.0');
    const item = (await app.inject({ url: '/api/store', headers: h('code-owner') })).json().items.find((x) => x.id === 'girru:code');
    const r = await app.inject({ method: 'POST', url: '/api/store/install', headers: h('code-owner'), payload: { id: 'girru:code', hash: item.hash } });
    assert.equal(r.statusCode, 200, r.body);
    await finish(r.json().job);
    const j = (await app.inject({ url: `/api/store/install/${r.json().job}`, headers: h('code-owner') })).json();
    assert.equal(j.ok, true, j.message); assert.equal(j.received, j.total); assert.ok(j.total > 0);
    assert.equal((await app.inject({ url: '/api/apps/code', headers: h('code-owner') })).json().version, '2.0.0');
  } finally { await app.close(); }
});

test('an archive made by the release packer installs (its .bin links left out, other links refused)', async () => {
  const { createRequire } = await import('node:module');
  const { packCodeRuntime } = createRequire(import.meta.url)(join(backendDir, '../desktop/scripts/pack-code-runtime.cjs'));
  const { symlinkSync, statSync } = await import('node:fs');
  const staged = join(dir, 'staged-runtime');
  const put = (rel, text) => { mkdirSync(join(staged, rel, '..'), { recursive: true }); writeFileSync(join(staged, rel), text); };
  put('nabu/runtime.json', JSON.stringify({ name: 'nabu-code-runtime', protocolVersion: 1, editorVersion: '1.143.1', entry: 'dpro/editor-runtime.mjs' }));
  put('nabu/dpro/editor-runtime.mjs', 'export const protocolVersion = 1;\n');
  put('editor/out/server-main.js', '// server\n'.repeat(2000));
  put('editor/product.json', '{}');
  put(`editor/extensions/${'long-extension-name-'.repeat(6)}/package.json`, '{}');
  put('editor/node_modules/tool/cli.js', '#!/usr/bin/env node\n');
  mkdirSync(join(staged, 'editor/node_modules/.bin'), { recursive: true });
  symlinkSync('../tool/cli.js', join(staged, 'editor/node_modules/.bin/tool'));
  const out = join(dir, 'packed');
  const info = await packCodeRuntime({ runtime: staged, version: '3.0.0', platform: runtimePlatform(), out });
  assert.equal(info.skippedLinks, 1);
  const bytes = readFileSync(join(out, info.name));
  assert.equal(bytes.length, info.size); assert.equal(sha(bytes), info.sha256);
  assert.deepEqual(JSON.parse(readFileSync(join(out, info.name.replace('.tar.gz', '.json')), 'utf8')).sha256, info.sha256);
  forget(); publish('3.0.0', bytes);
  const j = await install();
  assert.equal(j.ok, true, j.message);
  const root = join(runtimes, 'code', current().dir);
  assert.equal(JSON.parse(readFileSync(join(root, 'nabu/runtime.json'), 'utf8')).version, '3.0.0');
  assert.ok(existsSync(join(root, `editor/extensions/${'long-extension-name-'.repeat(6)}/package.json`)));
  assert.ok(!existsSync(join(root, 'editor/node_modules/.bin/tool')));
  assert.equal(statSync(join(root, 'editor/out/server-main.js')).size, '// server\n'.length * 2000);
  symlinkSync('/etc/hosts', join(staged, 'editor/hosts-link'));
  await assert.rejects(packCodeRuntime({ runtime: staged, version: '3.0.1', platform: runtimePlatform(), out }), /link outside node_modules\/\.bin/);
});


test('no network: a clear message, nothing left behind', async () => {
  forget(); publish('5.0.0');
  const x = await codeItem();
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { if (String(url).includes('/releases/')) throw new TypeError('fetch failed'); return real(url); };
  try {
    const r = await installFromStore('owner-1', 'girru:code', x.hash);
    const j = await finish(r.job);
    assert.equal(j.ok, false); assert.match(j.message, /could not reach the download; check the internet connection/);
  } finally { globalThis.fetch = real; }
  assert.deepEqual(readdirSync(join(runtimes, 'code')).filter((n) => n.startsWith('.')), []);
});

test('remove: only Girru\'s code folder goes; the Store offers Code again, and it installs again', async () => {
  forget(); publish('5.0.0');
  assert.equal((await install()).ok, true);
  const projects = join(dir, 'my-project'); mkdirSync(projects, { recursive: true }); writeFileSync(join(projects, 'keep.txt'), 'mine');
  assert.equal((await codeItem()).state, 'installed');
  const r = await uninstallFromStore('owner-1', 'girru:code');
  assert.deepEqual(r, { ok: true, state: 'available' });
  assert.ok(!existsSync(join(runtimes, 'code')));
  assert.equal(readFileSync(join(projects, 'keep.txt'), 'utf8'), 'mine');
  assert.equal((await codeItem()).state, 'available');
  assert.equal((await codeRuntimeStatus()).state, 'missing');
  assert.equal((await uninstallFromStore('owner-1', 'girru:code')).code, 'not_found');
  assert.equal((await install()).ok, true);
  assert.equal(current().version, '5.0.0');
  process.env.GIRRU_CODE_RUNTIME_BUNDLED = '1';
  try { assert.equal((await uninstallFromStore('owner-1', 'girru:code')).code, 'not_installable'); assert.ok(existsSync(join(runtimes, 'code', 'current.json'))); }
  finally { delete process.env.GIRRU_CODE_RUNTIME_BUNDLED; }
});
