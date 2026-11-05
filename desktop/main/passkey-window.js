// Hidden window on http://localhost for WebAuthn with PRF (passkeys that unlock vaults), and serving the app's
// own files to both windows.

import { app, BrowserWindow, ipcMain, net, nativeTheme, session } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { t } from '../../extension/core/i18n.js';
import { SERVED, appRoot, here, missingFiles, smokeTest } from './boot.js';
import { config, quitting, win } from './state.js';

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
    finishCeremony({ ok: false });
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
    // Query instead of fragment: every ceremony must be a fresh document in the reused window.
    w.loadURL(`http://localhost/desktop/passkey/passkey.html?id=${id}`);
    if (!smokeTest) {
      w.show();
      w.focus();
    }
  });
}

ipcMain.handle('passkey:request', (event, id) => {
  if (event.sender.session !== passkeySession || ceremony?.id !== id) return null;
  return ceremony.request;
});

ipcMain.handle('passkey:done', (event, id, result) => {
  if (process.env.KVPWSAFE_SMOKE_DEBUG) console.log(`[smoke] passkey:done sameSession=${event.sender.session === passkeySession} sameId=${ceremony?.id === id} ok=${result?.ok}`);
  if (event.sender.session !== passkeySession || ceremony?.id !== id) return;
  finishCeremony(result);
});

/** attachment: 'platform' (Windows Hello) | 'cross-platform' (security key, phone) | undefined (any) */
export async function registerPasskey(containerName, label, exclude = [], attachment) {
  const r = await passkeyCeremony({ mode: 'register', containerName, userName: `${label} · ${containerName}`, displayName: label, exclude, attachment, autoStart: !smokeTest });
  return { ...r, label: attachment === 'platform' ? `${label} · Windows Hello` : label };
}
