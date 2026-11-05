// What the window knows right now: the app state from the main process (st), the entries (items), what is
// selected and shown (ui) and caches per vault. Read directly; st and items change only through the setters.

export const ui = { view: 'all', containerId: null, selected: null, editing: null, editingItem: null, query: '', folder: '', folderOf: null, multi: new Set(), multiFolders: new Set(), anchor: null, type: '', vaultQuery: '', searchAll: false, devices: false };

export const explicitFolders = new Map(); // containerId → created folders (also empty ones)
export const folderIconMap = new Map(); // containerId → { [stored folder path]: symbol name or image data URL }
export const logos = new Map(); // containerId → data URL | null (loaded once per session, refreshed on change)
export const busyContainers = new Set(); // containerIds being loaded or reconciled right now (sidebar spinner)

export const progressListeners = new Set();

export let st = null;
export let items = [];

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setItems(value) { items = value; return value; }
export function setSt(value) { st = value; return value; }
