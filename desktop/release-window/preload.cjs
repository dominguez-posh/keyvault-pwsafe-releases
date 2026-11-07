// Bridge of the release approval dialog: the only thing the page can do is answer once. The channel name is random
// per dialog and comes from the main process as a start argument; the main process also checks the sender.
const { contextBridge, ipcRenderer } = require('electron');

const channel = (process.argv.find((a) => a.startsWith('--release-dialog=')) || '').slice('--release-dialog='.length);
contextBridge.exposeInMainWorld('releaseDialog', {
  // The page reports once that it was built with content; the window is shown only then (and closed with a message if not).
  ready: (filled) => ipcRenderer.send(`release:ready:${channel}`, filled === true),
  decide: (yes) => ipcRenderer.send(`release:decide:${channel}`, yes === true),
});
