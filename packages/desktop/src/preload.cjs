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
    open: (folder, file, top, bottom, right = 0) => ipcRenderer.invoke('dpro:nabu-open', { folder, file: file ?? null, top, bottom, right }),
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
  revealFolder: folder => ipcRenderer.invoke('dpro:reveal-folder', String(folder)),
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
