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
});
