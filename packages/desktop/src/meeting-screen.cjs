'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
/** A capture request opens a separate trusted picker; the app page receives no source list. */
function installMeetingScreenCapture({ electron, session, getOrigin, getWindows }) {
 const { BrowserWindow, desktopCapturer, ipcMain } = electron, pending = new Map(), opening = new Set();
 const pickerUrl = pathToFileURL(path.join(__dirname, 'pages', 'meeting-screen.html')).href;
 function validRequest(request) {
  try {
   const parent = getWindows().find(w => !w.isDestroyed() && w.webContents.mainFrame === request.frame);
   if (!parent || !request.userGesture || !request.videoRequested || request.audioRequested || !getOrigin()) return null;
   return new URL(request.frame.url).origin === getOrigin() && new URL(request.securityOrigin).origin === getOrigin() ? parent : null;
  } catch { return null; }
 }
 function pickerState(event) { const state = pending.get(event.sender.id); if (!state || event.senderFrame !== state.window.webContents.mainFrame || event.senderFrame.url !== pickerUrl) return null; return state; }
 ipcMain.handle('dpro:meeting-screen-list', event => { const state = pickerState(event); return state ? state.sources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail?.isEmpty() ? '' : s.thumbnail?.toDataURL() ?? '' })) : []; });
 ipcMain.handle('dpro:meeting-screen-choose', (event, id) => { const state = pickerState(event); if (!state) return false; const source = state.sources.find(s => s.id === id); if (typeof id !== 'string' || !source || !validRequest(state.request)) return false; state.finish({ video: source }); return true; });
 ipcMain.handle('dpro:meeting-screen-cancel', event => { const state = pickerState(event); if (!state) return false; state.finish(null); return true; });
 session.setDisplayMediaRequestHandler(async (request, callback) => {
  const parent = validRequest(request); if (opening.has(request.frame) || [...pending.values()].some(s => s.request.frame === request.frame)) { callback(null); return; } if (!parent) { callback(null); return; }
  opening.add(request.frame);
  let window;
  try {
   const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 200, height: 120 } });
   if (!sources.length || !validRequest(request)) { opening.delete(request.frame); callback(null); return; }
   window = new BrowserWindow({ width: 680, height: 560, minWidth: 420, minHeight: 360, parent, modal: true, show: false, title: 'Choose a screen or window', webPreferences: { preload: path.join(__dirname, 'meeting-screen-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
   let finished = false;
   const finish = streams => { if (finished) return; finished = true; clearTimeout(timer); pending.delete(window.webContents.id); parent.webContents.removeListener('did-start-navigation', cancel); parent.webContents.removeListener('destroyed', cancel); try { callback(validRequest(request) ? streams : null); } catch { /* requesting frame was destroyed */ } if (!window.isDestroyed()) window.close(); };
   const cancel = () => finish(null), timer = setTimeout(cancel, 120000); timer.unref?.();
   pending.set(window.webContents.id, { window, sources, request, finish }); opening.delete(request.frame);
   window.once('closed', cancel); parent.webContents.once('did-start-navigation', cancel); parent.webContents.once('destroyed', cancel);
   window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
   window.webContents.on('will-navigate', e => e.preventDefault());
   await window.loadFile(path.join(__dirname, 'pages', 'meeting-screen.html')); if (!window.isDestroyed()) window.show();
  } catch { opening.delete(request.frame); if (window && !window.isDestroyed()) { pending.get(window.webContents.id)?.finish(null); window.close(); } else { try { callback(null); } catch {} } }
 });
 return { pending };
}
module.exports = { installMeetingScreenCapture };
