const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('backlot', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  test: (kind, v) => ipcRenderer.invoke('settings:test', kind, v),
  openExternal: (u) => ipcRenderer.invoke('app:openExternal', u),
  openLogs: () => ipcRenderer.invoke('app:openLogs'),
  openSettings: () => ipcRenderer.invoke('app:openSettings'),
  retry: () => ipcRenderer.invoke('app:retry'),
  quit: () => ipcRenderer.invoke('app:quit'),
  cancelSettings: () => ipcRenderer.invoke('app:cancelSettings'),
  on: (channel, fn) => {
    if (!['status', 'error', 'reset'].includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => fn(payload));
  },
});
