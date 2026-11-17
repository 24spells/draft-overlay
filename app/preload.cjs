const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, handler) {
  const listener = (_event, ...args) => handler(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('draftOverlay', {
  onDraftView: (callback) => subscribe('overlay:view', callback),
  onToggleHidden: (callback) => subscribe('overlay:toggle-hidden', callback),
  getSetStats: (setCode, format, cardIds) =>
    ipcRenderer.invoke('overlay:stats', setCode, format, cardIds),
  setInteractive: (interactive) =>
    ipcRenderer.send('overlay:interactive', interactive),
  getCoachData: (setCode) => ipcRenderer.invoke('overlay:coach', setCode),
  getReview: () => ipcRenderer.invoke('overlay:review'),
  openReview: (url) => ipcRenderer.invoke('overlay:open-review', url),
  getLatestRun: () => ipcRenderer.invoke('overlay:latest-run'),
  getSealedPool: () => ipcRenderer.invoke('overlay:sealed-pool'),
  getAccount: () => ipcRenderer.invoke('overlay:account'),
  onAccount: (callback) => subscribe('overlay:account', callback),
  connectAccount: () => ipcRenderer.invoke('overlay:connect'),
  onMulligan: (callback) => subscribe('overlay:mulligan', callback),
  getMullModel: (setCode) => ipcRenderer.invoke('overlay:mull-model', setCode),
});
