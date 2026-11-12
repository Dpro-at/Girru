'use strict';
// Buttons of the app's own local pages (starting / failed / connect) only.
// Pages from a Girru server (local or remote) get nothing from here.
const { contextBridge, ipcRenderer } = require('electron');

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('dproDesktop', {
    enableNotifications: () => ipcRenderer.invoke('dpro:permissions-notifications'),
    notificationSettings: () => ipcRenderer.invoke('dpro:permissions-notification-settings'),
    permissionStatus: () => ipcRenderer.invoke('dpro:permissions-status'),
    fullDiskSettings: () => ipcRenderer.invoke('dpro:permissions-full-disk'),
    enableFiles: () => ipcRenderer.invoke('dpro:permissions-files'),
    enableMicrophone: () => ipcRenderer.invoke('dpro:permissions-microphone'),
    permissionsNext: () => ipcRenderer.invoke('dpro:permissions-next'),
    discoverData: () => ipcRenderer.invoke('dpro:discover-data'),
    findData: () => ipcRenderer.invoke('dpro:find-data'),
    selectData: dir => ipcRenderer.invoke('dpro:select-data', String(dir)),
    newWorkspace: confirmed => ipcRenderer.invoke('dpro:new-workspace', confirmed === true),
    connect: url => ipcRenderer.invoke('dpro:connect', String(url)),
    useLocal: () => ipcRenderer.invoke('dpro:use-local'),
    retry: () => ipcRenderer.invoke('dpro:retry'),
    updateFromFailed: () => ipcRenderer.invoke('dpro:failed-update'),
    restoreFromFailed: () => ipcRenderer.invoke('dpro:failed-restore'),
    otherWorkspace: () => ipcRenderer.invoke('dpro:failed-workspace'),
    openConnect: () => ipcRenderer.invoke('dpro:open-connect'),
    showLogs: () => ipcRenderer.invoke('dpro:show-log-folder'),
    onStartupStatus: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('dpro:startup-status', listener);
      return () => ipcRenderer.removeListener('dpro:startup-status', listener);
    },
  });
}

// Public application metadata and fixed navigation only; never filesystem or authentication access.
contextBridge.exposeInMainWorld('dproApp', {
  notifyDone: () => ipcRenderer.invoke('dpro:notify-done'),
  nabu: {
    review: value => ipcRenderer.invoke('dpro:nabu-review', value),
    clearReview: id => ipcRenderer.invoke('dpro:nabu-review-clear', id),
    onReviewDecision: callback => { const listener = (_event,value) => callback(value); ipcRenderer.on('dpro:nabu-review-decision',listener); return () => ipcRenderer.removeListener('dpro:nabu-review-decision',listener); },
    status: () => ipcRenderer.invoke('dpro:nabu-status'),
    showCommands: () => ipcRenderer.invoke('dpro:nabu-commands'),
    // CODE-OPEN-01: options { line?, note?, readOnly? } (sent only when given).
    open: (folder, file, top, bottom, right = 0, options) => ipcRenderer.invoke('dpro:nabu-open', options && typeof options === 'object' && Object.keys(options).length ? { folder, file: file ?? null, top, bottom, right, options } : { folder, file: file ?? null, top, bottom, right }),
    select: (mode, top, bottom, right = 0) => ipcRenderer.invoke('dpro:nabu-select', { mode, top, bottom, right }),
    layout: (top, bottom, right = 0) => ipcRenderer.send('dpro:nabu-layout', { top, bottom, right }),
    onState: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('dpro:nabu-state', listener);
      return () => ipcRenderer.removeListener('dpro:nabu-state', listener);
    },
  },
  chooseProjectFolders: options => ipcRenderer.invoke('dpro:choose-project-folders', options),
  openChatWindow: id => ipcRenderer.invoke('dpro:open-chat-window', String(id)),
  setSetupWindow: compact => ipcRenderer.invoke('dpro:setup-window', compact === true),
  // WIN-01: the app menu (File, Edit, View, Window, Help) under the bar's ☰ button on Windows.
  openAppMenu: (x, y) => ipcRenderer.invoke('dpro:app-menu', { x: Number(x), y: Number(y) }),
  revealFolder: folder => ipcRenderer.invoke('dpro:reveal-folder', String(folder)),
  // CODE-OPEN-01: one file in Finder / Explorer (the fallback when Code is not installed).
  revealFile: file => ipcRenderer.invoke('dpro:reveal-file', String(file)),
  info: () => ipcRenderer.invoke('dpro:app-info'),
  // MACAPP-01: updates of the installed app. The page reads and asks; installing is confirmed by the app itself.
  appUpdate: {
    state: () => ipcRenderer.invoke('dpro:app-update-state'),
    check: () => ipcRenderer.invoke('dpro:app-update-check'),
    install: () => ipcRenderer.invoke('dpro:app-update-install'),
    openRelease: () => ipcRenderer.invoke('dpro:app-update-page'),
    onState: callback => {
      const listener = (_event, value) => callback(value);
      ipcRenderer.on('dpro:app-update', listener);
      return () => ipcRenderer.removeListener('dpro:app-update', listener);
    },
  },
  onNavigate: callback => {
    const listener = (_event, destination) => { if (['home', 'settings', 'account', 'about', 'new-chat', 'agents', 'library', 'board', 'memory'].includes(destination)) callback(destination); };
    ipcRenderer.on('dpro:navigate', listener);
    return () => ipcRenderer.removeListener('dpro:navigate', listener);
  },
});

// Reuse the signed-in shell's actual footer actions and role gates.
ipcRenderer.on('dpro:code-footer', (_event, id) => {
  const names = { chat: 'Chat', agents: 'Agents', library: 'Library', board: 'Board', memory: 'Memory', approvals: 'Approvals', store: 'Store', terminal: 'Terminal', genvr: 'GenVR', skills: 'Skills', personalities: 'Personalities', specialties: 'Specialties', settings: 'Settings' };
  if (!Object.hasOwn(names, id)) return;
  const name = names[id];
  const button = Array.from(document.querySelectorAll('.shell-footer button[aria-label]')).find(b => b.getAttribute('aria-label') === name || b.getAttribute('aria-label')?.startsWith(name + ','));
  button?.click();
});

// WIN-01: the page knows it is the window's bar (Mac or Windows), so its top bar can be dragged and leaves
// room for the window buttons. On Windows the buttons take the bar's colours, light or dark.
const desktopKind = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : '';
if (desktopKind) {
  const mark = () => { if (document.documentElement) document.documentElement.dataset.desktop = desktopKind; };
  mark();
  window.addEventListener('DOMContentLoaded', () => {
    mark();
    if (desktopKind !== 'win') return;
    const hex = value => { const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(value || ''); if (!m || (m[4] !== undefined && Number(m[4]) === 0)) return null; return '#' + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join(''); };
    let last = '', queued = false;
    const send = () => {
      queued = false;
      const bar = document.querySelector('.titlebar');
      const color = hex(getComputedStyle(bar || document.body).backgroundColor) || hex(getComputedStyle(document.body).backgroundColor);
      const symbol = hex(getComputedStyle(bar || document.body).color);
      if (!color || !symbol || color + symbol === last) return;
      last = color + symbol;
      ipcRenderer.send('dpro:window-bar', { color, symbol });
    };
    const later = () => { if (!queued) { queued = true; requestAnimationFrame(send); } };
    new MutationObserver(later).observe(document.documentElement, { attributes: true, subtree: true, childList: true, attributeFilter: ['data-theme', 'class'] });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', later);
    later();
  });
}
