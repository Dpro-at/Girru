import { pathToFileURL } from 'node:url';
const loadFile = file => import(pathToFileURL(file).href);
// A test profile (HOME set to a fresh folder) must not search the rest of the computer:
// the first-run scan once read the account's real home through the "/" root and imported
// its memory files. Run: node --import tsx --test test/separate-home-scan.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const backendDir = process.cwd();
const originalHome = process.env.HOME, originalProfile = process.env.USERPROFILE;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ap-separate-home-')));
const warmup = join(dir, 'transformer-warmup.ts');
writeFileSync(warmup, 'export const ready: boolean = true;\n');
await loadFile(warmup);
const home = join(dir, 'test-home'), account = join(dir, 'account-home');
mkdirSync(join(dir, '.data'), { recursive: true });
process.chdir(dir);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DATABASE_PATH = join(dir, '.data', 'agent-player.db');
process.env.JWT_SECRET = randomBytes(64).toString('hex');
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
const write = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
write(join(home, 'work', 'alpha', 'README.md'), 'Alpha project in the test profile.');
write(join(home, '.claude', 'CLAUDE.md'), 'Test profile instructions.');
// Stands in for the real home elsewhere on the disk.
write(join(account, 'secret-project', 'README.md'), 'Real home project must stay unread.');
write(join(account, '.claude', 'CLAUDE.md'), 'Real home memory must stay unread.');

const R = await loadFile(join(backendDir, 'src/memory/import/computer-roots.ts'));
const P = await loadFile(join(backendDir, 'src/memory/import/project-documents.ts'));

test.after(() => { process.chdir(backendDir); process.env.HOME = originalHome; if (originalProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalProfile; rmSync(dir, { recursive: true, force: true }); });

test('a HOME that is not the account home is searched alone, never the whole disk or mounted drives', async () => {
  assert.equal(await R.separateHome(home, account), true);
  assert.deepEqual((await R.computerRoots({ home, accountHome: account })).roots, [home]);
  assert.deepEqual((await R.computerRoots({ home, accountHome: account, platform: 'win32' })).roots, [home]);
});

test('the account home itself still searches the whole computer', async () => {
  assert.equal(await R.separateHome(account, account), false);
  const roots = (await R.computerRoots({ home: account, accountHome: account, platform: 'linux' })).roots;
  assert.ok(roots.includes('/'), 'the system disk is searched from the account home');
  // Unknown account (no user database entry): keep the old behaviour.
  assert.equal(await R.separateHome(home, null), false);
});

test('chosen roots are kept as given', async () => {
  assert.deepEqual((await R.computerRoots({ home, accountHome: account, roots: [account] })).roots, [account]);
});

test('the automatic first-run scan of a test profile finds only files inside that HOME', async () => {
  assert.notEqual(realpathSync(userInfo().homedir), home, 'this test runs with a separate HOME');
  let page = await P.scanProjectDocuments('separate-home-owner', { auto: true }, { purpose: 'watch', home });
  const docs = [...page.documents], homes = new Set(page.memoryHomes);
  while (page.nextCursor) { page = await P.scanProjectDocuments('separate-home-owner', { auto: true, cursor: page.nextCursor }, { purpose: 'watch', home }); docs.push(...page.documents); for (const h of page.memoryHomes) homes.add(h); }
  const files = docs.map(doc => join(doc.root, doc.relative));
  assert.ok(files.some(file => file.endsWith(join('alpha', 'README.md'))), 'the test profile project is found');
  assert.ok(files.every(file => file.startsWith(home)), `nothing outside the test HOME: ${files.filter(file => !file.startsWith(home)).join(', ')}`);
  assert.deepEqual([...homes], [home], 'only the test HOME is handed to the memory reader');
});
