// Minimal bridge: the sandboxed renderer can only call the main-process API and receive events.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pwsafe', {
  invoke: (method, args) => ipcRenderer.invoke('api', method, args),
  onEvent: (listener) => {
    ipcRenderer.on('event', (_event, data) => listener(data));
  },
});
