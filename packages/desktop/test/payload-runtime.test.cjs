'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { productionModules, moduleFilter, compileBackend, validateModules, compilerOptions, assertBridgeImports, assertExtensionRuntime, assertCompiledRuntime } = require('../scripts/payload-runtime.cjs');
const { backendArgs, checkPayload } = require('../src/payload.cjs');

test('payload excludes stale/dev/build packages and foreign native binaries, preserving nested runtime packages', () => {
  const allowed = productionModules({ lockfileVersion: 3, packages: {
    '': {}, 'node_modules/live': {}, 'node_modules/live/node_modules/nested': {},
    'node_modules/@scope/live': {}, 'node_modules/dev': { dev: true },
    'node_modules/typescript': {}, 'node_modules/tsx': {}, 'node_modules/esbuild': {},
    'node_modules/@esbuild/darwin-arm64': {}, 'node_modules/foreign': { os: ['win32'] },
  } }, 'darwin', 'arm64');
  const root = path.resolve('fixture-modules'), keep = moduleFilter(root, allowed, () => true, 'darwin', 'arm64');
  for (const name of ['live/index.js', '@scope', '@scope/live/package.json', 'live/node_modules/nested/index.js', 'live/prebuilds/darwin-arm64/pty.node', 'live/prebuilds/darwin-x64+arm64/pty.node']) assert.equal(keep(path.join(root, name)), true, name);
  for (const name of ['stale/index.js', 'dev/package.json', 'typescript/lib/typescript.js', 'tsx/dist/loader.mjs', '@esbuild/darwin-arm64/bin/esbuild', 'foreign/package.json', 'live/node_modules/dev/index.js', 'live/prebuilds/win32-x64/pty.node', '.bin/tsx']) assert.equal(keep(path.join(root, name)), false, name);
});

test('staging rejects locked dependency drift and unaccounted bridge dependencies', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-payload-validation-'));
  try {
    const lock = { packages: { 'node_modules/live': { version: '1.0.0' }, 'node_modules/optional': { version: '1.0.0', optional: true } } }, allowed = new Set(Object.keys(lock.packages));
    assert.throws(() => validateModules(lock, allowed, [root]), /Locked runtime dependency/);
    fs.mkdirSync(path.join(root, 'live')); fs.writeFileSync(path.join(root, 'live/package.json'), '{"version":"2.0.0"}');
    assert.throws(() => validateModules(lock, allowed, [root]), /different/);
    fs.writeFileSync(path.join(root, 'live/package.json'), '{"version":"1.0.0"}'); validateModules(lock, allowed, [root]);
    const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '../../backend'), path.resolve(__dirname, '../../core-ui')] }));
    fs.writeFileSync(path.join(root, 'bridge.cjs'), "require('node:fs')"); assertBridgeImports(root, ts);
    fs.writeFileSync(path.join(root, 'bridge.cjs'), "require('undeclared-fixture-package')"); assert.throws(() => assertBridgeImports(root, ts), /undeclared runtime module/);
    assert.equal(compilerOptions(path.resolve(__dirname, '../../backend'), ts).target, ts.ScriptTarget.ES2022);
    assert.equal(compilerOptions(path.resolve(__dirname, '../../backend'), ts).module, ts.ModuleKind.ESNext);
    assert.notEqual(compilerOptions(path.resolve(__dirname, '../../backend'), ts).importHelpers, true);
    fs.rmSync(path.join(root, 'bridge.cjs'));
    fs.mkdirSync(path.join(root, 'frontend')); fs.writeFileSync(path.join(root, 'frontend/build-input.tsx'), '<div />');
    assertExtensionRuntime(root, ts);
    fs.writeFileSync(path.join(root, 'runtime.ts'), 'export {}'); assert.throws(() => assertExtensionRuntime(root, ts), /must be compiled/);
    fs.rmSync(path.join(root, 'runtime.ts')); fs.writeFileSync(path.join(root, 'runtime.js'), "import('./worker.ts')"); assert.throws(() => assertExtensionRuntime(root, ts), /cannot load TypeScript/);
    assert.throws(() => assertCompiledRuntime(root, ts), /unreviewed TypeScript/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('compiled backend runs without a loader and retains adjacent runtime assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-compiled-payload-'));
  try {
    const from = path.join(root, 'source'), backend = path.join(root, 'backend');
    fs.mkdirSync(path.join(from, 'api'), { recursive: true });
    fs.writeFileSync(path.join(from, 'api', 'server.ts'), "import fs from 'node:fs'; enum State { Ready = 7 }; console.log(State.Ready, fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));");
    fs.writeFileSync(path.join(from, 'api', 'schema.sql'), 'fixture');
    fs.writeFileSync(path.join(from, '.env'), 'FIXTURE_ONLY=never-ship');
    fs.mkdirSync(path.join(from, '__tests__')); fs.writeFileSync(path.join(from, '__tests__', 'unused.ts'), 'throw Error();');
    const ts = require(require.resolve('typescript', { paths: [path.resolve(__dirname, '../../core-ui'), path.resolve(__dirname, '../../backend')] }));
    compileBackend(from, path.join(backend, 'src'), ts);
    fs.writeFileSync(path.join(backend, 'package.json'), '{"type":"module"}');
    assert.deepEqual(backendArgs(backend), [path.join(backend, 'src/api/server.js')]);
    assert.match(execFileSync(process.execPath, backendArgs(backend), { cwd: root, env: { PATH: process.env.PATH }, encoding: 'utf8' }), /7 fixture/);
    assert.equal(fs.existsSync(path.join(backend, 'src/__tests__')), false);
    assert.equal(fs.existsSync(path.join(backend, 'src/.env')), false);
    assert.equal(fs.existsSync(path.join(backend, 'src/api/server.ts')), false);
    const ui = path.join(root, 'ui'); fs.mkdirSync(path.join(ui, 'dist'), { recursive: true }); fs.writeFileSync(path.join(ui, 'dist/candidate.json'), '{}');
    assert.deepEqual(checkPayload({ node: process.execPath, backendDir: backend, coreUiDir: ui }), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
