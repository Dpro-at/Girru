const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { beginBuild, completeBuild, failBuild, readCurrent, packageCurrent } = require('../scripts/build-artifacts.cjs');
const { startPreview, HEADERS, CSP, HOST, PORT } = require('../scripts/preview.cjs');
const evidence = path.resolve(__dirname, '../.build-evidence');
fs.mkdirSync(evidence, { recursive: true });
function fixture() {
  const root = fs.mkdtempSync(path.join(evidence, 'preview-test-'));
  build(root, 'one');
  return root;
}
function build(root, label) {
  const result = beginBuild(root);
  fs.mkdirSync(path.join(result.output, 'assets'));
  fs.writeFileSync(path.join(result.output, 'index.html'), `<!doctype html><title>Fictional ${label}</title>`);
  fs.writeFileSync(path.join(result.output, `assets/${label}.js`), `/* fictional ${label} */`);
  fs.writeFileSync(path.join(result.output, `assets/${label}.css`), 'body { color: black; }');
  fs.writeFileSync(path.join(result.output, 'THIRD_PARTY_NOTICES.txt'), `fictional notice ${label}`);
  completeBuild(root, result.buildId);
  return result;
}
async function serverFor(t, root) {
  const server = await startPreview({ packageRoot: root, port: 0 });
  assert.equal(server.address().address, HOST);
  t.after(async () => { server.close(); await once(server, 'close'); });
  return server;
}
function request(server, target, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: server.address().port, path: target, method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
}
test('preview configuration reserves strict loopback 42522; fictional GET/HEAD carry production CSP and no cache', async t => {
  assert.equal(PORT, 42522); assert.equal(HOST, '127.0.0.1');
  assert.equal(CSP, "default-src 'self'; script-src 'self'; style-src 'self'; style-src-elem 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const server = await serverFor(t, fixture());
  for (const [target,type] of [['/','text/html'], ['/assets/one.js','text/javascript'], ['/assets/one.css','text/css'], ['/THIRD_PARTY_NOTICES.txt','text/plain']]) {
    const response = await request(server, target);
    assert.equal(response.status, 200); assert.match(response.headers['content-type'], new RegExp(type));
    for (const [name,value] of Object.entries(HEADERS)) assert.equal(response.headers[name.toLowerCase()], value);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers.etag, undefined);
    const head = await request(server, target, { method: 'HEAD' });
    assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(head.headers['content-length'], response.headers['content-length']);
  }
});
test('only declared SPA routes accept HTML fallback; no asset/API/directory or arbitrary fallback', async t => {
  const server = await serverFor(t, fixture());
  for (const route of ['/chat','/agents','/memory','/tasks','/settings','/channels']) {
    assert.equal((await request(server, route, { headers: { Accept: 'text/html' } })).status, 200);
    assert.equal((await request(server, route)).status, 404);
  }
  for (const target of ['/unknown','/agents/unknown','/api','/api/auth/me','/assets/','/assets/missing.js','/index.html/','/favicon.ico']) {
    const response = await request(server, target, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404, target); assert.equal(response.body, 'Not found');
  }
});
test('repo, modules, cache, evidence, dotfiles, manifests and non-current builds cannot be served', async t => {
  const root = fixture(); const old = readCurrent(root);
  for (const folder of ['node_modules','.npm-cache','.build-evidence']) {
    fs.mkdirSync(path.join(root, folder)); fs.writeFileSync(path.join(root, folder, 'fictional.txt'), 'fictional-private');
  }
  fs.writeFileSync(path.join(root, '.env'), 'FICTIONAL_ONLY=not-a-secret');
  fs.writeFileSync(path.join(old.output, 'extra.txt'), 'fictional-unlisted');
  build(root, 'two');
  const server = await serverFor(t, root);
  for (const target of ['/src/App.tsx','/package.json','/node_modules/fictional.txt','/.npm-cache/fictional.txt','/.build-evidence/fictional.txt','/.env','/dist/current.json','/current.json','/extra.txt','/.vite/license.md',`/dist/${old.manifest.buildId}/index.html`,'/assets/one.js']) {
    const response = await request(server, target, { headers: { Accept: 'text/html' } });
    assert.equal(response.status, 404, target); assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(fs.readFileSync(path.join(old.output, 'assets/one.js'), 'utf8'), '/* fictional one */');
});
test('raw and encoded traversal, malformed encoding, backslashes and absolute targets are rejected', async t => {
  const server = await serverFor(t, fixture());
  for (const target of ['/../index.html','/assets/../../.env','/%2e%2e/.env','/assets/%2E%2E/index.html','/%252e%252e/.env','/assets%2fone.js','/assets%5cone.js','/assets\\one.js','//index.html','/%00','/%zz','/%23hidden','http://localhost/index.html']) {
    assert.equal((await request(server, target)).status, 400, target);
  }
});
test('non-GET/HEAD, invalid Host and cross-origin requests fail without CORS or sensitive errors', async t => {
  const server = await serverFor(t, fixture());
  for (const method of ['POST','PUT','DELETE','OPTIONS','PATCH']) {
    const response = await request(server, '/', { method }); assert.equal(response.status, 405); assert.equal(response.headers.allow, 'GET, HEAD');
  }
  assert.equal((await request(server, '/', { headers: { Host: 'example.invalid' } })).status, 421);
  assert.equal((await request(server, '/', { headers: { Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await request(server, '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});
test('port collision fails strictly and leaves the existing owned test server running', async t => {
  const root = fixture(); const server = await serverFor(t, root);
  await assert.rejects(startPreview({ packageRoot: root, port: server.address().port }), { code: 'EADDRINUSE' });
  assert.equal((await request(server, '/')).status, 200);
});
test('versioned build publication switches current assets atomically and packages only the current manifest', async t => {
  const root = fixture(); const first = readCurrent(root); const server = await serverFor(t, root);
  const second = build(root, 'two');
  assert.notEqual(second.output, first.output);
  assert.equal((await request(server, '/assets/one.js')).status, 404);
  assert.equal((await request(server, '/assets/two.js')).status, 200);
  const packaged = packageCurrent(root);
  assert.deepEqual(fs.readdirSync(packaged).sort(), ['BUILD_MANIFEST.json','THIRD_PARTY_NOTICES.txt','assets','index.html']);
  assert.deepEqual(fs.readdirSync(path.join(packaged, 'assets')).sort(), ['two.css','two.js']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(packaged, 'BUILD_MANIFEST.json'))).buildId, second.buildId);
  assert.ok(fs.existsSync(path.join(first.output, 'assets/one.js')));
  const pending = beginBuild(root);
  assert.equal((await request(server, '/')).status, 503); assert.throws(() => packageCurrent(root));
  failBuild(root, pending.buildId);
  assert.equal((await request(server, '/')).status, 503); assert.ok(fs.existsSync(second.output));
});
test('incomplete and superseded builds never publish; old bytes remain untouched', () => {
  const root = fixture(); const first = readCurrent(root);
  const pending = beginBuild(root); assert.throws(() => completeBuild(root, pending.buildId));
  const newer = build(root, 'newer');
  assert.throws(() => completeBuild(root, pending.buildId), /superseded/);
  failBuild(root, pending.buildId);
  assert.equal(readCurrent(root).manifest.buildId, newer.buildId);
  assert.equal(fs.readFileSync(path.join(first.output, 'assets/one.js'), 'utf8'), '/* fictional one */');
});
test('tampered current bytes, malicious manifest paths and symlinked assets fail closed', async t => {
  const root = fixture(); const current = readCurrent(root); const server = await serverFor(t, root);
  fs.writeFileSync(path.join(current.output, 'assets/one.js'), 'tampered fictional bytes');
  assert.equal((await request(server, '/assets/one.js')).status, 503); assert.throws(() => packageCurrent(root));
  const safe = build(root, 'safe');
  fs.writeFileSync(path.join(root, 'fictional-outside.js'), 'fictional outside output');
  fs.symlinkSync(path.join(root, 'fictional-outside.js'), path.join(safe.output, 'assets/escape.js'));
  assert.throws(() => completeBuild(root, safe.buildId));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/current.json')));
  manifest.files.push({ path: 'assets/escape.js', size: 0, sha256: '' });
  fs.writeFileSync(path.join(root, 'dist/current.json'), JSON.stringify(manifest));
  assert.equal((await request(server, '/assets/escape.js')).status, 503);
  for (const name of ['../.env','.env','node_modules/index.js','.build-evidence/report.txt']) {
    manifest.files = [{ path: name }]; fs.writeFileSync(path.join(root, 'dist/current.json'), JSON.stringify(manifest));
    assert.throws(() => readCurrent(root));
  }
});
test('symlinked output directories and pointers are refused without following them', () => {
  const root = fixture(); const current = readCurrent(root);
  const fakeRoot = fs.mkdtempSync(path.join(evidence, 'preview-link-test-'));
  fs.symlinkSync(path.join(root, 'dist'), path.join(fakeRoot, 'dist'));
  assert.throws(() => readCurrent(fakeRoot), /Unsafe artifact directory/);
  const otherRoot = fs.mkdtempSync(path.join(evidence, 'preview-pointer-test-'));
  fs.mkdirSync(path.join(otherRoot, 'dist'));
  fs.symlinkSync(path.join(root, 'dist/current.json'), path.join(otherRoot, 'dist/current.json'));
  assert.throws(() => readCurrent(otherRoot));
  const linked = `build-00000000-0000-0000-0000-000000000000`;
  fs.symlinkSync(current.output, path.join(root, 'dist', linked));
  fs.writeFileSync(path.join(root, 'dist/current.json'), JSON.stringify({ ...current.manifest, buildId: linked }));
  assert.throws(() => readCurrent(root), /Unsafe artifact directory/);
});

test('symlinked asset directory cannot escape even with valid current bytes and manifest', () => {
  const root = fixture();
  const current = readCurrent(root);
  const pending = beginBuild(root);
  for (const name of ['index.html', 'THIRD_PARTY_NOTICES.txt']) fs.copyFileSync(path.join(current.output, name), path.join(pending.output, name));
  fs.symlinkSync(path.join(current.output, 'assets'), path.join(pending.output, 'assets'));
  assert.throws(() => completeBuild(root, pending.buildId), /Unsafe artifact directory/);
  fs.writeFileSync(path.join(root, 'dist/current.json'), JSON.stringify({ ...current.manifest, buildId: pending.buildId }));
  assert.throws(() => readCurrent(root), /Unsafe artifact directory/);
});

test('candidate builds never change current serving, even while pending or failed', async t => {
  const root = fixture(); const before = fs.readFileSync(path.join(root, 'dist/current.json'));
  const server = await serverFor(t, root);
  const candidate = beginBuild(root, 'candidate');
  assert.deepEqual(fs.readFileSync(path.join(root, 'dist/current.json')), before);
  assert.match((await request(server, '/')).body, /Fictional one/);
  fs.mkdirSync(path.join(candidate.output, 'assets'));
  for (const [name, content] of [['index.html', '<title>Fictional candidate</title>'], ['assets/candidate.js', '/* candidate */'], ['assets/candidate.css', 'body {}'], ['THIRD_PARTY_NOTICES.txt', 'fictional']]) fs.writeFileSync(path.join(candidate.output, name), content);
  completeBuild(root, candidate.buildId, 'candidate');
  assert.equal(readCurrent(root, 'candidate').manifest.buildId, candidate.buildId);
  assert.deepEqual(fs.readFileSync(path.join(root, 'dist/current.json')), before);
  assert.match((await request(server, '/')).body, /Fictional one/);
  assert.equal((await request(server, '/assets/candidate.js')).status, 404);
  const next = beginBuild(root, 'candidate'); failBuild(root, next.buildId, 'candidate');
  assert.throws(() => readCurrent(root, 'candidate'));
  assert.deepEqual(fs.readFileSync(path.join(root, 'dist/current.json')), before);
  assert.throws(() => beginBuild(root, '../escape'));
});
