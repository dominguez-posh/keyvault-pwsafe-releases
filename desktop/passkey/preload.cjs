// Bridge of the passkey window: fetch the request, report the result.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('passkeyBridge', {
  request: (id) => ipcRenderer.invoke('passkey:request', id),
  done: (id, result) => ipcRenderer.invoke('passkey:done', id, result),
});
