'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// This view has no account, provider, filesystem or general application bridge.
contextBridge.exposeInMainWorld('girruCode', Object.freeze({
  review: () => ipcRenderer.invoke('girru:code-review'),
  decideReview: (id, decision) => ipcRenderer.invoke('girru:code-review-decide', id, decision),
  onReview: callback => { const listener = () => callback(); ipcRenderer.on('girru:code-review-changed', listener); return () => ipcRenderer.removeListener('girru:code-review-changed', listener); },
  target: () => ipcRenderer.invoke('girru:code-target'),
  targetDone: id => ipcRenderer.invoke('girru:code-target-done', id),
  onTarget: callback => { const listener = () => callback(); ipcRenderer.on('girru:code-target-changed', listener); return () => ipcRenderer.removeListener('girru:code-target-changed', listener); },
  pickDirectory: () => ipcRenderer.invoke('girru:code-directory'),
  footer: () => ipcRenderer.invoke('girru:code-footer'),
  navigate: id => typeof id === 'string' && id.length <= 20 ? ipcRenderer.invoke('girru:code-navigate', id) : Promise.resolve(false),
}));
