// The setup window's bridge (app/setup.html): read the checks, flip the switches, connect, finish.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  state: () => ipcRenderer.invoke('setup:state'),
  set: (key, value) => ipcRenderer.invoke('setup:set', key, value),
  connect: () => ipcRenderer.invoke('setup:connect'),
  done: () => ipcRenderer.invoke('setup:done'),
  open: (which) => ipcRenderer.invoke('setup:open', which),
  onChanged: (fn) => ipcRenderer.on('setup:changed', () => fn()),
});
