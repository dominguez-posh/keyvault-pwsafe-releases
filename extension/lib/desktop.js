// The extension's only data source: the Keevault desktop app, reached over native messaging. The app signs in, holds
// the keys and talks to Azure; the extension never connects anywhere itself. Without the running app it does nothing.
//
// One native port stays open while the service worker lives (it also keeps the worker alive). The host reports
// whether the app is reachable ("online"/"offline") and relays the app's events, so status changes and edits show up
// at once. Entries come as one snapshot that is reused until the app reports a change.

import { t } from '../core/i18n.js';
import { itemMatchesHost } from '../core/match.js';
import { filterPasskeys } from '../core/webauthn.js';
import { reportedStage } from '../core/channel.js';

const HOST = 'com.kvpwsafe.desktop';
const SNAPSHOT_MAX_AGE = 60_000;
let port = null;
let seq = 0;
let online = null; // null: not known yet, false: app not running, true: app reachable
let hostError = '';
let lastAttempt = 0;
// #505: a lost host (an app update ends it, a crash) is started again by itself, so the next click finds a warm port
// instead of paying the host start. Backoff from 1 s up to 1 min, back to 1 s once the host reports the app online;
// a host that is missing or keeps failing costs one attempt per minute at most, never a loop.
const RETRY_MIN = 1000;
const RETRY_MAX = 60_000;
let retryDelay = RETRY_MIN;
let retryTimer = null;
let hello = null;
let helloInfo = null; // the last answer to hello, read without waiting
let snap = null;
let snapAt = 0;
// #495: the last snapshot the app sent, readable without waiting (cleared with every event: change, lock, offline).
let lastSnap = null;
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
  helloInfo = null;
  snap = null;
  lastSnap = null;
}

function failAll() {
  for (const p of pending.values()) p.reject(offlineError());
  pending.clear();
}

function onMessage(msg) {
  if (msg?.event) {
    if (msg.event === 'online') {
      online = true;
      retryDelay = RETRY_MIN;
    }
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

function scheduleReconnect() {
  if (retryTimer) return;
  const delay = retryDelay;
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

/** Opens the native port (starts the host). Called at start-up, at browser start, after a lost host (with backoff)
 * and whenever a request finds no port. */
export function connect() {
  if (port) return;
  clearTimeout(retryTimer);
  retryTimer = null;
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
    scheduleReconnect();
  });
}

/** #505: warm start. The listeners make the browser start the worker when it starts or installs the extension, so the
 * host runs before the first click (an open native port keeps the worker alive). Only the port: no hello, no list –
 * nothing from the app sits in memory before something asks for it. wanted() → Promise<boolean> (false in the demo). */
export function warmStart(wanted) {
  const go = () => wanted().then((yes) => { if (yes) connect(); }, () => {});
  chrome.runtime.onStartup.addListener(go);
  chrome.runtime.onInstalled.addListener(go);
}

function request(cmd, args = {}, timeout = 30_000) {
  // No port: start the host again, but not in a tight loop when it is missing.
  if (!port && Date.now() - lastAttempt > 2000) connect();
  if (!port || online === false) return Promise.reject(offlineError());
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(Object.assign(new Error(t('Keevault-App antwortet nicht')), { name: 'TimeoutError' })); // #508
    }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    // id/cmd last: arguments must never overwrite the request number (the answer is matched by it).
    port.postMessage({ ...args, id, cmd });
  });
}

// The app version this extension needs (passkeys and protected copy, see the caps checks below); sent in hello so the app
// can say "update the app" itself when it is older (#454).
const MIN_APP_VERSION = '0.9.29';

function ready() {
  // The first hello may wait for the approval in the desktop app.
  if (!hello) {
    hello = request('hello', { extVersion: chrome.runtime.getManifest().version, minApp: MIN_APP_VERSION }, 120_000).catch((e) => { hello = null; throw e; });
    hello.then((h) => { helloInfo = h; }, () => {});
  }
  return hello;
}

/** #464: what the connected app can do for the popup (history, assets, moving, moving a passkey). An app without the
 * capability, or none connected, simply has none of them: the popup hides the function, no error. */
export function appFeatures() {
  const caps = helloInfo?.caps || [];
  return { history: caps.includes('history'), assets: caps.includes('linkedEntries'), move: caps.includes('move'), passkeyMove: caps.includes('movePasskey') };
}

/**
 * #420: the release stage the connected app reports (stable, beta, dev); it unlocks only new functions
 * (extension/core/channel.js). No app, no hello yet, or an unknown claim: "stable" (Prod).
 */
export const appStage = () => reportedStage(helloInfo?.stage);

const needCap = async (cap) => {
  if (!(await ready()).caps?.includes(cap)) throw new Error(t('Die Keevault-App ist zu alt für diese Funktion – bitte die App aktualisieren'));
};

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
  current.then((s) => { if (snap === current) lastSnap = s; }, () => {});
  current.catch(() => {
    if (snap === current) snap = null;
  });
  return current;
}

/** #495: the last snapshot without waiting – only what the worker already holds in memory, null when there is none. */
export const cachedSnapshot = () => lastSnap;

const changedHere = (result) => {
  snap = null;
  lastSnap = null;
  return result;
};

export async function status() {
  try {
    const s = await snapshot();
    return { connected: true, version: s.version, opened: !!s.opened, pinSet: !!s.pinSet, ...(s.passkeyPin ? { passkeyPin: s.passkeyPin } : {}) };
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
  /** Admin tools: the account of a sign-in the user just started in the app, only for this host (else null). */
  // #464: history, linked assets and moving, through the app (older apps lack the capability: the popup hides these).
  history: async (containerId, itemId) => { await needCap('history'); return call('history', { containerId, itemId }); },
  getVersion: async (containerId, itemId, version) => { await needCap('history'); return call('version', { containerId, itemId, version }); },
  linkedEntries: async (containerId, itemId) => { await needCap('linkedEntries'); return call('linkedEntries', { containerId, itemId }); },
  planMove: async (fromId, toId, itemId) => { await needCap('move'); return call('planMove', { fromId, toId, itemId }); },
  moveItem: async (fromId, toId, itemId, { folder, expectedVersion } = {}) => { await needCap('move'); return changedHere(await call('move', { fromId, toId, itemId, folder, expectedVersion }, 120_000)); },
  moveWithAssets: async (fromId, toId, itemId, { folder, expected } = {}) => {
    await needCap('move');
    return changedHere(await call('moveWithAssets', { fromId, toId, itemId, folder, expected }, 300_000));
  },
  movePasskey: async (args) => { await needCap('movePasskey'); return changedHere(await call('movePasskey', args, 120_000)); },
  signIn: (host, tab) => call('signIn', { host, tab }),
  signInDone: (host) => call('signInDone', { host }),
  saveItem: async (containerId, item, { expectedVersion } = {}) => changedHere(await call('save', { containerId, item, expectedVersion })),
  deleteItem: async (containerId, itemId) => changedHere(await call('delete', { containerId, itemId })),
  async matchesForHost(host) {
    return (await this.summaries()).filter((s) => s.type === 'login' && itemMatchesHost(s.hosts, host));
  },
  async passkeyCandidates(rpId, allowCredentials = []) {
    const list = await call('passkeyCandidates', { rpId });
    return list.filter((c) => filterPasskeys([c.passkey], rpId, allowCredentials).length);
  },
  /** #439: the app signs (an app before 0.9.29 has no such command: the answer says so, there is no local fallback). */
  passkeySign: async (args) => {
    if (!(await ready()).caps?.includes('passkeySign')) throw new Error(t('Die Keevault-App ist zu alt für Passkeys in der Erweiterung – bitte die App aktualisieren (ab Version 0.9.29)'));
    return call('passkeySign', args);
  },
  /** Reloads the vaults from Azure in the app (popup "Reload"). */
  refresh: async () => changedHere(await call('refresh', {}, 120_000)),
  focus: () => call('focus'),
  /** Copies through the app: kept out of Windows' clipboard history and cloud clipboard, cleared after a while (#337). */
  // An app without the copy capability (before 0.9.27) says so clearly. Never a fallback to the browser's clipboard.
  copy: async (text) => {
    if (!(await ready()).caps?.includes('copy')) throw new Error(t('Die Keevault-App ist zu alt zum geschützten Kopieren – bitte die App aktualisieren (ab Version 0.9.27)'));
    return call('copy', { text });
  },
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
