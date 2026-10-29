// The extension's only data source: the Keevault desktop app, reached over native messaging. The app signs in, holds
// the keys and talks to Azure; the extension never connects anywhere itself. Without the running app it does nothing.
//
// One native port stays open while the service worker lives (it also keeps the worker alive). The host reports
// whether the app is reachable ("online"/"offline") and relays the app's events, so status changes and edits show up
// at once. Entries come as one snapshot that is reused until the app reports a change.

import { t } from '../core/i18n.js';
import { itemMatchesHost } from '../core/match.js';
import { filterPasskeys } from '../core/webauthn.js';

const HOST = 'com.kvpwsafe.desktop';
const SNAPSHOT_MAX_AGE = 60_000;
let port = null;
let seq = 0;
let online = null; // null: not known yet, false: app not running, true: app reachable
let hostError = '';
let lastAttempt = 0;
let hello = null;
let snap = null;
let snapAt = 0;
const pending = new Map();
const listeners = new Set();

/** fn(event): 'online', 'offline', 'changed' – after any of them the snapshot is reloaded on demand. */
export function onEvent(fn) {
  listeners.add(fn);
}

const emit = (event) => {
  for (const fn of listeners) fn(event);
};

function offlineError() {
  const missing = /not found|nicht gefunden/i.test(hostError);
  return Object.assign(new Error(missing ? t('Keevault-App ist nicht installiert') : t('Keevault-App läuft nicht')), { name: missing ? 'AppMissing' : 'AppOffline' });
}

function forget() {
  hello = null;
  snap = null;
}

function failAll() {
  for (const p of pending.values()) p.reject(offlineError());
  pending.clear();
}

function onMessage(msg) {
  if (msg?.event) {
    if (msg.event === 'online') online = true;
    if (msg.event === 'offline') {
      online = false;
      failAll();
    }
    forget();
    emit(msg.event);
    return;
  }
  const p = pending.get(msg?.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(Object.assign(new Error(msg.error?.message || 'Error'), { name: msg.error?.name }));
}

/** Opens the native port (starts the host). Called at start-up and whenever a request finds no port. */
export function connect() {
  if (port) return;
  lastAttempt = Date.now();
  hostError = '';
  online = null;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    hostError = chrome.runtime.lastError?.message || '';
    port = null;
    online = false;
    forget();
    failAll();
    emit('offline');
  });
}

function request(cmd, args = {}, timeout = 30_000) {
  // No port: start the host again, but not in a tight loop when it is missing.
  if (!port && Date.now() - lastAttempt > 2000) connect();
  if (!port || online === false) return Promise.reject(offlineError());
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(t('Keevault-App antwortet nicht')));
    }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    // id/cmd last: arguments must never overwrite the request number (the answer is matched by it).
    port.postMessage({ ...args, id, cmd });
  });
}

function ready() {
  // The first hello may wait for the approval in the desktop app.
  if (!hello) hello = request('hello', {}, 120_000).catch((e) => { hello = null; throw e; });
  return hello;
}

const call = async (cmd, args, timeout) => {
  await ready();
  return request(cmd, args, timeout);
};

/** { opened, version, containers, summaries } – cached until the app reports a change. */
export function snapshot() {
  if (snap && Date.now() - snapAt < SNAPSHOT_MAX_AGE) return snap;
  snapAt = Date.now();
  const current = (async () => {
    const h = await ready();
    let s;
    try {
      s = await request('snapshot', {}, 60_000);
      // Big vaults: the rest of the list comes in pages (native messaging allows 1 MB per message).
      if (s.more) {
        const pages = Math.ceil(s.more.total / s.more.pageSize);
        for (let page = 1; page < pages; page++) s.summaries.push(...(await request('summariesPage', { page, pageSize: s.more.pageSize }, 60_000)));
      }
    } catch (e) {
      if (!/Unknown command/.test(e.message)) throw e;
      // App before 0.5.9.
      const [containers, summaries] = await Promise.all([request('containers'), request('summaries', {}, 60_000)]);
      s = { opened: !!h.opened, version: h.version, containers, summaries };
    }
    return { ...s, containers: s.containers.map((c) => ({ ...c, kind: 'remote' })) };
  })();
  snap = current;
  current.catch(() => {
    if (snap === current) snap = null;
  });
  return current;
}

const changedHere = (result) => {
  snap = null;
  return result;
};

export async function status() {
  try {
    const s = await snapshot();
    return { connected: true, version: s.version, opened: !!s.opened, pinSet: !!s.pinSet };
  } catch (e) {
    return { connected: false, error: e.message, reason: e.name };
  }
}

/** Vault API of the background script – the same method names the desktop app's VaultSession uses. */
export const app = {
  containers: async () => (await snapshot()).containers,
  summaries: async () => (await snapshot()).summaries,
  async container(id) {
    const c = (await this.containers()).find((x) => x.id === id);
    if (!c) throw new Error(t('Tresor nicht gefunden'));
    return c;
  },
  getItem: (containerId, itemId) => call('item', { containerId, itemId }),
  saveItem: async (containerId, item, { expectedVersion } = {}) => changedHere(await call('save', { containerId, item, expectedVersion })),
  deleteItem: async (containerId, itemId) => changedHere(await call('delete', { containerId, itemId })),
  async matchesForHost(host) {
    return (await this.summaries()).filter((s) => s.type === 'login' && itemMatchesHost(s.hosts, host));
  },
  async passkeyCandidates(rpId, allowCredentials = []) {
    const list = await call('passkeyCandidates', { rpId });
    return list.filter((c) => filterPasskeys([c.passkey], rpId, allowCredentials).length);
  },
  /** Reloads the vaults from Azure in the app (popup "Reload"). */
  refresh: async () => changedHere(await call('refresh', {}, 120_000)),
  focus: () => call('focus'),
  lock: async () => changedHere(await call('lock')),
  /** Unlocks the app with its PIN (silent sign-in in the app; a Microsoft window only if the tenant insists). */
  unlockPin: async (pin) => changedHere(await call('unlockPin', { pin }, 120_000)),
  /** Starts the app; the host does that itself, it works while the app is not running. */
  launch() {
    if (!port) connect();
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => pending.delete(id) && reject(offlineError()), 5000);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      port.postMessage({ id, cmd: 'launch' });
    });
  },
};
