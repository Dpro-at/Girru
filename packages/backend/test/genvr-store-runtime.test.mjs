import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-genvr-store-'));
process.env.HOME = root; process.env.USERPROFILE = root;
process.env.AGENT_PLAYER_DATA_DIR = path.join(root, 'data');
process.env.DATABASE_PATH = path.join(root, 'data/db.sqlite');
process.env.JWT_SECRET = randomBytes(64).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
const { startGenvrInstall, removeGenvrRuntime, genvrRuntimeStatus } = await import('../src/services/genvr-runtime.ts');
const { installedGenvrRuntime } = await import('../src/config/genvr-runtime-path.cjs');
const { runtimeUrlAllowed } = await import('../src/services/store-repo.ts');
test.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
const sha = data => createHash('sha256').update(data).digest('hex');
const entry = 'export const fixture = true;';
const version = '0.3.0-preview.20';
function tar(files) {
  const blocks = [];
  for (const [name, body, type = '0', link = ''] of files) {
    const data = Buffer.from(body), h = Buffer.alloc(512);
    h.write(name); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156); if(link)h.write(link,157); h.write('ustar\0', 257); h.write('00', 263);
    h.write([...h].reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
const sdkFiles = () => [
  ['package/package.json', JSON.stringify({ name: '3d-world-sdk', version })],
  ['package/dist/mcp.js', entry], ['package/dist/studio.js', '// fixture'], ['package/dist/studio.css', 'body {}'],
  ['package/live-studio-bridge.mjs', '// fixture'], ['package/local-voice.mjs', '// fixture'], ['package/LICENSE', 'Fixture only'], ['package/README.md', 'Fixture only'],
];
function fixture(name, files = sdkFiles()) {
  const bytes = tar(files), cache = path.join(root, name), pin = { version, archiveSha256: sha(bytes), entrySha256: sha(entry), size: bytes.length };
  const runtime = { version, protocolVersion: 1, archives: { 'darwin-arm64': { url: `https://github.com/Dpro-at/genvr-world-sdk/releases/download/v${version}/3d-world-sdk-${version}.tgz`, sha256: pin.archiveSha256, size: pin.size } } };
  const repo = async () => ({ index: null, fresh: true, asOf: null, runtimes: { 'girru:genvr': runtime } });
  const fetch = async () => ({ ok: true, status: 200, body: (async function* () { yield bytes.subarray(0, 13); yield bytes.subarray(13); })() });
  return { options: { root: cache, pin, platform: 'darwin-arm64', repo, fetch }, bytes, runtime };
}
async function done(result) {
  assert.equal(result.ok, true);
  for (let i = 0; i < 1000 && !result.job.done; i++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(result.job.done, true); return result.job;
}

test('SDK release addresses are narrowly scoped to matching tag and package version', () => {
  assert.equal(runtimeUrlAllowed(`https://github.com/Dpro-at/genvr-world-sdk/releases/download/v${version}/3d-world-sdk-${version}.tgz`), true);
  for (const url of [`https://github.com/elsewhere/genvr-world-sdk/releases/download/v${version}/3d-world-sdk-${version}.tgz`, `https://github.com/Dpro-at/genvr-world-sdk/releases/download/v${version}/3d-world-sdk-0.3.0-preview.21.tgz`, `https://github.com/Dpro-at/genvr-world-sdk/releases/download/v${version}/3d-world-sdk-${version}.tgz?token=fixture`]) assert.equal(runtimeUrlAllowed(url), false);
});
test('install, shared path resolution and remove leave project/account files untouched', async () => {
  const f = fixture('lifecycle'), project = path.join(root, 'world.json'); fs.writeFileSync(project, '{"saved":true}');
  assert.equal((await genvrRuntimeStatus(f.options)).state, 'missing');
  const job = await done(await startGenvrInstall(f.options)); assert.equal(job.ok, true, job.message);
  assert.equal((await genvrRuntimeStatus(f.options)).state, 'installed');
  const installed = installedGenvrRuntime(f.options.root, f.options.pin); assert.ok(installed);
  assert.equal(fs.readFileSync(path.join(installed.packageDir, 'dist/mcp.js'), 'utf8'), entry);
  const removed = removeGenvrRuntime(f.options); assert.equal(removed.ok, true); assert.equal(removed.restart, 'manual');
  assert.equal(fs.existsSync(installed.root), false); assert.equal(installedGenvrRuntime(f.options.root, f.options.pin), null);
  assert.equal(fs.readFileSync(project, 'utf8'), '{"saved":true}');
});
test('checksum and traversal failures never switch a working runtime', async () => {
  const f = fixture('failure'); assert.equal((await done(await startGenvrInstall(f.options))).ok, true);
  const pointer = fs.readFileSync(path.join(f.options.root, 'genvr/current.json'), 'utf8');
  const bad = await done(await startGenvrInstall({ ...f.options, fetch: async () => ({ ok: true, status: 200, body: (async function* () { yield Buffer.alloc(f.bytes.length); })() }) }));
  assert.equal(bad.ok, false); assert.equal(fs.readFileSync(path.join(f.options.root, 'genvr/current.json'), 'utf8'), pointer);
  const escape = fixture('traversal', [...sdkFiles(), ['package/../../outside', 'bad']]);
  assert.equal((await done(await startGenvrInstall(escape.options))).ok, false); assert.equal(fs.existsSync(path.join(root, 'outside')), false);
});
test('a complete archive still cannot replace the hash-pinned MCP entry', async () => {
  const f = fixture('entry-change', sdkFiles().map(([name, body]) => [name, name.endsWith('/mcp.js') ? 'changed' : body]));
  const job = await done(await startGenvrInstall(f.options)); assert.equal(job.ok, false); assert.equal(installedGenvrRuntime(f.options.root, f.options.pin), null);
});
test('concurrent install requests share one job; restart failure preserves committed success', async () => {
  const f = fixture('concurrent'); let gets = 0;
  const options = { ...f.options, fetch: async (...a) => { gets++; return f.options.fetch(...a); }, restart: () => { throw Error('fixture'); } };
  const [a, b] = await Promise.all([startGenvrInstall(options), startGenvrInstall(options)]);
  assert.equal(a.job.id, b.job.id); const job = await done(a); assert.equal(gets, 1); assert.equal(job.ok, true); assert.equal(job.restart, 'manual');
  assert.equal(removeGenvrRuntime(options).ok, true);
});
test('unsupported releases and linked cache folders are refused before writes', async () => {
  const f = fixture('unsupported'); f.runtime.version = '0.3.0-preview.21'; assert.equal((await startGenvrInstall(f.options)).ok, false);
  if (process.platform === 'win32') return;
  const outside = path.join(root, 'outside-cache'); fs.mkdirSync(outside); const link = path.join(root, 'linked-cache'); fs.symlinkSync(outside, link);
  const valid = fixture('linked'); const job = await done(await startGenvrInstall({ ...valid.options, root: link })); assert.equal(job.ok, false); assert.deepEqual(fs.readdirSync(outside), []);
});

test('removal refuses an active install without deleting its previous runtime',async()=>{
 const f=fixture('remove-during-install');assert.equal((await done(await startGenvrInstall(f.options))).ok,true);
 const previous=fs.readFileSync(path.join(f.options.root,'genvr/current.json'),'utf8');let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const adding=await startGenvrInstall({...f.options,fetch:async()=>({ok:true,status:200,body:(async function*(){await gate;yield f.bytes;})()})});
 try{const result=removeGenvrRuntime(f.options);assert.equal(result.ok,false);assert.equal(result.code,'refused');assert.equal(fs.readFileSync(path.join(f.options.root,'genvr/current.json'),'utf8'),previous);}
 finally{release();}
 assert.equal((await done(adding)).ok,true);
});

test('SDK skill symlinks and hardlinks are refused before activation',async()=>{
 for(const type of ['1','2']){
  const f=fixture('linked-sdk-'+type,[...sdkFiles(),['package/skills/link','',''+type,'../../outside']]);
  const job=await done(await startGenvrInstall(f.options));assert.equal(job.ok,false);assert.equal(installedGenvrRuntime(f.options.root,f.options.pin),null);
  assert.equal(fs.existsSync(path.join(root,'outside')),false);
 }
});

test('package metadata retains the 64 KiB bound with descriptor-based reads',async()=>{
 const metadata=JSON.stringify({name:'3d-world-sdk',version});
 for(const [size,ok] of [[65536,true],[65537,false]]){
  const files=sdkFiles().map(([name,body])=>[name,name==='package/package.json'?metadata.padEnd(size,' '):body]);
  const f=fixture('metadata-'+size,files),job=await done(await startGenvrInstall(f.options));
  assert.equal(job.ok,ok);assert.equal(!!installedGenvrRuntime(f.options.root,f.options.pin),ok);
 }
});
