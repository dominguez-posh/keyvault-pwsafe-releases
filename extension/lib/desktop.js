// Containers of the desktop app (Key Vault and file), reached over native messaging (adapter for VaultSession,
// kind "remote"). The desktop app signs in, holds the keys and does the work; it asks once per browser for approval.

import { t } from '../core/i18n.js';

const HOST = 'com.kvpwsafe.desktop';
let port = null;
let seq = 0;
let hello = null;
let failedAt = 0;
const pending = new Map();
const listeners = new Set();
let enabled = () => true;

export function configure({ isEnabled, onEvent }) {
  enabled = isEnabled;
  if (onEvent) listeners.add(onEvent);
}

function reset(error) {
  port = null;
  hello = null;
  for (const p of pending.values()) p.reject(new Error(error || t('Desktop-App nicht erreichbar')));
  pending.clear();
}

function connect() {
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener((msg) => {
    if (msg?.event) {
      if (msg.event === 'offline') {
        failedAt = Date.now();
        const p = port;
        reset();
        p?.disconnect();
      }
      for (const fn of listeners) fn(msg.event);
      return;
    }
    const p = pending.get(msg?.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(Object.assign(new Error(msg.error?.message || 'Error'), { name: msg.error?.name }));
  });
  port.onDisconnect.addListener(() => {
    failedAt = Date.now();
    reset(chrome.runtime.lastError?.message);
  });
}

function request(cmd, args = {}, timeout = 15_000) {
  if (!port) connect();
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new Error(t('Desktop-App antwortet nicht')));
    }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    // id/cmd last: arguments must never overwrite the request number (the answer is matched by it).
    port.postMessage({ ...args, id, cmd });
  });
}

async function ready() {
  if (!(await enabled())) throw new Error(t('Desktop-Verbindung ist ausgeschaltet'));
  if (!port && Date.now() - failedAt < 30_000) throw new Error(t('Desktop-App nicht erreichbar'));
  // The first hello may wait for the approval in the desktop app.
  if (!hello) hello = request('hello', {}, 120_000).catch((e) => { hello = null; failedAt = Date.now(); throw e; });
  return hello;
}

const call = async (cmd, args, timeout) => {
  await ready();
  return request(cmd, args, timeout);
};

const inDesktop = () => {
  throw new Error(t('Das geht bei Datei-Tresoren nur in der Desktop-App'));
};

export async function status() {
  failedAt = 0; // an explicit status check always tries again
  try {
    const h = await ready();
    return { connected: true, version: h.version, opened: !!h.opened };
  } catch (e) {
    return { connected: false, error: e.message };
  }
}

export const desktopAdapter = {
  async containers() {
    const list = await call('containers');
    return list.map((c) => ({ ...c, remote: true }));
  },
  summaries: async (id) => (await call('summaries')).filter((s) => s.containerId === id),
  getItem: (id, itemId) => call('item', { containerId: id, itemId }),
  saveItem: (id, item, { expectedVersion } = {}) => call('save', { containerId: id, item, expectedVersion }),
  deleteItem: (id, itemId) => call('delete', { containerId: id, itemId }),
  passkeyCandidates: (rpId) => call('passkeyCandidates', { rpId }),
  async protectionInfo(id) {
    const c = (await this.containers()).find((x) => x.id === id);
    return { kind: 'remote', protected: true, locked: !!c?.locked, methods: null, passkeys: [] };
  },
  async unlock() {
    await call('focus').catch(() => {});
    throw new Error(t('Entsperren geht in der Desktop-App'));
  },
  lock: inDesktop,
  updateKeyring: inDesktop,
  trash: inDesktop,
  restore: inDesktop,
  purge: inDesktop,
  history: inDesktop,
  getVersion: inDesktop,
  focus: () => call('focus'),
};
