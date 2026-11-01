'use strict';
/**
 * Girru desktop app, Electron main process (INSTALLER-05, D-INSTALL-SHELL).
 *
 * - One instance only; a second launch focuses the open window.
 * - "This computer" (default): the bundled backend + UI bridge on 127.0.0.1,
 *   random ports, per-launch token (local-runtime.cjs). First run opens the
 *   owner setup with a one-time code in the URL fragment (INSTALLER-07).
 * - "Existing Girru": the window opens another Girru's address (https, or http
 *   on this computer); nothing runs locally.
 * - Quit (menu, Cmd/Ctrl+Q, last window closed) stops the backend first.
 */
const electron = require('electron');
const { app, BrowserWindow, Menu, ipcMain, session, shell, dialog } = electron;
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLocalRuntime, openLog } = require('./local-runtime.cjs');
const { resolvePayload, backendArgs, checkPayload } = require('./payload.cjs');
const { loadSettings, saveSettings, remoteOrigin } = require('./settings.cjs');
const { installNabuEditor } = require('./nabu-editor.cjs');

const discovery = require('./data-discovery.cjs');
// Keep the existing profile before Electron derives storage from the display name.
require('./branding.cjs').configureBranding(app);
let selectedData = null;
let discovered = [];
const PAGES = path.join(__dirname, 'pages');
const PAGES_URL = `${pathToFileURL(PAGES).href}/`;
let mainWindow = null;
let connectWindow = null;
let runtime = null;
let log = null;
let appOrigin = null;
let quitting = false;
let stopped = false;
let nabuEditor = null;
let editorLog = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(boot);
}

/** Data for "this computer": <userData>/data (DPRO_DESKTOP_DATA_DIR overrides, e.g. for tests). */
const dataDir = () => selectedData || (process.env.DPRO_DESKTOP_DATA_DIR ? path.resolve(process.env.DPRO_DESKTOP_DATA_DIR) : path.join(app.getPath('userData'), 'data'));
const settingsDir = () => app.getPath('userData');

function hardenSession() {
  require('./meeting-screen.cjs').installMeetingScreenCapture({ electron, session: session.defaultSession, getOrigin: () => appOrigin, getWindows: () => [mainWindow, ...chatWindows].filter(Boolean) });
  // Media and clipboard writes only for this origin; screen capture also requires the trusted picker.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const origin = (() => { try { return new URL(details.requestingUrl || contents.getURL()).origin; } catch { return null; } })();
    callback(origin !== null && origin === appOrigin && (permission === 'media' || permission === 'display-capture' || permission === 'clipboard-sanitized-write'));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => requestingOrigin === appOrigin && (permission === 'media' || permission === 'display-capture' || permission === 'clipboard-sanitized-write'));
}

function openExternal(url) {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') shell.openExternal(url);
  } catch { /* not a URL */ }
}

function createMainWindow() {
  const win = createAppWindow();
  win.on('closed', () => { mainWindow = null; });
  return win;
}

// Every window shows only the app's own origin; other links open in the normal browser.
function createAppWindow() {
  const area = electron.screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1280, area.width), height: Math.min(860, area.height), minWidth: Math.min(800, area.width), minHeight: Math.min(600, area.height),
    title: 'Girru', show: false, backgroundColor: '#111111',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: true, preload: path.join(__dirname, 'preload.cjs') },
  });
  win.once('ready-to-show', () => win.show());
  // Links to other sites open in the normal browser; the window stays on the app.
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    let origin = null;
    try { origin = new URL(url).origin; } catch { /* invalid */ }
    if (url.startsWith(PAGES_URL)) return;
    if (origin !== appOrigin) { event.preventDefault(); openExternal(url); }
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  return win;
}

// A chat in a window of its own (⌘O), asked for by a window of the app on the app's origin.
const chatWindows = new Set();
ipcMain.handle('dpro:open-chat-window', async (event, id) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!appOrigin || !sender || (sender !== mainWindow && !chatWindows.has(sender)) || event.senderFrame !== sender.webContents.mainFrame) return false;
  let origin = null;
  try { origin = new URL(event.senderFrame.url).origin; } catch { /* invalid */ }
  if (origin !== appOrigin || typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(id) || chatWindows.size >= 8) return false;
  const win = createAppWindow();
  chatWindows.add(win);
  win.on('closed', () => chatWindows.delete(win));
  await win.loadURL(`${appOrigin}/#chat=${id}`);
  return true;
});

function showPage(name, query = {}) {
  appOrigin = null;
  for (const win of chatWindows) win.close();
  if (name === 'welcome.html') setSetupWindow(true);
  return mainWindow.loadFile(path.join(PAGES, name), { query });
}

// Setup uses the normal app window. Keep the owner's size and allow resizing.
function setSetupWindow(_setup) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setResizable(true);
}

function startupStatus(status) {
  if (!mainWindow || !mainWindow.webContents || !mainWindow.webContents.getURL().startsWith(pathToFileURL(path.join(PAGES, 'starting.html')).href)) return;
  mainWindow.webContents.send('dpro:startup-status', status);
}

async function startLocal() {
  await showPage('starting.html', { status: 'Checking the installation files…' });
  try {
    const payload = resolvePayload({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
    const problems = checkPayload(payload);
    if (problems.length) return showPage('failed.html', { reason: problems.join(', ') });
    startupStatus('Preparing your workspace…');
    log = log || openLog(path.join(app.getPath('userData'), 'logs', 'backend.log'));
    const { createApplicationServer } = require(path.join(payload.coreUiDir, 'scripts', 'application-server.cjs'));
    runtime = createLocalRuntime({
      node: payload.node,
      readyTimeoutMs: 30000,
      args: backendArgs(payload.backendDir),
      cwd: path.basename(dataDir()) === '.data' ? path.dirname(dataDir()) : dataDir(),
      dataDir: dataDir(),
      extraEnv: { AGENT_TERMINAL: 'true', DPRO_SUBSCRIPTION_CHAT: '1', ...(path.basename(dataDir()) === '.data' ? { AGENT_PLAYER_DATA_DIR: undefined } : {}) },
      createBridge: ({ upstreamPort, launchToken }) => createApplicationServer({ packageRoot: payload.coreUiDir, channel: 'candidate', upstreamPort, launchToken }),
      onLog: line => log.write(line),
      onBackendExit: ({ code, signal }) => {
        // BACKUP-01: the program stops with 75 to put a backup in place; start it again.
        if (code === 75 && !quitting) { log.write('backend restarting (restore)'); runtime = null; void startLocal(); return; }
        log.write(`backend stopped unexpectedly (${signal || code})`);
        if (!quitting && mainWindow) showPage('failed.html', { reason: 'The Girru engine stopped unexpectedly.' });
        runtime = null;
      },
    });
    startupStatus('Starting the local engine…');
    const started = await runtime.start();
    appOrigin = started.origin;
    startupStatus('Opening your workspace…');
    await mainWindow.loadURL(started.url);
  } catch (error) {
    runtime = null;
    log?.write(`start failed: ${error.message}`);
    for (const line of error.logTail || []) log?.write(`  ${line}`);
    await showPage('failed.html', { reason: error.message });
  }
}

async function startRemote(origin) {
  appOrigin = origin;
  try { await mainWindow.loadURL(`${origin}/`); }
  catch { await showPage('failed.html', { reason: `Could not open ${origin}.`, remote: '1' }); }
}

async function stopLocal() {
  const current = runtime;
  runtime = null;
  if (current) await current.stop();
}

async function applyMode() {
  const settings = loadSettings(settingsDir());
  if (settings.mode === 'remote' && settings.remoteUrl) {
    await stopLocal();
    return startRemote(settings.remoteUrl);
  }
  if (!runtime) {
    if (!selectedData) {
      await showPage('starting.html', { status: 'Looking for an existing workspace…' });
      await scanData();
      let decision = discovery.decide(discovered, readSelection());
      try { const saved = JSON.parse(fs.readFileSync(path.join(settingsDir(), 'workspace.json'), 'utf8')); if (saved.newWorkspace === true && saved.dir.startsWith(path.join(settingsDir(), 'workspaces') + path.sep) && discovered.find(r => r.dir === saved.dir)?.state === 'unconfigured') decision = { kind: 'existing', dir: saved.dir }; } catch { /* no confirmed new workspace */ }
      if (decision.kind === 'new') selectedData = require('./workspace-selection.cjs').createWorkspace(settingsDir());
      else if (decision.kind === 'existing') selectedData = decision.dir;
      else return showPage('welcome.html');
      if (!readSelection()) {
        const file = path.join(settingsDir(), 'workspace.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify({ dir: selectedData }), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
      }
    }
    return startLocal();
  }
}

function readSelection() { return require('./workspace-selection.cjs').readSelection(settingsDir()); }
async function scanData(extra) {
  const payload = resolvePayload({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const dirs = discovery.candidates({ defaultDir: path.join(settingsDir(), 'data'), home: app.getPath('home'), cwd: process.cwd(), backendDir: payload.backendDir, savedDir: readSelection(), workspaceRoot: path.join(settingsDir(), 'workspaces'), explicitDir: process.env.DPRO_DESKTOP_DATA_DIR });
  if (extra && !dirs.includes(extra)) dirs.push(extra);
  discovered = await discovery.discover(payload.node, payload.backendDir, dirs, extra ? null : readSelection());
  fs.writeFileSync(path.join(settingsDir(), 'workspace-discovery.json'), JSON.stringify(discovered), { mode: 0o600 });
  return discovered;
}
// Only the active local workspace can open this user-driven folder chooser.
ipcMain.handle('dpro:choose-project-folders', async event => {
  if (!runtime || !mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return [];
  let origin;try {origin=new URL(event.senderFrame.url).origin;}catch{return [];}
  if (origin !== appOrigin || !appOrigin.startsWith('http://127.0.0.1:')) return [];
  const result=await dialog.showOpenDialog(mainWindow,{title:'Choose project folders to scan for documentation',properties:['openDirectory','multiSelections']});
  return result.canceled ? [] : result.filePaths.slice(0,8);
});
const notificationControl = require('./desktop-notifications.cjs').createDesktopNotifications({
  Notification: electron.Notification,
  optedIn: (() => { try { return JSON.parse(fs.readFileSync(path.join(settingsDir(), 'desktop-notifications.json'), 'utf8')).requested === true; } catch { return false; } })(),
  saveOptIn: () => fs.writeFileSync(path.join(settingsDir(), 'desktop-notifications.json'), '{"requested":true}\n', { mode: 0o600 }),
});
ipcMain.handle('dpro:notify-done', event => {
  if (!runtime || !appOrigin || !mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || mainWindow.isFocused()) return false;
  try { if (!appOrigin.startsWith('http://127.0.0.1:') || new URL(event.senderFrame.url).origin !== appOrigin) return false; } catch { return false; }
  return notificationControl.done();
});
// Native permission controls are available only on the bundled first-launch page.
const { permissionStatus, requestMicrophone, createFilePermissions, requestFullDiskRegistration } = require('./permissions.cjs');
const filePermissions = createFilePermissions({ getPath: name => app.getPath(name), fs, platform: process.platform });
async function devicePermissionStatus() { return { ...permissionStatus(electron.systemPreferences, process.platform), ...await filePermissions.check(), ...notificationControl.view() }; }
function fromPermissions(event) {
  return !!mainWindow && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame && event.senderFrame.url === pathToFileURL(path.join(PAGES, 'permissions.html')).href;
}
ipcMain.handle('dpro:permissions-status', event => fromPermissions(event) ? devicePermissionStatus() : null);
ipcMain.handle('dpro:permissions-microphone', async event => { if (!fromPermissions(event)) return null; await requestMicrophone(electron.systemPreferences, shell, process.platform); return devicePermissionStatus(); });
ipcMain.handle('dpro:permissions-files', async event => {
  if (!fromPermissions(event)) return null;
  if (filePermissions.view().folders.some(folder => folder.status === 'denied')) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
  await filePermissions.request();
  return devicePermissionStatus();
});
ipcMain.handle('dpro:permissions-notifications', event => fromPermissions(event) ? notificationControl.test() : null);
ipcMain.handle('dpro:permissions-notification-settings', event => {
  if (!fromPermissions(event)) return false;
  void shell.openExternal(process.platform === 'win32' ? 'ms-settings:notifications' : 'x-apple.systempreferences:com.apple.preference.notifications');
  return true;
});
ipcMain.handle('dpro:permissions-full-disk', async event => {
  if (!fromPermissions(event) || process.platform !== 'darwin') return null;
  const result = await requestFullDiskRegistration({ fs, home: app.getPath('home'), path, platform: process.platform });
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  return result;
});
ipcMain.handle('dpro:permissions-next', async event => {
  if (!fromPermissions(event) || !(await devicePermissionStatus()).files) return false;
  fs.writeFileSync(path.join(settingsDir(), 'permissions-reviewed-v3.json'), '{"reviewed":true}\n', { mode: 0o600 });
  await applyMode();
  return true;
});
const fromWelcome = event => mainWindow && event.sender === mainWindow.webContents && mainWindow.webContents.getURL().split('?')[0] === pathToFileURL(path.join(PAGES, 'welcome.html')).href;
const fromFailed = event => mainWindow && event.sender === mainWindow.webContents && mainWindow.webContents.getURL().split('?')[0] === pathToFileURL(path.join(PAGES, 'failed.html')).href;
ipcMain.handle('dpro:show-log-folder', event => {
  if (!fromFailed(event)) return false;
  void shell.openPath(path.join(app.getPath('userData'), 'logs'));
  return true;
});
ipcMain.handle('dpro:setup-window', (event, compact) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false;
  let origin = null;
  try { origin = new URL(event.senderFrame.url).origin; } catch { /* invalid frame */ }
  if (!appOrigin || !appOrigin.startsWith('http://127.0.0.1:') || origin !== appOrigin || typeof compact !== 'boolean') return false;
  setSetupWindow(compact);
  return true;
});
ipcMain.handle('dpro:discover-data', event => fromWelcome(event) ? discovered : []);
// A project's folder in Finder / Explorer (right-click › Show in Finder), asked for by a window of the app.
ipcMain.handle('dpro:reveal-folder', async (event, folder) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!appOrigin || !sender || (sender !== mainWindow && !chatWindows.has(sender)) || event.senderFrame !== sender.webContents.mainFrame) return false;
  let origin = null;
  try { origin = new URL(event.senderFrame.url).origin; } catch { /* invalid */ }
  if (origin !== appOrigin || typeof folder !== 'string' || folder.length > 4096 || !path.isAbsolute(folder) || /[\x00-\x1f]/.test(folder)) return false;
  try { if (!fs.statSync(folder).isDirectory()) return false; } catch { return false; }
  shell.showItemInFolder(path.join(folder, '.'));
  return true;
});
ipcMain.handle('dpro:find-data', async event => {
  if (!fromWelcome(event)) return { ok: false };
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose the folder containing agent-player.db', properties: ['openDirectory', 'showHiddenFiles'] });
  if (!result.canceled) await scanData(result.filePaths[0]);
  return { ok: true };
});
ipcMain.handle('dpro:select-data', async (event, dir) => {
  if (!fromWelcome(event) || !discovered.some(r => r.dir === dir && r.state === 'existing')) return { ok: false };
  const payload = resolvePayload({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  if ((await discovery.probe(payload.node, payload.backendDir, dir)).state !== 'existing') return { error: 'The existing account could not be verified. No new account was created.' };
  selectedData = dir;
  const file = path.join(settingsDir(), 'workspace.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ dir }), { mode: 0o600 }); fs.renameSync(file + '.tmp', file);
  await applyMode(); return { ok: true };
});
ipcMain.handle('dpro:new-workspace', async (event, confirmed) => {
  if (!fromWelcome(event) || confirmed !== true) return { ok: false };
  selectedData = path.join(settingsDir(), 'workspaces', require('node:crypto').randomUUID());
  fs.mkdirSync(selectedData, { recursive: true, mode: 0o700 });
  const file = path.join(settingsDir(), 'workspace.json');
  fs.writeFileSync(file, JSON.stringify({ dir: selectedData, newWorkspace: true }), { mode: 0o600 });
  await startLocal(); return { ok: true };
});

function openConnectWindow() {
  if (connectWindow) return connectWindow.focus();
  connectWindow = new BrowserWindow({
    parent: mainWindow || undefined, modal: Boolean(mainWindow), width: 520, height: 360, resizable: false,
    title: 'Connect to an existing Girru', show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.cjs') },
  });
  connectWindow.setMenu(null);
  connectWindow.once('ready-to-show', () => connectWindow.show());
  connectWindow.webContents.on('will-navigate', event => event.preventDefault());
  connectWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  connectWindow.on('closed', () => { connectWindow = null; });
  const { remoteUrl } = loadSettings(settingsDir());
  connectWindow.loadFile(path.join(PAGES, 'connect.html'), { query: remoteUrl ? { current: remoteUrl } : {} });
}

const fromConnectWindow = event => connectWindow && event.sender === connectWindow.webContents;

ipcMain.handle('dpro:connect', async (event, input) => {
  if (!fromConnectWindow(event)) return { ok: false };
  const origin = remoteOrigin(input);
  if (!origin) return { ok: false, error: 'Use an https:// address, or http:// on this computer (127.0.0.1 or localhost).' };
  try { await require('./connection-check.cjs').checkConnection(origin); } catch (error) { return { ok: false, error: error.message }; }
  saveSettings(settingsDir(), { mode: 'remote', remoteUrl: origin });
  connectWindow.close();
  await applyMode();
  return { ok: true };
});

ipcMain.handle('dpro:use-local', async event => {
  if (!fromConnectWindow(event) && !(mainWindow && event.sender === mainWindow.webContents && !appOrigin)) return { ok: false };
  const settings = loadSettings(settingsDir());
  saveSettings(settingsDir(), { mode: 'local', remoteUrl: settings.remoteUrl });
  if (connectWindow) connectWindow.close();
  await applyMode();
  return { ok: true };
});

ipcMain.handle('dpro:retry', async event => {
  if (!(mainWindow && event.sender === mainWindow.webContents && !appOrigin)) return { ok: false };
  await applyMode();
  return { ok: true };
});

ipcMain.handle('dpro:open-connect', event => {
  if (!(mainWindow && event.sender === mainWindow.webContents && !appOrigin)) return { ok: false };
  openConnectWindow();
  return { ok: true };
});

function navigate(destination) {
  if (mainWindow && appOrigin) mainWindow.webContents.send('dpro:navigate', destination);
}
ipcMain.handle('dpro:app-info', event => {
  if (!mainWindow || event.sender !== mainWindow.webContents || !appOrigin) return null;
  return { version: app.getVersion(), connection: loadSettings(settingsDir()).mode };
});
// MACAPP-01: updates of the installed app (Settings › About and updates). Only the main
// window's own Girru page may ask; installing backs up first and replaces the app.
let updater = null;
let systemTray = null;
const fromAppPage = event => !!mainWindow && !!appOrigin && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame;
function startUpdater() {
  if (!app.isPackaged || updater) return;
  updater = require('./app-update.cjs').createUpdater({
    currentVersion: app.getVersion(), settingsDir: settingsDir(),
    backUp: () => runtime ? runtime.backUp() : Promise.resolve({ ok: false, error: 'Girru is not running here' }),
    relaunch: () => { app.relaunch(); app.quit(); },
  });
  updater.cleanOld();
  updater.onChange(view => { if (mainWindow && appOrigin) mainWindow.webContents.send('dpro:app-update', view); });
  const daily = () => { void updater.checkIfDue(); };
  setTimeout(daily, 60_000).unref?.();
  setInterval(daily, 3_600_000).unref?.();
}
ipcMain.handle('dpro:app-update-state', event => fromAppPage(event) && updater ? updater.view() : null);
ipcMain.handle('dpro:app-update-check', event => fromAppPage(event) && updater ? updater.check() : null);
ipcMain.handle('dpro:app-update-install', async event => {
  if (!fromAppPage(event) || !updater || !updater.view().update) return null;
  const v = updater.view().update.version;
  const answer = await dialog.showMessageBox(mainWindow, { type: 'question', message: `Back up and update to Girru ${v}?`, detail: 'Girru makes a backup of your data, puts the new version in place and starts again. Your saved workspace is kept; valid sign-in sessions are restored.', buttons: ['Cancel', 'Back up and update'], defaultId: 1, cancelId: 0 });
  return answer.response === 1 ? updater.install() : updater.view();
});
ipcMain.handle('dpro:app-update-page', event => { if (fromAppPage(event) && updater?.view().update) void shell.openExternal(updater.view().update.page); return null; });
async function chooseWorkspace() {
  const result = await dialog.showMessageBox(mainWindow, { type: 'question', message: 'Open another workspace?', detail: 'This closes your current session and stops this local engine. Your saved conversations and keys stay in their existing folders.', buttons: ['Cancel', 'Choose workspace'], defaultId: 0, cancelId: 0 });
  if (result.response !== 1) return;
  await stopLocal(); selectedData = null; await scanData(); await showPage('welcome.html');
}
function buildMenu() {
  const mac = process.platform === 'darwin';
  const settings = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => navigate('settings') };
  const about = { label: 'About Girru', click: () => app.showAboutPanel() };
  app.setAboutPanelOptions({ applicationName: 'Girru', applicationVersion: app.getVersion() });
  const template = [
    ...(mac ? [{ label: 'Girru', submenu: [about, settings, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'Choose Workspace…', click: chooseWorkspace },
      { label: 'Use Girru on This Computer', click: async () => { saveSettings(settingsDir(), { ...loadSettings(settingsDir()), mode: 'local' }); await applyMode(); } },
      { label: 'Connect to an Existing Girru…', click: openConnectWindow },
      { type: 'separator' }, { label: 'Account…', click: () => navigate('account') },
      ...(!mac ? [settings, about, { role: 'quit' }] : []),
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ label: 'Welcome / Workspace', click: () => navigate('home') }, { type: 'separator' }, { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [
      { label: 'Getting Started', click: () => dialog.showMessageBox(mainWindow, { message: 'Getting started with Girru', detail: 'Open your existing workspace from File, then sign in with its existing account. Conversations and tools stay locked until sign-in. Settings contains appearance, account access and version information.' }) },
      { label: 'Show Log Folder', click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')) },
      { label: 'Version & Updates', click: () => navigate('about') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function boot() {
  // From source the dock shows Electron's icon; a packaged app has the Girru icon from build/.
  if (!app.isPackaged && process.platform === 'darwin') { try { app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png')); } catch { /* keep the default */ } }
  fs.mkdirSync(settingsDir(), { recursive: true, mode: 0o700 });
  hardenSession();
  buildMenu();
  mainWindow = createMainWindow();
  systemTray = require('./system-tray.cjs').createSystemTray({ electron, platform: process.platform, getWindow: () => mainWindow, navigate, checkUpdates: () => updater?.check() });
  const payload = resolvePayload({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  nabuEditor = installNabuEditor({
    win: mainWindow, electron, getOrigin: () => appOrigin,
    runtimeRoot: process.env.DPRO_NABU_ROOT || path.join(process.resourcesPath, 'nabu-runtime'),
    node: process.env.DPRO_DESKTOP_NODE || payload.node, dataDir: path.join(settingsDir(), 'nabu-editor'),
    onLog: line => { editorLog ||= openLog(path.join(settingsDir(), 'logs', 'editor.log')); editorLog.write(line); },
  });
  const permissions = permissionStatus(electron.systemPreferences, process.platform);
  const firstMacLaunch = process.platform === 'darwin' && (!fs.existsSync(path.join(settingsDir(), 'permissions-reviewed-v3.json')));
  if (firstMacLaunch || (process.platform === 'win32' && permissions.microphone === 'denied' && !fs.existsSync(path.join(settingsDir(), 'permissions-reviewed-v3.json')))) await showPage('permissions.html');
  else await applyMode();
  startUpdater();
}

// The app lives in one window: closing it quits (and stops the backend) on every OS.
app.on('window-all-closed', () => app.quit());

app.on('before-quit', event => {
  if (stopped) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  Promise.resolve(nabuEditor?.requestClose()).then(async allowed => {
    if (allowed === false) { quitting = false; return false; }
    try { await nabuEditor?.stop(); } finally {
      try { await session.defaultSession.cookies.flushStore(); session.defaultSession.flushStorageData(); }
      catch { log?.write('Session storage could not be flushed before shutdown.'); }
      await stopLocal();
    }
    return true;
  })
    .catch(error => { quitting = false; if (log) log.write(`stop failed: ${error.message}`); editorLog?.write(`Editor shutdown failed: ${error.message}`); return false; })
    .then(allowed => { if (allowed === false) return; stopped = true; if (log) log.close(); editorLog?.close(); app.quit(); });
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', event => event.preventDefault());
});

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.quit());
