// APPS-06 step 1: the Store reads the Girru Store repository's index.json (github.com/Dpro-at/girru-store),
// keeps the last good copy, and shows it with its date when there is no internet. Reading never installs.
// No network: GitHub is a fake. Run: node --import tsx --test test/store-repo.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-store-repo-'));
process.env.AGENT_PLAYER_DATA_DIR = join(dir, '.data');
process.env.HOME = dir;
process.env.GIRRU_GENVR_BUNDLED = '0'; delete process.env.GIRRU_APP_RUNTIMES_DIR;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = 'x'.repeat(64); // throwaway, test only
process.env.NODE_ENV = 'test';
mkdirSync(join(dir, '.data'), { recursive: true });
globalThis.fetch = async (url) => { throw new Error(`unexpected network call in test: ${url}`); };
const quiet = () => {}; console.log = quiet; console.warn = quiet; console.error = quiet;

const { getDatabase } = await import(join(backendDir, 'src/db/database.ts'));
await getDatabase().initialize();
const saved = () => getDatabase().prepare("SELECT value FROM app_settings WHERE key = 'store.girru-store'").get()?.value ?? '';
const { readStoreRepo, fromRepo, STORE_INDEX_URL } = await import(join(backendDir, 'src/services/store-repo.ts'));
const { localCatalogue, readStore, installFromStore } = await import(join(backendDir, 'src/services/store-catalogue.ts'));

const item = (id, extra = {}) => ({ id, kind: 'app', source: 'girru', name: id[0].toUpperCase() + id.slice(1), summary: `${id} summary`, description: `${id} from the repository`, icon: null, maker: 'Girru', verified: true, version: null, updated: '2026-10-29', category: 'developer', permissions: [`${id} permission`], worksWith: [], languages: ['English'], pricing: { model: 'free' }, ...extra });
const REPO = { schema: 1, featured: 'genvr', collections: [{ id: 'new', title: 'New in the store', items: ['notes', '../bad'] }], items: [item('genvr', { category: 'worlds', description: 'GenVR as the repository says it' }), item('notes', { maker: 'Someone' })] };
let calls = 0;
const github = (body, ok = true) => async (url, init) => { calls++; assert.equal(url, STORE_INDEX_URL); assert.ok(init.signal); return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) }; };
const down = async () => { calls++; throw new Error('offline'); };

test('the repository index becomes Girru catalogue items: girru: ids, pricing ignored, bad ids refused', () => {
  const x = fromRepo(REPO);
  assert.deepEqual(x.items.map((i) => i.id), ['girru:genvr', 'girru:notes']);
  assert.equal(x.featured, 'girru:genvr');
  assert.deepEqual(x.collections[0].items, ['girru:notes'], 'ids that are not items are dropped');
  assert.ok(!('pricing' in x.items[0]), 'paid apps are not open yet');
  assert.throws(() => fromRepo({ ...REPO, items: [item('Bad Id')] }));
  assert.throws(() => fromRepo({ ...REPO, items: [item('x', { kind: 'virus' })] }));
});

test('reads at most every six hours, keeps the last good copy, and shows it with its date when offline', async () => {
  const t0 = new Date('2026-10-29T10:00:00Z');
  calls = 0;
  let r = await readStoreRepo({ now: t0, fetch: github(REPO) });
  assert.equal(r.fresh, true); assert.equal(r.asOf, t0.toISOString()); assert.equal(r.index.items.length, 2); assert.equal(calls, 1);
  assert.match(saved(), /girru:genvr/, 'the checked copy is kept in the database');
  assert.doesNotMatch(saved(), /pricing/, 'never the raw answer');
  r = await readStoreRepo({ now: new Date(t0.getTime() + 3_600_000), fetch: github(REPO) });
  assert.equal(calls, 1, 'young copy: GitHub is not asked again');
  r = await readStoreRepo({ now: new Date(t0.getTime() + 7 * 3_600_000), fetch: down });
  assert.equal(calls, 2); assert.equal(r.fresh, false); assert.equal(r.asOf, t0.toISOString(), 'offline: the copy from 10:00'); assert.equal(r.index.items.length, 2);
  r = await readStoreRepo({ now: new Date(t0.getTime() + 8 * 3_600_000), fetch: github({ schema: 2, items: [], collections: [] }) });
  assert.equal(r.fresh, false, 'a broken index is never shown'); assert.equal(r.index.items.length, 2);
  assert.doesNotMatch(saved(), /schema":2/, 'nor saved');
  process.env.GIRRU_STORE_REPO = 'off';
  calls = 0; r = await readStoreRepo({ now: new Date(t0.getTime() + 20 * 3_600_000), fetch: github(REPO) });
  assert.equal(calls, 0); assert.equal(r.index, null);
  delete process.env.GIRRU_STORE_REPO;
});

test('the Store window: the repository words for Girru apps; an item without a package is listed but cannot be added', async () => {
  const repo = async () => ({ index: fromRepo(REPO), asOf: '2026-10-29T10:00:00.000Z', fresh: true });
  const store = await readStore('owner-1', localCatalogue({ home: dir, repo }));
  const genvr = store.items.find((x) => x.id === 'girru:genvr');
  assert.equal(genvr.description, 'GenVR as the repository says it'); assert.equal(genvr.state, 'elsewhere');
  const notes = store.items.find((x) => x.id === 'store:notes');
  assert.equal(notes.state, 'elsewhere', 'no package: nothing to add'); assert.equal(notes.present, false);
  assert.ok(store.collections.find((c) => c.id === 'new').items.includes('store:notes'));
  assert.equal(store.storeAsOf, '2026-10-29T10:00:00.000Z'); assert.ok(!store.limited.includes('store'));
  const r = await installFromStore('owner-1', 'store:notes', notes.hash);
  assert.equal(r.ok, false); assert.equal(r.code, 'not_found');
  const offline = await readStore('owner-1', localCatalogue({ home: dir, repo: async () => ({ index: null, asOf: null, fresh: false }) }));
  assert.ok(offline.limited.includes('store')); assert.ok(offline.items.some((x) => x.id === 'girru:genvr'), 'the built-in app cards remain visible even when the runtime is missing');
});

test('skills and specialties that come with Girru show as installed; others wait for a package', async () => {
  const kind = (id, k) => ({ ...item(id), kind: k, name: id });
  const raw = { schema: 1, featured: null, collections: [], items: [kind('data-analysis', 'skill'), kind('frontend-developer', 'specialty'), kind('not-in-girru', 'skill')] };
  const store = await readStore('owner-1', localCatalogue({ home: dir, repo: async () => ({ index: fromRepo(raw), asOf: null, fresh: true }) }));
  const by = (id) => store.items.find((x) => x.id === id);
  assert.equal(by('girru:data-analysis')?.state, 'included');
  assert.equal(by('girru:frontend-developer')?.state, 'included');
  assert.equal(by('store:not-in-girru')?.state, 'elsewhere');
});

test('a cached GenVR for another version than Girru pins is looked up again at once, at most every two minutes', async () => {
  const { PIN } = await import(join(backendDir, 'src/config/genvr-runtime-path.cjs'));
  const runtime = (version) => ({ version, protocolVersion: 1, archives: { 'darwin-arm64': { url: `https://github.com/Dpro-at/genvr-world-sdk/releases/download/v${version}/3d-world-sdk-${version}.tgz`, sha256: 'a'.repeat(64), size: 1000 } } });
  const repo = (version) => ({ ...REPO, items: [item('genvr', { category: 'worlds', runtime: runtime(version) })] });
  const t0 = new Date('2026-11-12T08:00:00Z');
  calls = 0; await readStoreRepo({ now: t0, fetch: github(repo('0.3.0-preview.1')), fresh: true });
  const later = (min) => new Date(t0.getTime() + min * 60_000);
  const r = await readStoreRepo({ now: later(10), fetch: github(repo(PIN.version)) });
  assert.equal(calls, 2, 'the old GenVR entry is read again although the copy is young');
  assert.equal(r.runtimes['girru:genvr'].version, PIN.version);
  const same = await readStoreRepo({ now: later(11), fetch: github(repo(PIN.version)) });
  assert.equal(calls, 2, 'a matching entry stays cached');assert.equal(same.runtimes['girru:genvr'].version, PIN.version);
  await readStoreRepo({ now: later(12), fetch: github(repo('0.3.0-preview.2')), fresh: true });
  await readStoreRepo({ now: later(13), fetch: github(repo('0.3.0-preview.2')) });
  assert.equal(calls, 4, 'a store that still lists another version is asked again after two minutes');
  await readStoreRepo({ now: later(13.5), fetch: github(repo('0.3.0-preview.2')) });
  assert.equal(calls, 4, 'but not more often');
});
