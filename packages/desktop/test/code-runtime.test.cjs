'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { resolveCodeRuntime } = require('../src/code-runtime.cjs');
const { installNabuEditor, CHANNELS } = require('../src/nabu-editor.cjs');

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
/** A protocol-1 runtime whose host only answers start/stop (no real editor). */
function fakeRuntime(root) {
  write(path.join(root, 'nabu', 'runtime.json'), JSON.stringify({ protocolVersion: 1, entry: 'dpro/editor-runtime.mjs' }));
  write(path.join(root, 'nabu', 'dpro', 'editor-runtime.mjs'), `export const protocolVersion = 1;
export function createEditorHost() { return { async start() { return { origin: 'http://127.0.0.1:41590', url: 'http://127.0.0.1:41590/?tkn=t' }; }, async stop() {} }; }`);
  return root;
}
const current = (runtimes, value) => write(path.join(runtimes, 'code', 'current.json'), JSON.stringify(value));

test('Code comes from inside the app first, else from the Store folder named in current.json', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-code-runtime-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const runtimes = path.join(tmp, 'app-runtimes');
  assert.equal(resolveCodeRuntime({ bundled: path.join(tmp, 'none'), runtimesDir: runtimes }), null);
  fakeRuntime(path.join(runtimes, 'code', '1.2.3-0a1b2c3d'));
  assert.equal(resolveCodeRuntime({ bundled: null, runtimesDir: runtimes }), null, 'no current.json yet');
  current(runtimes, { version: '1.2.3', dir: '1.2.3-0a1b2c3d' });
  assert.deepEqual(resolveCodeRuntime({ bundled: null, runtimesDir: runtimes }), { root: path.join(runtimes, 'code', '1.2.3-0a1b2c3d'), source: 'store', version: '1.2.3' });
  const bundled = fakeRuntime(path.join(tmp, 'Resources', 'nabu-runtime'));
  assert.equal(resolveCodeRuntime({ bundled, runtimesDir: runtimes }).source, 'bundled');
  assert.equal(resolveCodeRuntime({ bundled: null, runtimesDir: 'relative/dir' }), null);
});

test('current.json can never point outside the code folder or through a link', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-code-runtime-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const runtimes = path.join(tmp, 'app-runtimes');
  const outside = fakeRuntime(path.join(tmp, 'elsewhere'));
  fakeRuntime(path.join(runtimes, 'code', '1.2.3-0a1b2c3d'));
  for (const dir of ['../../elsewhere', outside, '1.2.3-0a1b2c3d/..', 'latest', '9.9.9-0a1b2c3d']) {
    current(runtimes, { version: '1.2.3', dir });
    assert.equal(resolveCodeRuntime({ bundled: null, runtimesDir: runtimes }), null, dir);
  }
  fs.symlinkSync(outside, path.join(runtimes, 'code', '1.2.4-0a1b2c3d'));
  current(runtimes, { version: '1.2.4', dir: '1.2.4-0a1b2c3d' });
  assert.equal(resolveCodeRuntime({ bundled: null, runtimesDir: runtimes }), null, 'a linked version folder');
  const inner = fakeRuntime(path.join(runtimes, 'code', '1.2.5-0a1b2c3d'));
  fs.rmSync(path.join(inner, 'nabu'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'nabu'), path.join(inner, 'nabu'));
  current(runtimes, { version: '1.2.5', dir: '1.2.5-0a1b2c3d' });
  assert.equal(resolveCodeRuntime({ bundled: null, runtimesDir: runtimes }), null, 'a linked nabu folder');
});

test('the editor bridge says Code is missing, then opens it once the Store has installed it', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'girru-code-bridge-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const runtimes = path.join(tmp, 'app-runtimes');
  const ipc = new EventEmitter(); ipc.handlers = new Map();
  ipc.handle = (key, fn) => ipc.handlers.set(key, fn); ipc.removeHandler = key => ipc.handlers.delete(key);
  class Contents extends EventEmitter { mainFrame = { url: 'http://127.0.0.1:41591/' }; session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} }; url = ''; send() {} getZoomFactor() { return 1; } isDestroyed() { return false; } setWindowOpenHandler() {} getURL() { return this.url; } async loadURL(u) { this.url = u; } focus() {} close() { this.emit('destroyed'); } }
  const win = new EventEmitter(); win.webContents = new Contents(); win.isDestroyed = () => false; win.getContentSize = () => [1280, 720];
  win.contentView = { children: [], addChildView(v) { this.children.push(v); }, removeChildView(v) { this.children = this.children.filter(x => x !== v); } };
  class View { webContents = new Contents(); setVisible(v) { this.visible = v; } setBounds() {} }
  const editor = installNabuEditor({ win, electron: { ipcMain: ipc, WebContentsView: View, dialog: {} }, getOrigin: () => 'http://127.0.0.1:41591', resolveRuntime: () => resolveCodeRuntime({ bundled: null, runtimesDir: runtimes }), node: process.execPath, dataDir: path.join(tmp, 'profile') });
  t.after(() => editor.stop());
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  assert.deepEqual(await ipc.handlers.get(CHANNELS.status)(event), { available: false, runtime: 'missing', mode: 'chat', busy: false, error: null });
  assert.equal(await ipc.handlers.get(CHANNELS.select)(event, { mode: 'code', top: 48, bottom: 32 }), null, 'nothing to open yet');
  fakeRuntime(path.join(runtimes, 'code', '2.0.0-0a1b2c3d'));
  current(runtimes, { version: '2.0.0', dir: '2.0.0-0a1b2c3d' });
  assert.equal((await ipc.handlers.get(CHANNELS.status)(event)).runtime, 'store');
  const opened = await ipc.handlers.get(CHANNELS.select)(event, { mode: 'code', top: 48, bottom: 32 });
  assert.equal(opened.mode, 'code'); assert.equal(opened.available, true);
});
