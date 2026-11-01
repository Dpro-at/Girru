'use strict';
const fs = require('node:fs');
const path = require('node:path');
const FOOTER_NAMES = Object.freeze({ chat: 'Chat', agents: 'Agents', library: 'Library', board: 'Board', memory: 'Memory', approvals: 'Approvals', store: 'Store', terminal: 'Terminal', code: 'Code', genvr: 'GenVR', skills: 'Skills', personalities: 'Personalities', specialties: 'Specialties', settings: 'Settings' });
const { pathToFileURL } = require('node:url');

const CHANNELS = Object.freeze({ status: 'dpro:nabu-status', select: 'dpro:nabu-select', layout: 'dpro:nabu-layout', state: 'dpro:nabu-state', open: 'dpro:nabu-open' });

function compatibleRuntime(root) {
  let fd;
  try {
    if (!root || !path.isAbsolute(root)) return false;
    fd = fs.openSync(path.join(root, 'nabu', 'runtime.json'), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > 8192) return false;
    const bytes = Buffer.alloc(8193);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 8192) return false;
    const value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    return value.protocolVersion === 1 && value.entry === 'dpro/editor-runtime.mjs' && fs.statSync(path.join(root, 'nabu', value.entry)).isFile();
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function loopbackOrigin(value) {
  try { const u = new URL(value); return u.protocol === 'http:' && u.hostname === '127.0.0.1' && !!u.port && u.origin === value; } catch { return false; }
}

/** Optional desktop adapter. The editor implementation stays in the shared Nabu runtime. */
function installNabuEditor({ win, electron, getOrigin, runtimeRoot, node, dataDir, createHost, onLog = () => {} }) {
  const { ipcMain, WebContentsView, dialog } = electron;
  const installed = createHost ? true : compatibleRuntime(runtimeRoot);
  let pendingTarget = null, targetSequence = 0, pendingReview = null;
  let mode = 'chat', desired = 'chat', busy = false, error = null, top = 48, bottom = 32, right = 0;
  let view = null, host = null, starting = null, address = null, editorOrigin = null;
  let activated = false, integratedFooter = false;
  let generation = 0, disposed = false, closePromise = null, stopPromise = null, approvedClose = false;
  const cleanup = [];
  const listen = (target, name, callback) => { target.on(name, callback); cleanup.push(() => target.removeListener(name, callback)); };
  const available = () => installed && loopbackOrigin(getOrigin());
  const state = () => ({ available: available(), mode, busy, error });
  const notify = () => { if (!disposed && !win.webContents.isDestroyed()) win.webContents.send(CHANNELS.state, state()); };
  const allowed = event => !disposed && available() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && (() => { try { return new URL(event.senderFrame.url).origin === getOrigin(); } catch { return false; } })();
  const validBottom = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 96;
  const validRight = value => value === undefined || (Number.isFinite(value) && value >= 0 && value <= 1600);
  const validTop = value => typeof value === 'number' && Number.isFinite(value) && value >= 32 && value <= 160;
  const layout = () => {
    if (!view || disposed || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    const zoom = win.webContents.getZoomFactor();
    const y = Math.min(Math.round(top * zoom), Math.max(0, height - 1));
    const footer = mode === 'code' && integratedFooter ? 0 : Math.round(bottom * zoom);
    view.setBounds({ x: 0, y, width: Math.max(320, width - Math.round(right * zoom)), height: Math.max(1, height - y - footer) });
  };
  const hide = () => { pendingReview = null; view?.webContents.send('girru:code-review-changed'); pendingTarget = null; desired = mode = 'chat'; busy = false; generation++; view?.setVisible(false); notify(); };
  const runtimeExited = () => { address = null; host = null; starting = null; error = 'The editor stopped. Select Code to reconnect.'; hide(); };
  async function ready() {
    if (address) return address;
    if (starting) return starting;
    starting = (async () => {
      const factory = createHost || (await import(pathToFileURL(path.join(runtimeRoot, 'nabu/dpro/editor-runtime.mjs')).href));
      if (disposed) throw Error('Stopped');
      if (!createHost && factory.protocolVersion !== 1) throw Error('Unsupported editor runtime');
      host = (createHost || factory.createEditorHost)({ node, dataDir, onLog, onExit: runtimeExited });
      const result = await host.start();
      const u = new URL(result.url);
      if (!loopbackOrigin(result.origin) || u.origin !== result.origin || !u.searchParams.get('tkn')) throw Error('Invalid editor address');
      address = result;
      return result;
    })();
    try { return await starting; }
    catch (failure) { starting = null; const failedHost = host; host = null; await failedHost?.stop().catch(() => {}); throw failure; }
  }
  const shortcut = (event, input) => {
    const key = input.code === 'Digit1' ? '1' : input.code === 'Digit2' ? '2' : input.key;
    if (input.type !== 'keyDown' || !input.alt || input.shift || !(input.meta || input.control) || !['1', '2'].includes(key) || !available() || !activated) return;
    event.preventDefault(); void select(key === '1' ? 'code' : 'chat');
  };
  async function select(next) {
    if (!available() || disposed) return state();
    const epoch = ++generation;
    desired = next; error = null;
    if (next === 'chat') { pendingReview = null; view?.webContents.send('girru:code-review-changed'); mode = 'chat'; busy = false; view?.setVisible(false); win.webContents.focus(); notify(); return state(); }
    busy = true; notify();
    try {
      const target = await ready();
      if (disposed || epoch !== generation || desired !== 'code') return state();
      if (!view?.webContents || view.webContents.isDestroyed()) {
        view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, preload: path.join(__dirname, 'nabu-preload.cjs'), partition: 'persist:dpro-nabu-code' } });
        view.setVisible(false);
        win.contentView.addChildView(view);
        view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        view.webContents.session.setPermissionCheckHandler(() => false);
        view.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
        const guard = (event, url) => { try { if (new URL(url).origin === editorOrigin) return; } catch {} event.preventDefault(); };
        listen(view.webContents, 'will-navigate', guard); listen(view.webContents, 'will-redirect', guard);
        listen(view.webContents, 'will-attach-webview', event => event.preventDefault());
        listen(view.webContents, 'before-input-event', shortcut);
        listen(view.webContents, 'render-process-gone', () => { editorOrigin = null; error = 'The editor stopped. Select Code to reconnect.'; hide(); });
      }
      if (editorOrigin !== target.origin || !view.webContents.getURL()) {
        editorOrigin = target.origin;
        await view.webContents.loadURL(target.url);
      }
      if (disposed || epoch !== generation || desired !== 'code') return state();
      mode = 'code'; busy = false; layout(); view.setVisible(true); view.webContents.focus(); notify();
    } catch (failure) {
      onLog(`Editor open failed: ${String(failure?.code || failure?.name || 'error').slice(0,80)}`);
      if (!disposed && epoch === generation) { editorOrigin = null; error = 'The editor could not open. Select Code to try again.'; hide(); }
    }
    return state();
  }
  function requestClose() {
    if (closePromise) return closePromise;
    if (!view?.webContents || view.webContents.isDestroyed()) return Promise.resolve(true);
    const contents = view.webContents;
    const pending = new Promise(resolve => {
      const finish = value => { onLog(value?'Editor close approved.':'Editor close cancelled.'); contents.removeListener('destroyed', closed); contents.removeListener('will-prevent-unload', prevented); resolve(value); };
      const closed = () => finish(true);
      const prevented = event => {
        const discard = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Keep Working', 'Discard Changes'], defaultId: 0, cancelId: 0, noLink: true, message: 'The editor has unsaved work.', detail: 'Keep working to save your files before closing.' }) === 1;
        if (discard) event.preventDefault(); else finish(false);
      };
      contents.once('destroyed', closed); contents.once('will-prevent-unload', prevented);
      contents.close({ waitForBeforeUnload: true });
    });
    closePromise = pending;
    void pending.finally(() => { if (closePromise === pending) closePromise = null; });
    return pending;
  }
  const editorAllowed = event => !disposed && desired === 'code' && view && !view.webContents.isDestroyed() && event.sender === view.webContents && event.senderFrame === view.webContents.mainFrame && (() => { try { return new URL(event.senderFrame.url).origin === editorOrigin; } catch { return false; } })();
  let picking = false;

  let footerIds = new Set();
  ipcMain.handle('girru:code-directory', async event => {
    if (!editorAllowed(event) || picking) return null;
    picking = true;
    try {
      const result = await dialog.showOpenDialog(win, { title: 'Open Folder', properties: ['openDirectory'] });
      if (!editorAllowed(event) || result.canceled || result.filePaths.length !== 1) return null;
      const selected = result.filePaths[0];
      return typeof selected === 'string' && path.isAbsolute(selected) ? selected : null;
    } finally { picking = false; }
  });
  ipcMain.handle('girru:code-footer', async event => {
    if (!editorAllowed(event)) return [];
    const labels = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.shell-footer button[aria-label]')).map(b=>b.getAttribute('aria-label'))`);
    if (!editorAllowed(event) || !Array.isArray(labels)) return [];
    const items = Object.entries(FOOTER_NAMES).filter(([, label]) => labels.some(x => x === label || (typeof x === 'string' && x.startsWith(label + ',')))).map(([id, label]) => ({ id, label }));
    footerIds = new Set(items.map(item => item.id));
    integratedFooter = items.length > 0; layout();
    return items;
  });
  ipcMain.handle('girru:code-navigate', (event, id) => {
    if (!editorAllowed(event) || typeof id !== 'string' || !footerIds.has(id)) return false;
    if (id === 'code') return true;
    win.webContents.send('dpro:code-footer', id); hide(); win.webContents.focus(); return true;
  });
  cleanup.push(() => { for (const name of ['girru:code-directory', 'girru:code-footer', 'girru:code-navigate']) ipcMain.removeHandler(name); });
  ipcMain.handle('girru:code-target', event => editorAllowed(event) && mode === 'code' && !busy ? pendingTarget : null);
  ipcMain.handle('girru:code-target-done', (event, id) => {
    if (!editorAllowed(event) || !pendingTarget || id !== pendingTarget.id) return false;
    pendingTarget = null; return true;
  });
  const signalReview = () => { if (view && !view.webContents.isDestroyed()) view.webContents.send('girru:code-review-changed'); };
  ipcMain.handle('dpro:nabu-review', (event, value) => {
    if (!allowed(event) || mode !== 'code' || busy || !view || view.webContents.isDestroyed() || !value || Object.keys(value).sort().join(',') !== 'after,before,id,path' || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.path !== 'string' || !value.path || value.path.length > 1024 || value.path.includes('\0') || path.isAbsolute(value.path) || /^[a-z]:/i.test(value.path) || value.path.split(/[\\/]/).some(x => x === '..' || /^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|^id_(?:rsa|ed25519|ecdsa)/i.test(x)) || [value.before,value.after].some(x => typeof x !== 'string' || Buffer.byteLength(x) > 24000 || x.includes('\0') || x.split('\n').length > 1000)) return false;
    if (pendingReview && pendingReview.id !== value.id) return false;
    pendingReview = { id:value.id, path:value.path, before:value.before, after:value.after }; signalReview(); return true;
  });
  ipcMain.handle('dpro:nabu-review-clear', (event, id) => {
    if (!allowed(event) || !pendingReview || pendingReview.id !== id) return false;
    pendingReview = null; signalReview(); return true;
  });
  ipcMain.handle('girru:code-review', event => editorAllowed(event) && mode === 'code' && !busy ? pendingReview : null);
  ipcMain.handle('girru:code-review-decide', (event, id, decision) => {
    if (!editorAllowed(event) || mode !== 'code' || busy || !pendingReview || pendingReview.id !== id || !['approve','deny'].includes(decision)) return false;
    pendingReview = null; signalReview(); win.webContents.send('dpro:nabu-review-decision', { id, decision }); return true;
  });
  cleanup.push(() => { for (const name of ['dpro:nabu-review','dpro:nabu-review-clear','girru:code-review','girru:code-review-decide']) ipcMain.removeHandler(name); });
  const openHandler = async (event, value) => {
    if (!allowed(event) || !value || !['bottom,file,folder,top','bottom,file,folder,right,top'].includes(Object.keys(value).sort().join(',')) || !validRight(value.right) || !validTop(value.top) || !validBottom(value.bottom) || typeof value.folder !== 'string' || value.folder.length > 4096 || !path.isAbsolute(value.folder) || value.folder.includes('\0') || !(value.file === null || (typeof value.file === 'string' && value.file.length <= 4096 && value.file && !value.file.includes('\0') && !path.isAbsolute(value.file) && !/^[a-z]:/i.test(value.file) && !value.file.split(/[\\/]/).some(x => x === '..' || /^\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$|^id_(?:rsa|ed25519|ecdsa)/i.test(x))))) return null;
    const sequence = ++targetSequence;
    try {
      const folder = await fs.promises.realpath(value.folder);
      if (!(await fs.promises.stat(folder)).isDirectory() || !allowed(event) || sequence !== targetSequence) return null;
      let file = null;
      if (value.file !== null) {
        file = await fs.promises.realpath(path.resolve(folder, value.file));
        const relative = path.relative(folder, file);
        if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative) || !(await fs.promises.stat(file)).isFile()) return null;
      }
      if (!allowed(event) || sequence !== targetSequence) return null;
      pendingTarget = { id: sequence, folder, file };
      top = value.top; bottom = value.bottom; right = value.right ?? 0; activated = true;
      const result = await select('code');
      if (result.mode === 'code' && pendingTarget) view.webContents.send('girru:code-target-changed');
      return result;
    } catch { return null; }
  };
  ipcMain.handle(CHANNELS.open, openHandler);
  cleanup.push(() => { for (const name of [CHANNELS.open, 'girru:code-target', 'girru:code-target-done']) ipcMain.removeHandler(name); });
  ipcMain.handle('dpro:nabu-commands', event => {
    if (!allowed(event) || mode !== 'code' || !view || view.webContents.isDestroyed()) return false;
    view.webContents.focus();
    const modifiers = [process.platform === 'darwin' ? 'meta' : 'control', 'shift'];
    for (const type of ['keyDown', 'keyUp']) view.webContents.sendInputEvent({ type, keyCode: 'P', modifiers });
    return true;
  });
  cleanup.push(() => ipcMain.removeHandler('dpro:nabu-commands'));
  const statusHandler = event => allowed(event) ? state() : null;
  const selectHandler = (event, message) => {
    if (!allowed(event) || !message || !['bottom,mode,top','bottom,mode,right,top'].includes(Object.keys(message).sort().join(',')) || !['code', 'chat'].includes(message.mode) || !validRight(message.right) || !validTop(message.top) || !validBottom(message.bottom)) return null;
    top = message.top; bottom = message.bottom; right = message.right ?? 0; if(message.mode==='code')activated=true; return select(message.mode);
  };
  const layoutHandler = (event, value) => { if (allowed(event) && value && ['bottom,top','bottom,right,top'].includes(Object.keys(value).sort().join(',')) && validRight(value.right) && validTop(value.top) && validBottom(value.bottom)) { top = value.top; bottom = value.bottom; right = value.right ?? 0; layout(); } };
  ipcMain.handle(CHANNELS.status, statusHandler); ipcMain.handle(CHANNELS.select, selectHandler);
  listen(ipcMain, CHANNELS.layout, layoutHandler);
  cleanup.push(() => { ipcMain.removeHandler(CHANNELS.status); ipcMain.removeHandler(CHANNELS.select); });
  listen(win, 'resize', layout);
  listen(win.webContents, 'did-start-navigation', (_event,_url,inPlace,isMainFrame) => {if(isMainFrame&&!inPlace)hide();});
  listen(win.webContents, 'render-process-gone', hide);
  listen(win.webContents, 'before-input-event', shortcut);
  listen(win.webContents, 'did-start-loading', hide);
  listen(win, 'close', event => {
    if (approvedClose || !view || view.webContents.isDestroyed()) return;
    event.preventDefault();
    void requestClose().then(ok => { if (ok && !win.isDestroyed()) { approvedClose = true; win.close(); } });
  });
  const stop = () => {
    if (stopPromise) return stopPromise;
    disposed = true; generation++;
    for (const remove of cleanup.splice(0)) remove();
    stopPromise = (async () => {
      try {
        if (view) {
          if (!win.isDestroyed() && win.contentView.children.includes(view)) win.contentView.removeChildView(view);
          const contents=view.webContents;
          if (contents && !contents.isDestroyed()) contents.close();
          view = null;
        }
      } finally { await host?.stop(); }
      onLog('Editor runtime stopped.');
    })();
    return stopPromise;
  };
  listen(win, 'closed', () => { void stop(); });
  return { requestClose, stop, state };
}
module.exports = { installNabuEditor, compatibleRuntime, loopbackOrigin, CHANNELS };
