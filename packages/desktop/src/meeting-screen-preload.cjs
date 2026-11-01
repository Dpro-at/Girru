'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('meetingShare', {
 list: () => ipcRenderer.invoke('dpro:meeting-screen-list'),
 choose: id => typeof id === 'string' ? ipcRenderer.invoke('dpro:meeting-screen-choose', id) : Promise.resolve(false),
 cancel: () => ipcRenderer.invoke('dpro:meeting-screen-cancel'),
});
