// Hidden window on http://localhost for WebAuthn with PRF (passkeys that unlock vaults), and serving the app's
// own files to both windows.

import { app, BrowserWindow, ipcMain, net, nativeTheme, session } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { t } from '../../extension/core/i18n.js';
import { deviceKind, deviceName } from '../../extension/core/prf.js';
import { SERVED, appRoot, here, missingFiles, smokeTest } from './boot.js';
import { config, quitting, win } from './state.js';
import { diag } from './diag.js';

let passkeySession = null;

function servedFile(rel) {
  const file = path.normalize(path.join(appRoot, rel));
  return SERVED.some((dir) => file.startsWith(path.join(appRoot, dir) + path.sep)) ? file : null;
}

export async function serve(rel) {
  const file = servedFile(rel);
  if (!file) {
    missingFiles.push(rel);
    return new Response('Not found', { status: 404 });
  }
  try {
    return await net.fetch(pathToFileURL(file).toString());
  } catch {
    missingFiles.push(rel);
    return new Response('Not found', { status: 404 });
  }
}

// One reusable window: real authenticators do not care, and the window opens faster the second time.
let passkeyWindow = null;
let ceremony = null; // { id, request, resolve, reject, timer }

function finishCeremony(result) {
  const c = ceremony;
  if (!c) return;
  ceremony = null;
  clearTimeout(c.timer);
  if (passkeyWindow && !passkeyWindow.isDestroyed()) passkeyWindow.hide();
  if (result?.ok) c.resolve(result.result);
  else c.reject(new Error(result?.error || t('Passkey-Vorgang abgebrochen oder abgelaufen')));
}

function ensurePasskeyWindow() {
  if (passkeyWindow && !passkeyWindow.isDestroyed()) return passkeyWindow;
  if (!passkeySession) {
    passkeySession = session.fromPartition('kvpwsafe-passkey');
    passkeySession.protocol.handle('http', (req) => {
      const url = new URL(req.url);
      if (url.host !== 'localhost') return new Response('Not found', { status: 404 });
      return serve(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    });
    passkeySession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  }
  passkeyWindow = new BrowserWindow({
    parent: (!smokeTest && win) || undefined,
    modal: !smokeTest && !!win,
    width: 460,
    height: 330,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    title: t('Passkey'),
    icon: path.join(here, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191d' : '#f5f6f8',
    webPreferences: { session: passkeySession, preload: path.join(here, 'passkey', 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  passkeyWindow.removeMenu();
  passkeyWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    // #532: without a ceremony there was nothing to end, and the window stayed open; it always goes away now.
    if (ceremony) finishCeremony({ ok: false });
    else passkeyWindow.hide();
  });
  // #532: visible only while a ceremony's page has its request (then it has content). Any other show – the system
  // restoring the owner's windows, a show before the page loaded – is undone and logged, so it never stays empty.
  passkeyWindow.on('show', () => {
    if (ceremony?.ready) return;
    passkeyWindow.kvStrayShows = (passkeyWindow.kvStrayShows || 0) + 1; // read by desktop/smoke-passkey-window.js
    diag(`PASSKEY window shown ${ceremony ? `before its page was ready (${ceremony.request.mode})` : 'without a ceremony'} – hidden`);
    passkeyWindow.hide();
  });
  passkeyWindow.webContents.on('did-fail-load', (_e, code, desc, url, mainFrame) => {
    if (!mainFrame || !ceremony || !url.includes(`id=${ceremony.id}`)) return;
    diag(`PASSKEY page failed to load: ${code} ${desc}`);
    finishCeremony({ ok: false, error: t('Das Passkey-Fenster konnte nicht geladen werden ({message})', { message: `${code} ${desc}` }) });
  });
  return passkeyWindow;
}

export function passkeyCeremony(request) {
  if (ceremony) finishCeremony({ ok: false });
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const language = config.get().language === 'auto' ? app.getLocale() : config.get().language;
    // Tests: short WebAuthn timeout, so that a misrouted request can never leave an OS dialog open.
    ceremony = { id, request: { ...request, language, timeoutMs: smokeTest ? 8000 : 120_000 }, resolve, reject };
    if (smokeTest) {
      ceremony.timer = setTimeout(async () => {
        const text = await passkeyWindow?.webContents.executeJavaScript('document.body.innerText').catch((e) => e.message);
        finishCeremony({ ok: false, error: `smoke test: passkey timeout (${String(text).replace(/\s+/g, ' ').trim()})` });
      }, 30_000);
    }
    const w = ensurePasskeyWindow();
    w.setTitle(t('Passkey'));
    diag(`PASSKEY ceremony ${request.mode}`);
    // A page that never asks for its request (not loaded, script failed) ends the ceremony instead of waiting unseen.
    const c = ceremony;
    setTimeout(() => {
      if (ceremony !== c || c.ready) return;
      diag(`PASSKEY page not ready after ${READY_TIMEOUT_MS / 1000} s (${request.mode})`);
      finishCeremony({ ok: false, error: t('Das Passkey-Fenster konnte nicht geladen werden ({message})', { message: 'timeout' }) });
    }, READY_TIMEOUT_MS).unref?.();
    // Query instead of fragment: every ceremony must be a fresh document in the reused window. Shown only when its
    // page fetches the request (passkey:request) – before that it would be an empty window (#532).
    w.loadURL(`http://localhost/desktop/passkey/passkey.html?id=${id}`).catch(() => {});
  });
}

const READY_TIMEOUT_MS = 15_000;

ipcMain.handle('passkey:request', (event, id) => {
  if (event.sender.session !== passkeySession || ceremony?.id !== id) return null;
  ceremony.ready = true;
  if (!smokeTest && passkeyWindow && !passkeyWindow.isDestroyed()) {
    passkeyWindow.show();
    passkeyWindow.focus();
  }
  return ceremony.request;
});

ipcMain.handle('passkey:done', (event, id, result) => {
  if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log(`[smoke] passkey:done sameSession=${event.sender.session === passkeySession} sameId=${ceremony?.id === id} ok=${result?.ok}`);
  if (event.sender.session !== passkeySession || ceremony?.id !== id) return;
  finishCeremony(result);
});

/**
 * attachment: 'platform' (Windows Hello) | 'cross-platform' (security key, phone) | undefined (any).
 * hints: e.g. ['security-key'] to offer the stick first. owner (#531): no label chosen, the name is "<owner> – <what was
 * registered>" (Sicherheitsschlüssel, Windows Hello, Smartphone; "Desktop-App" only when the authenticator says nothing).
 * → { credentialId, rpId, prfSalt, prfOutput, label, device }
 */
export async function registerPasskey(containerName, label, exclude = [], attachment, { hints, owner } = {}) {
  const name = label || owner || t('Passkey');
  const r = await passkeyCeremony({ mode: 'register', containerName, userName: `${name} · ${containerName}`, displayName: name, exclude, attachment, hints, autoStart: !smokeTest });
  const device = deviceKind(r);
  if (!label && owner) return { ...r, device, label: `${owner} – ${deviceName(device) || t('Desktop-App')}` };
  return { ...r, device, label: attachment === 'platform' ? `${name} · Windows Hello` : name };
}
