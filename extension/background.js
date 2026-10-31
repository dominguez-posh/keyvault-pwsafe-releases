// Service worker: autofill, save prompts and the passkey provider on top of the Keevault desktop app.
// All data comes from the running app (lib/desktop.js) – the extension signs in nowhere and has no connection of its
// own. Only the developer demo (chrome.storage.local devDemo, for automated tests) runs a local in-memory session.
// Extension pages may call every command; content scripts only the cs:* commands, which are
// always scoped to the sender's own origin (taken from the browser, never from the message).

import { VaultSession } from './core/session.js';
import { createCredential, getAssertion, effectiveRpId, supportsAlgorithms } from './core/webauthn.js';
import { hostFromUrl, itemMatchesHost, urlScore } from './core/match.js';
import { itemHosts } from './core/model.js';
import { faviconToDataUrl } from './core/image.js';
import { totpCode } from './core/totp.js';
import { b64uEncode, randomBytes, sha256, toHex, mapLimit } from './core/util.js';
import { setLanguage, t } from './core/i18n.js';
import { createDemoBackend } from './core/demo.js';
import * as auth from './lib/auth.js';
import { getSettings, updateSettings } from './lib/settings.js';
import { app, connect as connectApp, onEvent as onAppEvent, snapshot, status as appStatus } from './lib/desktop.js';

const PAGE_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
const VS = 'vs:';
let demo = null;
// Same method names in both: the app client and the demo's VaultSession.
let vault = app;

const sessionStore = {
  async get(key) {
    return (await chrome.storage.session.get(VS + key))[VS + key];
  },
  async set(key, value) {
    await chrome.storage.session.set({ [VS + key]: value });
  },
  async remove(key) {
    await chrome.storage.session.remove(VS + key);
  },
  async keys() {
    return Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith(VS)).map((k) => k.slice(VS.length));
  },
  async clear() {
    const all = await chrome.storage.session.get(null);
    await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith(VS)));
  },
};

onAppEvent(() => broadcast({ type: 'state:changed' }));

const ready = (async () => {
  const s = await getSettings();
  setLanguage(s.language);
  if ((await chrome.storage.local.get('devDemo')).devDemo) {
    demo = createDemoBackend();
    vault = new VaultSession({
      getToken: auth.getToken,
      store: sessionStore,
      fetch: (url, init) => demo.fetch(url, init),
      actor: async () => (await auth.account())?.username || '',
    });
  } else {
    connectApp();
  }
})().catch(() => {});

/** Usable: the app runs and is unlocked (demo: signed in). */
async function isOpen() {
  if (demo) return !!(await auth.account());
  try {
    return !!(await snapshot()).opened;
  } catch {
    return false;
  }
}

async function requireOpen() {
  if (!(await isOpen())) throw new auth.LockedError();
}

// ---------------------------------------------------------------- state, lock, containers

async function containerList() {
  if (!demo) {
    const s = await snapshot().catch(() => null);
    if (!s?.opened) return [];
    return s.containers.map((c) => ({ ...c, count: c.locked ? null : s.summaries.filter((x) => x.containerId === c.id).length }));
  }
  const index = await vault.index();
  return (await vault.containers()).map((c) => ({ ...c, count: index[c.id]?.items.length ?? null, error: c.error || index[c.id]?.error || null }));
}

async function state() {
  await ready;
  const settings = await getSettings();
  const desktop = demo ? { connected: false } : await appStatus();
  const open = await isOpen();
  return {
    demo: !!demo,
    desktop,
    open,
    containers: open ? await containerList() : [],
    settings,
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
  };
}

/** Unlocking happens in the app: bring it to the front (start it when it is not running). */
async function unlock() {
  await ready;
  if (demo) {
    await auth.signInDemo(demo.account);
    await vault.refreshContainers({ discover: true });
    await vault.refreshIndex();
    await broadcast({ type: 'state:changed' });
    return state();
  }
  const s = await appStatus();
  if (s.connected) await app.focus();
  else await app.launch();
  return state();
}

/** Unlock from the popup with the app PIN (the app checks it; wrong PINs count there). */
async function unlockPin(pin) {
  await ready;
  if (demo) return unlock();
  await app.unlockPin(pin);
  await broadcast({ type: 'state:changed' });
  return state();
}

async function lock() {
  if (demo) {
    await auth.clear();
    await vault.clear();
  } else {
    await app.lock();
  }
  await broadcast({ type: 'state:changed' });
}

async function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) if (tab.id >= 0 && /^https?:/.test(tab.url || '')) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
}

// ---------------------------------------------------------------- clipboard (offscreen document)

async function offscreen(message) {
  // Firefox has no offscreen documents: clipboard helpers are skipped there (filling itself works).
  if (!chrome.offscreen) return null;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: 'Copy one-time codes and clear the clipboard after a timeout',
    });
  }
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

async function scheduleClipboardClear(hash) {
  const s = await getSettings();
  const seconds = Number(s.clipboardSeconds) || 0;
  if (!seconds) return;
  await chrome.storage.session.set({ clip: hash });
  await chrome.alarms.create('clipboard', { when: Date.now() + Math.max(30, seconds) * 1000 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'clipboard') return;
  const { clip } = await chrome.storage.session.get('clip');
  if (!clip) return;
  await chrome.storage.session.remove('clip');
  await offscreen({ cmd: 'clearIf', hash: clip }).catch(() => {});
  await chrome.offscreen?.closeDocument().catch(() => {});
});

async function copyTotpAfterFill(item) {
  const s = await getSettings();
  if (!s.copyTotpOnFill || !item.totp) return false;
  try {
    const { code } = await totpCode(item.totp);
    await offscreen({ cmd: 'copy', text: code });
    await scheduleClipboardClear(toHex(await sha256(code)));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- autofill

const senderHost = (sender) => hostFromUrl(sender.origin && sender.origin !== 'null' ? sender.origin : sender.url);

function contentStrings() {
  return {
    unlock: t('Tresor entsperren'),
    unlockSub: t('Mit Microsoft Entra ID anmelden'),
    lockedContainers: t('Geschützte Tresore entsperren'),
    lockedSub: t('Masterpasswort oder Passkey'),
    passkey: t('Passkey'),
    passkeyWait: t('Keevault bestätigt den Passkey …'),
    passkeyOk: t('Mit Passkey angemeldet'),
    passkeyCreated: t('Passkey in Keevault gespeichert'),
    usePasskey: t('Passkey verwenden'),
    otherOptions: t('Andere Optionen'),
    choosePasskey: t('Passkey wählen'),
    savePasskey: t('In Keevault speichern'),
    lockedTitle: t('Keevault ist gesperrt'),
    pinPrompt: t('PIN eingeben, um fortzufahren'),
    unlockButton: t('Entsperren'),
    pin: t('PIN'),
    saveQuestion: t('Passkey in Keevault speichern?'),
    saveIn: t('Speichern in „{vault}“'),
    alreadySaved: t('Für dieses Konto ist bereits ein Passkey im Tresor gespeichert.'),
    otp: t('Einmalcode'),
    noUser: t('(ohne Benutzername)'),
    updateTitle: t('Passwort aktualisieren?'),
    saveTitle: t('Login speichern?'),
    update: t('Aktualisieren'),
    save: t('Speichern'),
    never: t('Nie für diese Website'),
    saved: t('Gespeichert in Keevault ✓'),
    close: t('Schließen'),
  };
}

async function lockedProtected() {
  return (await vault.containers()).filter((c) => c.protected && c.locked).length;
}

async function fillTab({ tabId, containerId, id, force = false }) {
  const item = await vault.getItem(containerId, id);
  const hosts = itemHosts(item);
  const frames = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  let targets = frames.filter((f) => {
    const host = hostFromUrl(f.url);
    return host && itemMatchesHost(hosts, host);
  });
  if (!targets.length) {
    if (!force) {
      const e = new Error(t('Der Eintrag passt nicht zu dieser Website'));
      e.name = 'MismatchError';
      throw e;
    }
    targets = frames.filter((f) => f.frameId === 0);
  }
  let filled = 0;
  for (const f of targets) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'fill', username: item.username, password: item.password }, { frameId: f.frameId });
      if (r?.filled) filled++;
    } catch {
      // Frame without content script (e.g. about:blank).
    }
  }
  if (!filled) throw new Error(t('Kein Anmeldeformular gefunden'));
  return { filled, totpCopied: await copyTotpAfterFill(item) };
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'fill-login' || !tab?.id) return;
  if (!(await isOpen())) {
    if (demo) await openPrompt('unlock', tab);
    else await unlock().catch(() => {});
    return;
  }
  const host = hostFromUrl(tab.url);
  const matches = host ? (await vault.matchesForHost(host)).sort((a, b) => b.updated - a.updated) : [];
  if (matches.length) await fillTab({ tabId: tab.id, containerId: matches[0].containerId, id: matches[0].id }).catch(() => {});
});

// ---------------------------------------------------------------- save prompt

const captureKey = (tabId) => `capture:${tabId}`;

async function writableContainers() {
  return (await vault.containers()).filter((c) => c.access?.write !== false && !c.locked && !c.error).map((c) => ({ id: c.id, name: c.name }));
}

async function describeCapture(p) {
  const s = await getSettings();
  const containers = await writableContainers();
  return {
    action: p.action,
    host: p.host,
    username: p.username,
    title: p.target?.title || '',
    containers,
    defaultContainer: containers.some((c) => c.id === s.defaultContainer) ? s.defaultContainer : containers[0]?.id || '',
    ui: contentStrings(),
  };
}

async function capture({ username = '', password = '' }, sender) {
  const s = await getSettings();
  const host = senderHost(sender);
  if (!s.savePrompt || !host || !password || s.neverSave.includes(host) || !(await isOpen())) return { action: 'none' };
  let action = 'save';
  let target = null;
  for (const m of await vault.matchesForHost(host)) {
    const item = await vault.getItem(m.containerId, m.id);
    if ((item.username || '') === username) {
      if (item.password === password) return { action: 'none' };
      action = 'update';
      target = { containerId: m.containerId, id: m.id, title: item.title };
      break;
    }
  }
  if (action === 'save' && !(await writableContainers()).length) return { action: 'none' };
  const pending = { action, target, host, origin: new URL(sender.url).origin, username, password, created: Date.now() };
  await chrome.storage.session.set({ [captureKey(sender.tab.id)]: pending });
  const info = await describeCapture(pending);
  chrome.tabs.sendMessage(sender.tab.id, { type: 'save:show', info }, { frameId: 0 }).catch(() => {});
  return info;
}

async function pendingCapture(sender) {
  const key = captureKey(sender.tab.id);
  const p = (await chrome.storage.session.get(key))[key];
  if (!p || Date.now() - p.created > 120_000 || !(await isOpen())) return null;
  return p;
}

/** Icon for a new entry: the favicon of the tab the entry comes from ('' if none). */
async function tabIcon(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return faviconToDataUrl(tab?.favIconUrl);
}

async function saveCaptured({ containerId }, sender) {
  const p = await pendingCapture(sender);
  if (!p) throw new Error(t('Nichts zu speichern'));
  let saved;
  if (p.action === 'update') {
    const item = await vault.getItem(p.target.containerId, p.target.id, { fresh: true });
    saved = await vault.saveItem(p.target.containerId, { ...item, password: p.password, icon: item.icon || await tabIcon(sender.tab.id) }, { expectedVersion: item.version });
  } else {
    saved = await vault.saveItem(containerId, { type: 'login', title: p.host, username: p.username, password: p.password, urls: [p.origin], icon: await tabIcon(sender.tab.id) });
    await updateSettings({ defaultContainer: containerId });
  }
  await chrome.storage.session.remove(captureKey(sender.tab.id));
  return { title: saved.title };
}

async function dismissCaptured({ never }, sender) {
  const p = await pendingCapture(sender);
  await chrome.storage.session.remove(captureKey(sender.tab.id));
  if (never && p) {
    const s = await getSettings();
    await updateSettings({ neverSave: [...new Set([...s.neverSave, p.host])] });
  }
}

// ---------------------------------------------------------------- passkeys

const requestKey = (id) => `wa:${id}`;
const loadRequest = async (id) => (await chrome.storage.session.get(requestKey(id)))[requestKey(id)] || null;
const saveRequest = (req) => chrome.storage.session.set({ [requestKey(req.id)]: req });
const deleteRequest = (id) => chrome.storage.session.remove(requestKey(id));

async function containerNames() {
  return new Map((await vault.containers()).map((c) => [c.id, c.name]));
}

/** Passkeys whose entry URL fits the page best come first (keevault.de/admin before keevault.de) – none is dropped. */
function rankCandidates(list, pageUrl) {
  if (!pageUrl) return list;
  return list.map((c, i) => ({ c, i, score: urlScore(c.urls, pageUrl) })).sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.c);
}

async function publicCandidates(list, pageUrl = '') {
  const names = await containerNames();
  return rankCandidates(list, pageUrl).map((c) => ({
    containerId: c.containerId,
    itemId: c.itemId,
    credentialId: c.passkey.credentialId,
    title: c.title,
    userName: c.passkey.userName || c.passkey.userDisplayName || '',
    container: names.get(c.containerId) || '',
  }));
}

async function openPrompt(hash, tab, request) {
  const width = 440;
  const height = 600;
  let left;
  let top;
  try {
    const w = await chrome.windows.get(tab.windowId);
    left = Math.max(0, w.left + w.width - width - 24);
    top = w.top + 80;
  } catch {
    // Default position.
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`prompt/prompt.html#${hash}`), type: 'popup', width, height, left, top, focused: true,
  });
  if (request) {
    request.windowId = win.id;
    await saveRequest(request);
  }
  return win.id;
}

async function cleanupRequests() {
  const all = await chrome.storage.session.get(null);
  const old = Object.entries(all).filter(([k, v]) => k.startsWith('wa:') && Date.now() - v.created > 15 * 60_000).map(([k]) => k);
  if (old.length) await chrome.storage.session.remove(old);
}

/** Entry point for navigator.credentials.create/get from a page. */
async function webauthnRequest({ kind, options, mediation }, sender) {
  const s = await getSettings();
  if (!s.passkeys || !sender.tab || sender.tab.id < 0 || !options) return { fallback: true };
  const origin = sender.origin;
  // Only top-level documents and same-origin frames; cross-origin iframes stay with the browser,
  // which enforces the publickey-credentials permissions policy.
  if (sender.frameId !== 0 && (!sender.tab.url || new URL(sender.tab.url).origin !== origin)) return { fallback: true };
  let rpId;
  try {
    rpId = effectiveRpId(origin, kind === 'create' ? options.rp?.id : options.rpId);
  } catch {
    return { fallback: true }; // The browser reports the proper error.
  }
  if (kind === 'create') {
    if (!supportsAlgorithms(options.pubKeyCredParams)) return { fallback: true };
    if (options.authenticatorSelection?.authenticatorAttachment === 'cross-platform') return { fallback: true };
    if ((options.hints || []).includes('security-key')) return { fallback: true };
  }
  await cleanupRequests();
  const request = {
    id: b64uEncode(randomBytes(12)),
    kind,
    rpId,
    origin,
    pageUrl: sender.url || sender.tab.url || origin,
    options,
    tabId: sender.tab.id,
    frameId: sender.frameId,
    documentId: sender.documentId || null,
    windowId: null,
    conditional: kind === 'get' && mediation === 'conditional',
    created: Date.now(),
  };
  const open = await isOpen();
  if (kind === 'get') {
    const locked = open ? await lockedProtected() : 0;
    if (open) {
      const found = await vault.passkeyCandidates(rpId, options.allowCredentials);
      if (!found.length && !locked) return { fallback: true };
      if (request.conditional) {
        await saveRequest(request);
        return { conditional: { requestId: request.id, locked: false, lockedContainers: locked, candidates: await publicCandidates(found, request.pageUrl), ui: contentStrings() } };
      }
      if (found.length) {
        // Chooser inside the page (a bar at the top, like the browser's own sheet); the window only on request.
        await saveRequest(request);
        return { inline: { requestId: request.id, site: rpId, lockedContainers: locked, candidates: await publicCandidates(found, request.pageUrl), ui: contentStrings() } };
      }
    } else if (request.conditional) {
      await saveRequest(request);
      return { conditional: { requestId: request.id, locked: true, candidates: [], ui: contentStrings() } };
    }
  }
  if (kind === 'create' && open) {
    const inline = await inlineFor(request);
    if (inline) {
      await saveRequest(request);
      return { inline };
    }
  }
  if (!open && !request.conditional && !demo && (await snapshot().catch(() => null))?.pinSet) {
    // App locked, PIN set: the bar asks for the PIN right in the page and then continues there.
    await saveRequest(request);
    return { inline: { kind: 'unlock', requestId: request.id, site: rpId, ui: contentStrings() } };
  }
  await saveRequest(request);
  await openPrompt(`${kind}:${request.id}`, sender.tab, request);
  return { pending: request.id };
}

/** What the in-page bar shows for a request while the app is open: passkeys to choose, or where to save; null = window. */
async function inlineFor(req) {
  const { rpId, options } = req;
  if (req.kind === 'get') {
    const found = await vault.passkeyCandidates(rpId, options.allowCredentials);
    if (!found.length) return null;
    return { requestId: req.id, site: rpId, lockedContainers: await lockedProtected(), candidates: await publicCandidates(found, req.pageUrl), ui: contentStrings() };
  }
  // Saving a new passkey also happens in the bar at the top of the page; the window only on "Other options".
  const containers = await writableContainers();
  if (!containers.length) return null;
  const s = await getSettings();
  const existing = options.excludeCredentials?.length ? await vault.passkeyCandidates(rpId, options.excludeCredentials) : [];
  return {
    kind: 'create', requestId: req.id, site: rpId, rpName: options.rp?.name || rpId,
    user: options.user?.name || options.user?.displayName || '', containers,
    defaultContainer: containers.some((c) => c.id === s.defaultContainer) ? s.defaultContainer : containers[0].id,
    alreadyRegistered: existing.length > 0, ui: contentStrings(),
  };
}

/** PIN entered in the bar: unlock the app, then continue in the bar ({ inline }) or hand over ({ fallback }). */
async function inlineUnlock({ requestId, pin }, sender) {
  const req = await loadRequest(requestId);
  if (!req || req.tabId !== sender.tab?.id || req.frameId !== sender.frameId) throw new Error(t('Die Anfrage ist abgelaufen'));
  await unlockPin(pin); // wrong PIN: throws with the app's message (attempts are counted there)
  const inline = await inlineFor(req);
  if (inline) return { inline };
  await deleteRequest(requestId);
  return { fallback: true };
}

async function finishRequest(requestId, payload, { closeWindow = true } = {}) {
  const req = await loadRequest(requestId);
  if (!req) return;
  await deleteRequest(requestId);
  const target = req.documentId ? { documentId: req.documentId } : { frameId: req.frameId };
  await chrome.tabs.sendMessage(req.tabId, { type: 'webauthn:result', requestId, ...payload }, target).catch(() => {});
  if (closeWindow && req.windowId) chrome.windows.remove(req.windowId).catch(() => {});
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  const all = await chrome.storage.session.get(null);
  for (const [k, req] of Object.entries(all)) {
    if (k.startsWith('wa:') && req.windowId === windowId) {
      await finishRequest(req.id, { error: { name: 'NotAllowedError', message: t('Vom Benutzer abgebrochen') } }, { closeWindow: false });
    }
  }
});

async function webauthnDetails({ requestId }) {
  const req = await loadRequest(requestId);
  if (!req) throw new Error(t('Die Anfrage ist abgelaufen'));
  const out = {
    kind: req.kind,
    rpId: req.rpId,
    origin: req.origin,
    rpName: req.options.rp?.name || req.rpId,
    user: req.kind === 'create' ? { name: req.options.user?.name || '', displayName: req.options.user?.displayName || '' } : null,
    unlocked: await isOpen(),
  };
  if (!out.unlocked) return out;
  out.lockedContainers = (await vault.containers()).filter((c) => c.protected && c.locked).map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
  if (req.kind === 'get') {
    out.candidates = await publicCandidates(await vault.passkeyCandidates(req.rpId, req.options.allowCredentials), req.pageUrl);
    return out;
  }
  const s = await getSettings();
  const host = hostFromUrl(req.origin);
  const names = await containerNames();
  out.containers = await writableContainers();
  out.defaultContainer = out.containers.some((c) => c.id === s.defaultContainer) ? s.defaultContainer : out.containers[0]?.id || '';
  out.logins = (await vault.summaries())
    .filter((x) => x.type === 'login' && (itemMatchesHost(x.hosts, host) || x.rpIds.includes(req.rpId)))
    .map((x) => ({ containerId: x.containerId, id: x.id, title: x.title, username: x.username, container: names.get(x.containerId) || '' }));
  out.alreadyRegistered = req.options.excludeCredentials?.length
    ? await publicCandidates(await vault.passkeyCandidates(req.rpId, req.options.excludeCredentials))
    : [];
  return out;
}

async function sign(req, candidate) {
  const { response, signCount } = await getAssertion({
    origin: req.origin, rpId: req.rpId, challenge: req.options.challenge, passkey: candidate.passkey,
  });
  if (signCount > 0) {
    // Imported passkeys that count: persist the new counter (best effort).
    vault.getItem(candidate.containerId, candidate.itemId, { fresh: true }).then((item) => vault.saveItem(candidate.containerId, {
      ...item,
      passkeys: item.passkeys.map((p) => (p.credentialId === candidate.passkey.credentialId ? { ...p, signCount } : p)),
    })).catch(() => {});
  }
  return response;
}

async function findCandidate(req, { containerId, itemId, credentialId }) {
  const found = await vault.passkeyCandidates(req.rpId, req.options.allowCredentials);
  const c = found.find((x) => x.containerId === containerId && x.itemId === itemId && x.passkey.credentialId === credentialId);
  if (!c) throw new Error(t('Passkey nicht gefunden'));
  return c;
}

async function webauthnApprove({ requestId, containerId, itemId, credentialId, title }) {
  await requireOpen();
  const req = await loadRequest(requestId);
  if (!req) throw new Error(t('Die Anfrage ist abgelaufen'));
  if (req.kind === 'get') {
    const response = await sign(req, await findCandidate(req, { containerId, itemId, credentialId }));
    await finishRequest(requestId, { result: response });
    return { done: true };
  }
  if (req.options.excludeCredentials?.length) {
    const existing = await vault.passkeyCandidates(req.rpId, req.options.excludeCredentials);
    if (existing.length) {
      await finishRequest(requestId, { error: { name: 'InvalidStateError', message: t('Für dieses Konto ist bereits ein Passkey registriert') } });
      return { done: true };
    }
  }
  const { passkey, response } = await createCredential({
    origin: req.origin,
    rpId: req.rpId,
    rpName: req.options.rp?.name,
    user: req.options.user,
    challenge: req.options.challenge,
    pubKeyCredParams: req.options.pubKeyCredParams,
    credProps: !!req.options.extensions?.credProps,
  });
  // Store first: a passkey the site knows but the vault lost would lock the user out.
  if (itemId) {
    const item = await vault.getItem(containerId, itemId, { fresh: true });
    await vault.saveItem(containerId, {
      ...item,
      passkeys: [...item.passkeys, passkey],
      urls: item.urls.length ? item.urls : [req.origin],
      username: item.username || req.options.user?.name || '',
    }, { expectedVersion: item.version });
  } else {
    await vault.saveItem(containerId, {
      type: 'login', title: title || req.options.rp?.name || req.rpId, username: req.options.user?.name || '', urls: [req.origin], passkeys: [passkey], icon: await tabIcon(req.tabId),
    });
  }
  await updateSettings({ defaultContainer: containerId });
  await finishRequest(requestId, { result: response });
  return { done: true };
}

/** The page's content script picked a passkey (conditional field menu or the in-page chooser bar). */
async function conditionalSelect(msg, sender) {
  const req = await loadRequest(msg.requestId);
  if (!req || req.kind !== 'get' || req.tabId !== sender.tab?.id || req.frameId !== sender.frameId) throw new Error(t('Ungültige Anfrage'));
  const response = await sign(req, await findCandidate(req, msg));
  await deleteRequest(msg.requestId);
  return { result: response };
}

/** "Save" in the in-page bar: stores the new passkey; the result reaches the page like from the window. */
async function inlineCreate({ requestId, containerId }, sender) {
  const req = await loadRequest(requestId);
  if (!req || req.kind !== 'create' || req.tabId !== sender.tab?.id || req.frameId !== sender.frameId) throw new Error(t('Ungültige Anfrage'));
  return webauthnApprove({ requestId, containerId, itemId: '', title: req.options.rp?.name || req.rpId });
}

/** "Other options" in the in-page chooser: the full prompt window takes over the pending request. */
async function inlineWindow({ requestId }, sender) {
  const req = await loadRequest(requestId);
  if (!req || req.tabId !== sender.tab?.id) throw new Error(t('Die Anfrage ist abgelaufen'));
  await openPrompt(`${req.kind}:${req.id}`, sender.tab, req);
  return { pending: req.id };
}

async function conditionalCandidates({ requestId }, sender) {
  const req = await loadRequest(requestId);
  if (!req || req.tabId !== sender.tab?.id) return { locked: false, candidates: [] };
  if (!(await isOpen())) return { locked: true, candidates: [] };
  return {
    locked: false,
    lockedContainers: await lockedProtected(),
    candidates: await publicCandidates(await vault.passkeyCandidates(req.rpId, req.options.allowCredentials), req.pageUrl),
  };
}

async function abortRequest({ requestId }, sender) {
  const req = await loadRequest(requestId);
  if (!req || req.tabId !== sender.tab?.id) return;
  await deleteRequest(requestId);
  if (req.windowId) chrome.windows.remove(req.windowId).catch(() => {});
}

// ---------------------------------------------------------------- import

async function importItems({ containerId, items }) {
  await requireOpen();
  const errors = [];
  let done = 0;
  await mapLimit(items, 4, async (item) => {
    try {
      await vault.saveItem(containerId, { ...item, id: '' });
    } catch (e) {
      errors.push(`${item.title}: ${e.message}`);
    }
    done++;
    chrome.runtime.sendMessage({ type: 'import:progress', done, total: items.length }).catch(() => {});
  });
  await broadcast({ type: 'state:changed' });
  return { imported: items.length - errors.length, errors };
}

// ---------------------------------------------------------------- message routing

/** Locked or app not running: bring the app to the front (or start it), where unlocking happens. */
const showApp = () => (demo ? null : unlock());

const pageCommands = {
  state: () => state(),
  unlock: () => unlock(),
  unlockPin: ({ pin }) => unlockPin(pin),
  lock: () => lock(),
  refresh: async () => {
    await requireOpen();
    if (demo) await vault.refreshIndex();
    else await app.refresh();
    return state();
  },
  items: async () => {
    await requireOpen();
    return vault.summaries();
  },
  item: async ({ containerId, id, fresh }) => vault.getItem(containerId, id, { fresh }),
  save: async ({ containerId, item, expectedVersion }) => vault.saveItem(containerId, item, { expectedVersion }),
  delete: ({ containerId, id }) => vault.deleteItem(containerId, id),
  tabContext: async ({ tabId }) => {
    const tab = await chrome.tabs.get(tabId);
    const host = hostFromUrl(tab.url);
    return { host, url: tab.url, matches: host && (await isOpen()) ? await vault.matchesForHost(host) : [] };
  },
  fill: (msg) => fillTab(msg),
  settings: () => getSettings(),
  updateSettings: async ({ patch }) => {
    const s = await updateSettings(patch);
    setLanguage(s.language);
    await broadcast({ type: 'state:changed' });
    return s;
  },
  clipboardCopied: ({ hash }) => scheduleClipboardClear(hash),
  openPrompt: async ({ hash }) => openPrompt(hash, (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] || {}),
  desktopStatus: () => appStatus(),
  desktopFocus: () => showApp(),
  import: (msg) => importItems(msg),
  'webauthn:details': (msg) => webauthnDetails(msg),
  'webauthn:approve': (msg) => webauthnApprove(msg),
  'webauthn:fallback': ({ requestId }) => finishRequest(requestId, { fallback: true }),
  'webauthn:cancel': ({ requestId }) => finishRequest(requestId, { error: { name: 'NotAllowedError', message: t('Vom Benutzer abgebrochen') } }),
};

const contentCommands = {
  'cs:matches': async (_msg, sender) => {
    const s = await getSettings();
    const host = senderHost(sender);
    if (!s.inlineMenu || !host) return { enabled: false };
    const ui = contentStrings();
    if (!(await isOpen())) {
      // App not running: no menu at all – the extension only works together with the app.
      if (!demo && !(await appStatus()).connected) return { enabled: false };
      return { enabled: true, locked: true, configured: true, ui };
    }
    const names = await containerNames();
    return {
      enabled: true,
      locked: false,
      lockedContainers: await lockedProtected(),
      ui,
      items: (await vault.matchesForHost(host)).map((m) => ({
        containerId: m.containerId, id: m.id, title: m.title, username: m.username, hasTotp: !!m.hasTotp, container: names.get(m.containerId) || '',
      })),
    };
  },
  /** Current one-time code of an entry, only for a matching site (filled straight into the code field). */
  'cs:totp': async ({ containerId, id }, sender) => {
    const item = await vault.getItem(containerId, id);
    if (!itemMatchesHost(itemHosts(item), senderHost(sender))) throw new Error(t('Der Eintrag passt nicht zu dieser Website'));
    if (!item.totp) throw new Error(t('Kein Einmalcode (TOTP) hinterlegt'));
    return { code: (await totpCode(item.totp)).code };
  },
  'cs:fill': async ({ containerId, id }, sender) => {
    const item = await vault.getItem(containerId, id);
    if (!itemMatchesHost(itemHosts(item), senderHost(sender))) throw new Error(t('Der Eintrag passt nicht zu dieser Website'));
    const totpCopied = await copyTotpAfterFill(item);
    return { username: item.username, password: item.password, totpCopied };
  },
  'cs:capture': (msg, sender) => capture(msg, sender),
  'cs:pending': async (_msg, sender) => {
    const p = await pendingCapture(sender);
    return p ? describeCapture(p) : null;
  },
  'cs:saveCaptured': (msg, sender) => saveCaptured(msg, sender),
  'cs:dismissCaptured': (msg, sender) => dismissCaptured(msg, sender),
  'cs:unlock': async (_msg, sender) => (demo ? openPrompt('unlock', sender.tab) : showApp()),
  'cs:unlockContainers': async (_msg, sender) => (demo ? openPrompt('containers', sender.tab) : showApp()),
  'cs:webauthn': (msg, sender) => webauthnRequest(msg, sender),
  'cs:webauthnSelect': (msg, sender) => conditionalSelect(msg, sender),
  'cs:webauthnCandidates': (msg, sender) => conditionalCandidates(msg, sender),
  'cs:webauthnAbort': (msg, sender) => abortRequest(msg, sender),
  'cs:webauthnWindow': (msg, sender) => inlineWindow(msg, sender),
  'cs:webauthnCreate': (msg, sender) => inlineCreate(msg, sender),
  'cs:webauthnUnlock': (msg, sender) => inlineUnlock(msg, sender),
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg?.cmd) return undefined;
  const fromPage = (sender.origin || new URL(sender.url).origin) === PAGE_ORIGIN;
  const handler = fromPage ? pageCommands[msg.cmd] : contentCommands[msg.cmd];
  if (!handler || (!fromPage && !sender.tab)) return undefined;
  ready
    .then(() => handler(msg, sender))
    .then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: { name: error.name, message: error.message, status: error.status } }),
    );
  return true;
});
