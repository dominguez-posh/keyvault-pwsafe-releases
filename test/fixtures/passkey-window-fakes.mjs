// Fakes for test/passkey-window-536.test.js: Electron and the main-process modules passkey-window.js imports, so that
// the real module runs in Node. The loader below maps the imports to the exports of this file.
import { EventEmitter } from 'node:events';

export const log = { diag: [], loads: [] };

class FakeWebContents extends EventEmitter {
  constructor(session) { super(); this.session = session; }
  loadURL(url) { log.loads.push(url); return Promise.resolve(); }
}

export class BrowserWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.visible = false;
    this.focused = false;
    this.destroyed = false;
    this.webContents = new FakeWebContents(opts.webPreferences?.session);
    BrowserWindow.all.push(this);
  }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  show() { if (!this.visible) { this.visible = true; this.emit('show'); } }
  hide() { if (this.visible) { this.visible = false; this.emit('hide'); } }
  focus() { this.focused = true; }
  moveTop() { this.movedTop = true; }
  loadURL(url) { return this.webContents.loadURL(url); }
  removeMenu() {}
  setTitle() {}
  /** Like the user's X: Electron emits 'close' and destroys the window unless a handler prevents it. */
  close() {
    let prevented = false;
    this.emit('close', { preventDefault: () => { prevented = true; } });
    if (!prevented) this.destroyed = true;
  }
}
BrowserWindow.all = [];

const handlers = new Map();
export const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
export const invoke = (name, sender, ...args) => handlers.get(name)({ sender }, ...args);

const passkeySession = { protocol: { handle() {} }, setPermissionRequestHandler() {} };
export const session = { fromPartition: () => passkeySession };
export const app = { getLocale: () => 'de' };
export const net = { fetch: async () => new Response('') };
export const nativeTheme = { shouldUseDarkColors: false };

// desktop/main/boot.js
export const SERVED = [];
export const appRoot = '.';
export const here = '.';
export const missingFiles = [];
export const smokeTest = false;
// desktop/main/state.js
export const config = { get: () => ({ language: 'de' }) };
export const quitting = false;
export const win = new BrowserWindow({});
win.visible = true;
// desktop/main/diag.js
export const diag = (line) => log.diag.push(line);
