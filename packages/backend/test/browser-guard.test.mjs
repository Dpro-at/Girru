// BROWSER-01: the headless browser may load only public http(s) (and
// data:/about:/blob:). Before, an agent or a prompt-injected page could make
// it load 127.0.0.1 services, the private network or cloud metadata.
// Uses the real Puppeteer controller with headless Chrome; no request leaves
// the machine (only data: pages and refused addresses are used).
// Also checks the page helpers the browser tools now call with the page.
// Run: node --import tsx --test test/browser-guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const backendDir = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'ap-browser-guard-'));
// Puppeteer finds its Chrome under the real HOME; keep that before HOME moves.
process.env.PUPPETEER_CACHE_DIR ??= join(homedir(), '.cache', 'puppeteer');
process.chdir(dir);
process.env.HOME = dir;
process.env.AGENT_PLAYER_DATA_DIR = join(dir, 'data');
process.env.DATABASE_PATH = join(dir, 'data', 'agent-player.db');

const quiet = { log: console.log, info: console.info, warn: console.warn };
console.log = () => {}; console.info = () => {}; console.warn = () => {};
const { checkBrowserUrl } = await import(join(backendDir, 'src/browser/url-guard.ts'));
const { BrowserController } = await import(join(backendDir, 'test/fixtures/legacy-apps/src/browser/controller.ts'));
const utils = await import(join(backendDir, 'src/tools/browser/page-utils.ts'));

let controller;
let sessionId;
let browserOk = true;
try {
  controller = new BrowserController();
  sessionId = (await controller.createSession({ headless: true })).id;
} catch (err) {
  browserOk = false;
}
const skip = browserOk ? false : 'headless Chrome could not start';

test.after(async () => {
  if (controller) await controller.cleanup();
  Object.assign(console, quiet);
  process.chdir(backendDir);
  rmSync(dir, { recursive: true, force: true });
});

test('URL verdicts: private, loopback, link-local and non-http schemes are refused', async () => {
  const refused = [
    'http://127.0.0.1:41521/api/agents', 'http://localhost:41521/', 'http://10.0.0.1/', 'http://192.168.1.1/',
    'http://172.16.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]:8080/', 'http://[::ffff:127.0.0.1]/',
    'http://0.0.0.0/', 'file:///etc/passwd', 'ftp://example.com/', 'chrome://settings', 'javascript:alert(1)',
    'https://user:pass@1.1.1.1/', 'not a url',
  ];
  for (const url of refused) assert.equal((await checkBrowserUrl(url)).ok, false, url);
  for (const url of ['https://1.1.1.1/', 'http://8.8.8.8/x', 'data:text/html,hi', 'about:blank']) {
    assert.equal((await checkBrowserUrl(url)).ok, true, url);
  }
  // A host that resolves to a private address is refused (lookup injected, no DNS).
  const lookup = async () => [{ address: '10.1.2.3', family: 4 }];
  assert.equal((await checkBrowserUrl('https://intranet.example/', lookup)).ok, false);
  const publicLookup = async () => [{ address: '93.184.215.14', family: 4 }];
  assert.equal((await checkBrowserUrl('https://public.example/', publicLookup)).ok, true);
});

test('navigate to a private address is refused with a clear error', { skip }, async () => {
  for (const url of ['http://127.0.0.1:9/', 'http://169.254.169.254/latest/meta-data/']) {
    const res = await controller.navigate(sessionId, url);
    assert.equal(res.success, false, url);
    assert.match(res.error, /^Blocked: /);
  }
});

test('sub-resources and iframes to private addresses are aborted', { skip }, async () => {
  // Pop-ups / new tabs are guarded through 'targetcreated' too, but headless
  // Chrome did not load a pop-up's URL in a probe, so that path has no test.
  const html = '<title>guard</title><img src="http://127.0.0.1:9/pixel.png">'
    + '<iframe src="http://10.0.0.1/admin"></iframe>'
    + '<link rel="stylesheet" href="http://169.254.169.254/latest/meta-data/x.css">';
  const res = await controller.navigate(sessionId, `data:text/html,${encodeURIComponent(html)}`);
  assert.equal(res.success, true, res.error);
  await new Promise((r) => setTimeout(r, 1000));
  const blocked = controller.getBlockedRequests(sessionId).map((b) => b.url);
  for (const target of ['http://127.0.0.1:9/pixel.png', 'http://10.0.0.1/admin', 'http://169.254.169.254/latest/meta-data/x.css']) {
    assert.ok(blocked.includes(target), `${target} not blocked; blocked: ${blocked.join(', ')}`);
  }
});

test('page helpers work on the page (text, links, images, table, metadata, JSON-LD)', { skip }, async () => {
  const html = '<title>Shop</title><meta name="description" content="A shop">'
    + '<h1> Hello   world </h1><p class="x">one</p><p class="x">two</p>'
    + '<a href="https://example.com/a">A</a><img alt="logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">'
    + '<table><tr><th>k</th><th>v</th></tr><tr><td>a</td><td>1</td></tr></table>'
    + '<script type="application/ld+json">{"@type":"Product","name":"Cup"}</script>'
    + '<script type="application/ld+json">not json</script>';
  assert.equal((await controller.navigate(sessionId, `data:text/html,${encodeURIComponent(html)}`)).success, true);
  const page = controller.getPage(sessionId);
  assert.ok(page);
  assert.equal(await utils.extractText(page, 'h1'), 'Hello world');
  assert.deepEqual(await utils.extractText(page, 'p.x', { multiple: true }), ['one', 'two']);
  assert.equal(await utils.extractText(page, '.missing'), '');
  assert.deepEqual(await utils.extractLinks(page), [{ text: 'A', href: 'https://example.com/a' }]);
  assert.equal((await utils.extractImages(page))[0].alt, 'logo');
  assert.deepEqual(await utils.extractTableData(page), [['k', 'v'], ['a', '1']]);
  assert.equal((await utils.getPageMetadata(page)).description, 'A shop');
  assert.deepEqual(await utils.extractStructuredData(page), [{ '@type': 'Product', name: 'Cup' }]);
});
