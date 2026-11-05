// Handles of the running app that every module needs: the window, settings, sign-in, the vault session and the
// services started at launch. Read them directly; change them only through the setters at the end.

export let win = null;
export let config;
export let auth;
export let files;
export let vault;
export let bridge = null;
export let opened = false;

export let windows = null;

export let quitting = false;
export let updater = null;

export let mcp = null;

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setVault(value) { vault = value; return value; }
export function setOpened(value) { opened = value; return value; }
export function setQuitting(value) { quitting = value; return value; }
export function setBridge(value) { bridge = value; return value; }
export function setWin(value) { win = value; return value; }
export function setConfig(value) { config = value; return value; }
export function setAuth(value) { auth = value; return value; }
export function setFiles(value) { files = value; return value; }
export function setWindows(value) { windows = value; return value; }
export function setUpdater(value) { updater = value; return value; }
export function setMcp(value) { mcp = value; return value; }
