// MACAPP-01 / DOGFOOD stage 3: the Code editor packed into the app. Only run-time parts of a
// Nabu checkout are copied: production packages, kept extensions, one shared telemetry copy.
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { stage, productionPackages } = require('../scripts/stage-nabu.cjs');

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const pkg = (dir, name, extra = {}) => write(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }));

function checkout(root) {
  write(path.join(root, 'nabu', 'runtime.json'), JSON.stringify({ protocolVersion: 1, entry: 'dpro/editor-runtime.mjs' }));
  write(path.join(root, 'nabu', 'dpro', 'editor-runtime.mjs'), 'export const protocolVersion = 1;\n');
  const editor = path.join(root, 'editor');
  pkg(editor, 'editor', { dependencies: { 'run-dep': '1.0.0' }, devDependencies: { 'dev-dep': '1.0.0' } });
  for (const name of ['run-dep', 'dev-dep']) pkg(path.join(editor, 'node_modules', name), name);
  write(path.join(editor, 'out', 'server-main.js'), '');
  write(path.join(editor, 'product.json'), '{}');
  write(path.join(editor, 'LICENSE.txt'), 'MIT');
  write(path.join(editor, 'ThirdPartyNotices.txt'), 'Notices');
  write(path.join(root, 'nabu', 'account', 'private.ts'), 'not runtime');
  pkg(path.join(editor, 'node_modules', 'server-dep'), 'server-dep', { version:'electron-build' });
  write(path.join(editor, 'resources', 'r.txt'), '');
  pkg(path.join(editor, 'remote'), 'remote', { dependencies: { 'server-dep': '1.0.0' } });
  pkg(path.join(editor, 'remote', 'node_modules', 'server-dep'), 'server-dep');
  for (const ext of ['markdown', 'git', 'copilot']) {
    const dir = path.join(editor, 'extensions', ext);
    pkg(dir, ext, { dependencies: { '@vscode/extension-telemetry': '1.0.0', [`${ext}-server`]: '1.0.0' }, devDependencies: { 'ext-dev': '1.0.0' } });
    write(path.join(dir, 'out', 'extension.js'), '');
    pkg(path.join(dir, 'node_modules', '@vscode', 'extension-telemetry'), '@vscode/extension-telemetry');
    pkg(path.join(dir, 'node_modules', `${ext}-server`), `${ext}-server`);
    pkg(path.join(dir, 'node_modules', 'ext-dev'), 'ext-dev');
  }
}

test('copies only the run-time parts and the kept extensions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-nabu & literal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkout(path.join(root, 'nabu-code'));
  const out = path.join(root, 'runtime');
  const result = stage({ nabu: path.join(root, 'nabu-code'), out });
  const has = rel => fs.existsSync(path.join(out, ...rel.split('/')));
  assert.equal(result.extensions, 2);
  assert.equal(has('nabu/account/private.ts'),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out,'editor/node_modules/server-dep/package.json'))).version,'1.0.0');
  assert.ok(has('editor/LICENSE.txt'));assert.ok(has('editor/ThirdPartyNotices.txt'));
  for (const rel of ['nabu/runtime.json', 'nabu/dpro/editor-runtime.mjs', 'editor/out/server-main.js', 'editor/product.json', 'editor/node_modules/run-dep', 'editor/node_modules/server-dep', 'editor/remote/node_modules/server-dep', 'editor/extensions/git/out/extension.js']) assert.ok(has(rel), rel);
  assert.equal(has('editor/node_modules/dev-dep'), false, 'development packages stay out');
  assert.equal(has('editor/extensions/copilot'), false, 'dropped extensions stay out');
  assert.equal(has('editor/extensions/git/node_modules/ext-dev'), false);
  // Telemetry kept once where Node finds it; packages an extension opens by path stay in its own folder.
  assert.ok(has('editor/extensions/node_modules/@vscode/extension-telemetry'));
  assert.equal(has('editor/extensions/git/node_modules/@vscode/extension-telemetry'), false);
  assert.ok(has('editor/extensions/markdown/node_modules/markdown-server'));
});

test('refuses a checkout that is not built', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-nabu & literal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  checkout(path.join(root, 'nabu-code'));
  fs.rmSync(path.join(root, 'nabu-code', 'editor', 'out'), { recursive: true });
  assert.throws(() => stage({ nabu: path.join(root, 'nabu-code'), out: path.join(root, 'runtime') }), /not built: out/);
});


test('Windows runs the npm command script and refuses a failed launch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-npm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const real = fs.realpathSync(root);
  const run = (command, args, options) => {
    assert.equal(command, 'cmd.exe');
    assert.deepEqual(args, ['/d', '/s', '/c', 'npm ls --omit=dev --all --parseable']);
    assert.equal(options.cwd, root);
    return `${real}\n${path.join(real, 'node_modules', 'runtime-package')}\n`;
  };
  assert.deepEqual(productionPackages(root, run, 'win32'), ['node_modules/runtime-package']);
  assert.throws(() => productionPackages(root, () => { throw Object.assign(new Error('spawn failed'), { code: 'ENOENT' }); }, 'win32'), /Cannot list/);
  assert.deepEqual(productionPackages(root, () => { throw Object.assign(new Error('incomplete tree'), { status: 1, stdout: run('cmd.exe', ['/d', '/s', '/c', 'npm ls --omit=dev --all --parseable'], { cwd: root }) }); }, 'win32'), ['node_modules/runtime-package']);
});
