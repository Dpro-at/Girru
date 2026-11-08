// APPS-06 step 2 (board Apps6): adding an app from the Girru Store gets every file, checks it against the
// reviewed index, puts it in the data folder, runs only its own migrations and turns it on; removing it
// takes its code, settings and tables away, and when its tables hold rows asks once and saves a copy first,
// which adding it again brings back. An app may only make tables named after itself.
// No network: the Girru Store is a fake. Run: node --import tsx --test test/store-install.test.mjs
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-store-install-'));
const data = join(dir, '.data');
mkdirSync(join(data, 'multi-agent'), { recursive: true });
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = data;
process.env.DATABASE_PATH = join(data, 'agent-player.db');
process.env.GIRRU_BACKUPS_DIR = join(dir, 'Girru Backups');
process.env.GIRRU_STORE_URL = 'https://store.test';
process.env.JWT_SECRET = randomBytes(64).toString('hex'); // throwaway, test only
process.env.NODE_ENV = 'test';
const quiet = () => {}; console.log = quiet; console.warn = quiet; console.error = quiet;

const sha = (b) => createHash('sha256').update(b).digest('hex');
const pkgFiles = (opts = {}) => ({
  'agentplayer.plugin.json': JSON.stringify({ id: 'notes', name: 'Notes', version: '1.0.0', main: 'index.js', permissions: ['database'] }),
  'index.js': 'export default { async register(api) {} };\n',
  'migrations/001_notes.sql': opts.sql ?? 'CREATE TABLE IF NOT EXISTS app_notes__items (id INTEGER PRIMARY KEY, text TEXT NOT NULL);\n',
});
let served = pkgFiles();
let tamper = false;
const indexFor = (files) => {
  const list = Object.entries(files).map(([path, body]) => ({ path, sha256: sha(Buffer.from(body)), size: Buffer.byteLength(body) })).sort((a, b) => a.path.localeCompare(b.path));
  return { schema: 1, featured: null, collections: [], items: [{ id: 'notes', kind: 'app', source: 'girru', name: 'Notes', summary: 'Short notes for your agents.', description: 'Keeps short notes.', icon: null, maker: 'Someone', verified: true, version: '1.0.0', updated: '2026-10-29', category: 'productivity', permissions: ['Keeps notes in its own tables'], worksWith: [], languages: ['English'], pricing: { model: 'free' }, package: { files: list, sha256: sha(JSON.stringify(list)) } }] };
};
let index = indexFor(served);
globalThis.fetch = async (url) => {
  const u = String(url);
  const body = u === 'https://store.test/index.json' ? JSON.stringify(index) : u.startsWith('https://store.test/apps/notes/package/') ? served[u.slice('https://store.test/apps/notes/package/'.length)] : undefined;
  if (body === undefined) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  const bytes = Buffer.from(tamper && u.endsWith('index.js') ? body + '// changed' : body);
  return { ok: true, status: 200, text: async () => bytes.toString('utf8'), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
};

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
const db = getDatabase();
await db.initialize();
const { readStore, localCatalogue, installFromStore, uninstallFromStore } = await import(join(backendDir, 'src/services/store-catalogue.ts'));
const { addJob, appTables, startAdd } = await import(join(backendDir, 'src/services/store-install.ts'));
const { parsePackage } = await import(join(backendDir, 'src/services/store-repo.ts'));

const store = () => readStore('owner-1', localCatalogue({ home: dir }));
const forget = () => db.prepare("DELETE FROM app_settings WHERE key = 'store.girru-store'").run();
async function add() {
  const x = (await store()).items.find((i) => i.id === 'store:notes');
  const r = await installFromStore('owner-1', 'store:notes', x.hash, { restart: () => false });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.state, 'adding');
  const steps = new Set();
  for (let n = 0; n < 200; n++) { const j = addJob(r.job); steps.add(j.step); if (j.done) return { ...j, steps }; await new Promise((s) => setTimeout(s, 10)); }
  throw new Error('the add did not finish');
}
const table = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

test('add: every file checked, set up in the data folder, its own migrations, turned on', async () => {
  const before = (await store()).items.find((i) => i.id === 'store:notes');
  assert.equal(before.state, 'available');
  const j = await add();
  assert.equal(j.ok, true, j.message); assert.equal(j.restart, 'manual'); assert.match(j.message, /Notes is added\. Start Girru again to finish\./);
  assert.equal(j.step, 'adding');
  assert.ok(existsSync(join(data, 'apps', 'notes', 'index.js')), 'in the data folder');
  assert.ok(!existsSync(join(backendDir, 'extensions', 'notes')), 'never in the program folder');
  assert.ok(!readdirSync(join(data, 'apps')).some((n) => n.startsWith('.')), 'no half-made folders left');
  assert.ok(table('app_notes__items'));
  assert.equal(db.prepare("SELECT enabled FROM extension_configs WHERE extension_id = 'notes'").get().enabled, 1);
  assert.equal((await store()).items.find((i) => i.id === 'store:notes').state, 'installed');
  // Asking for a changed listing is refused.
  const refused = await installFromStore('owner-1', 'store:notes', 'a'.repeat(64));
  assert.equal(refused.ok, false); assert.equal(refused.code, 'changed');
});

test('remove: with rows it asks once, saves a copy, removes everything; adding again brings the rows back', async () => {
  db.prepare("INSERT INTO app_notes__items (text) VALUES ('first'), ('second')").run();
  const asked = await uninstallFromStore('owner-1', 'store:notes', { restart: () => false });
  assert.equal(asked.ok, false); assert.equal(asked.code, 'has_data'); assert.deepEqual(asked.data, [{ table: 'app_notes__items', rows: 2 }]);
  assert.ok(table('app_notes__items'), 'nothing removed before the owner confirms');
  const r = await uninstallFromStore('owner-1', 'store:notes', { confirm: true, restart: () => false });
  assert.equal(r.ok, true); assert.ok(r.copy && existsSync(r.copy));
  assert.match(readFileSync(r.copy, 'utf8'), /second/);
  assert.ok(!table('app_notes__items')); assert.ok(!existsSync(join(data, 'apps', 'notes')));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM extension_configs WHERE extension_id = 'notes'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM extension_migrations WHERE extension_id = 'notes'").get().n, 0);
  assert.equal((await store()).items.find((i) => i.id === 'store:notes').state, 'available');
  const again = await add();
  assert.equal(again.ok, true);
  assert.deepEqual(db.prepare('SELECT text FROM app_notes__items ORDER BY id').all().map((x) => x.text), ['first', 'second'], 'the saved copy came back');
  db.prepare('DELETE FROM app_notes__items').run();
  const quick = await uninstallFromStore('owner-1', 'store:notes', { restart: () => false });
  assert.equal(quick.ok, true, 'no rows: removed at once'); assert.equal(quick.copy, null);
});

test('a file that is not what the store reviewed is never set up', async () => {
  tamper = true;
  const j = await add();
  tamper = false;
  assert.equal(j.ok, false); assert.match(j.message, /not what the Girru Store reviewed/);
  assert.ok(!existsSync(join(data, 'apps', 'notes')));
  assert.ok(!table('app_notes__items'));
});

test('an app may only make tables named after itself; package paths stay inside it', async () => {
  assert.deepEqual(appTables('my-app', ['-- its tables\nCREATE TABLE IF NOT EXISTS app_my_app__rows (id INTEGER, note TEXT DEFAULT \'a;b\');\nCREATE INDEX IF NOT EXISTS app_my_app__rows_note ON app_my_app__rows (note);']), ['app_my_app__rows']);
  for (const bad of [
    'CREATE TABLE IF NOT EXISTS users (id INTEGER)',
    'CREATE TABLE IF NOT EXISTS app_notes__x (id INTEGER); DROP TABLE users',
    'CREATE TABLE IF NOT EXISTS app_notes__x (id INTEGER); INSERT INTO users (id) VALUES (1)',
    "UPDATE users SET role = 'owner'",
    'ALTER TABLE users ADD COLUMN x TEXT',
    'CREATE INDEX IF NOT EXISTS app_notes__i ON users (id)',
    'CREATE TRIGGER app_notes__t AFTER INSERT ON users BEGIN DELETE FROM users; END',
    "ATTACH DATABASE '/tmp/x.db' AS x",
    'PRAGMA writable_schema = 1',
    'CREATE TABLE IF NOT EXISTS "users" (id INTEGER)',
    'CREATE TABLE IF NOT EXISTS app_notes_x (id INTEGER)',
    'CREATE TABLE app_notes__x (id INTEGER)',
  ]) assert.throws(() => appTables('notes', [bad]), undefined, bad);
  // "notes" and "notes-x" can never share tables: app_notes__ is not a prefix of app_notes_x__.
  assert.throws(() => appTables('notes', ['CREATE TABLE IF NOT EXISTS app_notes_x__rows (id INTEGER)']));
  served = pkgFiles({ sql: 'CREATE TABLE IF NOT EXISTS app_notes__ok (id INTEGER);\nDROP TABLE users;\n' });
  index = indexFor(served); forget();
  const j = await add();
  assert.equal(j.ok, false); assert.match(j.message, /does more than make its own tables/);
  assert.ok(!existsSync(join(data, 'apps', 'notes')));
  served = pkgFiles(); index = indexFor(served); forget();
  for (const bad of ['../escape.js', '/etc/passwd.js', 'a/../../b.js', 'run.sh', '.hidden.js']) {
    assert.throws(() => parsePackage({ files: [{ path: 'agentplayer.plugin.json', sha256: 'a'.repeat(64), size: 1 }, { path: bad, sha256: 'b'.repeat(64), size: 1 }], sha256: 'c'.repeat(64) }), bad);
  }
});


test('package paths cannot alias through case folding or Windows name normalization', () => {
  const listing = paths => ({files:paths.map(path=>({path,sha256:'a'.repeat(64),size:1})),sha256:'b'.repeat(64)});
  for(const paths of [
    ['agentplayer.plugin.json','index.js','Index.js'],
    ['agentplayer.plugin.json','Migrations/002_escape.sql'],
    ['agentplayer.plugin.json','migrations/a.sql','Migrations/b.sql'],
    ['agentplayer.plugin.json','AgentPlayer.plugin.json'],
    ['agentplayer.plugin.json','lib/a.js','LIB/b.js'],
    ['agentplayer.plugin.json','migrations./escape.sql'],
    ['agentplayer.plugin.json','CON/escape.sql'],
    ['agentplayer.plugin.json','aux.js'],
    ['agentplayer.plugin.json','lib.js','lib.js/nested.json'],
  ]) assert.throws(()=>parsePackage(listing(paths)),undefined,paths.join(', '));
  assert.doesNotThrow(()=>parsePackage(listing(['agentplayer.plugin.json','lib/First.js','lib/Second.js'])));
});

test('a case-aliased migration is refused before program or SQL activation on every platform', async () => {
  const previous=served;
  try {
    served={...pkgFiles(),'Migrations/002_escape.sql':'CREATE TABLE IF NOT EXISTS escaped_case_marker(id INTEGER);'};
    index=indexFor(served);forget();
    const result=await new Promise(done=>startAdd('notes',{restart:()=>false,onDone:done}));
    assert.equal(result.ok,false);assert.equal(table('escaped_case_marker'),false);
    assert.equal(existsSync(join(data,'apps/notes')),false);
  }finally{served=previous;index=indexFor(served);forget();}
});


test('SQL execution uses the checked in-memory bytes even if the installed file changes', async () => {
  const rename=fs.renameSync,previous=served;
  try {
    served=pkgFiles();index=indexFor(served);forget();
    assert.equal(table('app_notes__items'),false,'the migration must create the table during this test');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM extension_migrations WHERE extension_id='notes' AND filename='001_notes.sql'").get().n,0,'the migration must not be skipped');
    fs.renameSync=(from,to)=>{
      const result=rename(from,to);
      if(String(from).includes('.incoming-notes-')&&to===join(data,'apps/notes'))
        fs.writeFileSync(join(to,'migrations/001_notes.sql'),'CREATE TABLE IF NOT EXISTS escaped_disk_marker(id INTEGER);');
      return result;
    };
    const result=await new Promise(done=>startAdd('notes',{restart:()=>false,onDone:done}));
    assert.equal(result.ok,true,result.message);assert.equal(table('app_notes__items'),true);
    assert.equal(table('escaped_disk_marker'),false,'changed disk SQL is never executed');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM extension_migrations WHERE extension_id='notes' AND filename='001_notes.sql'").get().n,1);
  }finally{fs.renameSync=rename;served=previous;index=indexFor(served);forget();}
});


test('incoming package writes are exclusive and cannot replace a planted symlink', async t=>{
 const original=fs.writeFileSync,previous=served,outside=join(dir,'unrelated-marker.txt');let planted=false,unavailable=false;
 original(outside,'keep synthetic marker');
 try{
  served=pkgFiles();index=indexFor(served);forget();
  fs.writeFileSync=(target,bytes,options)=>{
   if(!planted&&String(target).includes('.incoming-notes-')&&String(target).endsWith(join('index.js'))){try{fs.symlinkSync(outside,target);planted=true;}catch(error){if(process.platform==='win32'&&['EPERM','EACCES','ENOTSUP'].includes(error.code))unavailable=true;throw error;}}
   return original(target,bytes,options);
  };
  const result=await new Promise(done=>startAdd('notes',{restart:()=>false,onDone:done}));if(unavailable){t.skip('Windows symlink creation privilege unavailable; planted-symlink case not exercised');return;}assert.equal(planted,true);assert.equal(result.ok,false);assert.equal(readFileSync(outside,'utf8'),'keep synthetic marker');
 }finally{fs.writeFileSync=original;served=previous;index=indexFor(served);forget();}
});
