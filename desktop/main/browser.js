// Browser extension through the desktop app: approval of a browser, the commands it may call, native messaging host.

import { app, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { BrowserBridge, launchPath, pipePath, registerNativeHost, unregisterNativeHost } from '../bridge.js';
import { mcpHostScript } from '../mcp.js';
import { itemMatchesHost } from '../../extension/core/match.js';
import { t } from '../../extension/core/i18n.js';
import { ORIGIN as WINDOWS_ORIGIN, rememberDesktopCommand } from '../windows-provider.js';
import { appRoot, demo, devIsolated } from './boot.js';
import { bridge, config, opened, setBridge, vault, win } from './state.js';
import { approveAgent, mcpHandlers, mcpScriptPath } from './agents.js';
import { api } from './api/index.js';
import { requireOpen } from './guards.js';
import { copyToClipboard } from './clipboard.js';
import { changed, lockNow } from './session.js';
import { hostIn, setSignInJobs, signInFor, signInJobs } from './signin.js';
import { windowsHandlers } from './windows-passkeys.js';

async function approveBrowser(origin) {
  const s = config.get();
  if (origin.startsWith('mcp:')) return approveAgent(origin.slice(4));
  // The Windows provider only relays requests signed by Windows; every operation is confirmed in the app.
  if (origin === WINDOWS_ORIGIN) return !!s.windowsProvider;
  if (s.approvedBrowsers.includes(origin)) return true;
  if (!win) return false;
  win.show();
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: [t('Erlauben'), t('Ablehnen')],
    defaultId: 0,
    cancelId: 1,
    message: t('Die Browser-Erweiterung möchte auf deine Datei-Tresore zugreifen.'),
    detail: t('{origin}\n\nErlaube das nur, wenn du die Erweiterung Keevault gerade nutzt.', { origin }),
  });
  if (r.response !== 0) return false;
  config.update({ approvedBrowsers: [...s.approvedBrowsers, origin] });
  return true;
}

// The extension works through the desktop app for every container (Key Vault and file): sign-in, tenants and
// keys stay here, the extension needs no configuration of its own.
const forBrowser = (c) => ({
  id: c.id, name: c.name, source: c.kind, sources: ['file'], locked: !!c.locked, protected: !!c.protected,
  error: c.error ? { status: c.error.status || 0, message: c.error.message } : null, access: c.access || null,
});
const browserContainers = async () => (opened ? (await vault.containers()).map(forBrowser) : []);

const INDEX_MAX_AGE = 5 * 60_000;
const SNAPSHOT_PAGE = 500;
let staleRefresh = null;

/** Vaults loaded longer ago than INDEX_MAX_AGE: reload them in the background and report the change. */
export async function refreshStaleForBrowser() {
  if (staleRefresh || !opened) return;
  const index = await vault.index();
  if (!Object.values(index).some((e) => Date.now() - (e.loadedAt || 0) > INDEX_MAX_AGE)) return;
  staleRefresh = vault.summaries({ maxAgeMs: INDEX_MAX_AGE }).then(changed, () => {}).finally(() => { staleRefresh = null; });
}

export const browserHandlers = {
  // Admin tools: the account for a sign-in started in the app (only for the host it was started for, see signInFor).
  signIn: async ({ host }) => (opened ? signInFor(host) : null),
  /** The extension filled the last step: the job is used up – a second sign-in on the page (other admin center, other
   * user) is left alone. */
  signInDone: async ({ host }) => {
    const h = String(host || '').toLowerCase();
    setSignInJobs(signInJobs.filter((j) => !hostIn(h, j.hosts)));
    return true;
  },
  hello: async () => ({ version: app.getVersion(), opened, pinSet: !!config.get().appPin, containers: await browserContainers() }),
  // Everything the extension lists in one answer, straight from the cache (never waits for Azure when there is a
  // cache); outdated vaults are reloaded afterwards and announced with "changed".
  snapshot: async () => {
    const pinSet = !!config.get().appPin;
    if (!opened) return { version: app.getVersion(), opened: false, pinSet, containers: [], summaries: [] };
    const summaries = await vault.summaries({ maxAgeMs: Infinity });
    refreshStaleForBrowser().catch(() => {});
    // Native messaging allows 1 MB per message: big lists go in pages (summariesPage).
    const out = { version: app.getVersion(), opened: true, pinSet, containers: await browserContainers(), summaries: summaries.slice(0, SNAPSHOT_PAGE) };
    if (summaries.length > SNAPSHOT_PAGE) out.more = { total: summaries.length, pageSize: SNAPSHOT_PAGE };
    return out;
  },
  summariesPage: async ({ page, pageSize }) => {
    requireOpen();
    const size = Math.min(Number(pageSize) || SNAPSHOT_PAGE, SNAPSHOT_PAGE);
    const all = await vault.summaries({ maxAgeMs: Infinity });
    return all.slice(Number(page) * size, (Number(page) + 1) * size);
  },
  // Unlock from the browser with the app PIN: silent sign-in, no window (only once a PIN is set – without one
  // the app window stays the place to unlock, so nothing on the machine can open the vault without a secret).
  unlockPin: async ({ pin }) => {
    if (opened) return true;
    if (!config.get().appPin) throw new Error(t('Ohne PIN bitte in der Desktop-App entsperren'));
    await api.verifyPin(String(pin || ''));
    await api.unlock({ entra: true, background: true });
    return true;
  },
  containers: () => browserContainers(),
  // Copies for the extension (#337): the browser's clipboard has no way to keep a value out of Windows' clipboard
  // history and cloud clipboard – the app's has, and clears it again after the configured time.
  copy: async ({ text }) => {
    requireOpen();
    if (typeof text !== 'string' || !text || text.length > 100_000) throw new Error(t('Nichts zu kopieren'));
    await copyToClipboard(text);
    return true;
  },
  summaries: async () => (opened ? vault.summaries() : []),
  refresh: async () => {
    requireOpen();
    await vault.summaries({ maxAgeMs: 0 });
    changed();
    return true;
  },
  // itemId – "id" is the request number of the bridge protocol.
  item: ({ containerId, itemId }) => {
    requireOpen();
    return vault.getItem(containerId, itemId, { fresh: true });
  },
  // Changes from the browser show up in the app (and other browsers) at once.
  save: async ({ containerId, item, expectedVersion }) => {
    requireOpen();
    const saved = await vault.saveItem(containerId, item, { expectedVersion });
    changed();
    return saved;
  },
  delete: async ({ containerId, itemId }) => {
    requireOpen();
    const result = await vault.deleteItem(containerId, itemId);
    changed();
    return result;
  },
  lock: async () => {
    await lockNow();
    return true;
  },
  passkeyCandidates: async ({ rpId }) => (opened ? vault.passkeyCandidates(rpId) : []),
  matches: async ({ host }) => (opened ? (await vault.summaries()).filter((s) => s.type === 'login' && itemMatchesHost(s.hosts, host)) : []),
  focus: async () => {
    if (win?.isMinimized()) win.restore();
    win?.show();
    win?.focus();
    return true;
  },
};

// Browsers and the Windows provider share the pipe but get separate command sets.
const bridgeHandlers = new Proxy({}, {
  get: (_target, cmd) => (msg, client) => {
    const set = client?.origin === WINDOWS_ORIGIN ? windowsHandlers : client?.origin?.startsWith('mcp:') ? mcpHandlers : browserHandlers;
    if (!Object.hasOwn(set, cmd)) throw new Error(`Unknown command ${String(cmd)}`);
    return set[cmd](msg, client);
  },
});

export async function applyBrowserIntegration() {
  const s = config.get();
  if (!demo && !devIsolated) {
    if (s.browserIntegration) {
      // Installed app on Windows: started through the shell (kvpwsafe:// link) instead of as a child of the
      // browser's native-messaging host – endpoint protection (e.g. Sophos "Lockdown") blocks programs started
      // from the browser's process chain. MSIX and development keep the direct start.
      const viaShell = app.isPackaged && process.platform === 'win32' && !process.windowsStore;
      const launch = viaShell
        ? { cmd: path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), args: ['kvpwsafe://open'] }
        : { cmd: launchPath(), args: app.isPackaged ? [] : [appRoot] };
      await registerNativeHost({ userData: app.getPath('userData'), extensionIds: s.extensionIds, launch });
    } else await unregisterNativeHost();
    if (s.windowsProvider) await rememberDesktopCommand(launchPath(), app.isPackaged ? '' : `"${appRoot}"`).catch(() => {});
  }
  if (s.mcpEnabled && !demo) {
    await fs.mkdir(path.dirname(mcpScriptPath()), { recursive: true });
    await fs.writeFile(mcpScriptPath(), mcpHostScript(pipePath(app.getPath('userData')), app.getVersion()));
  }
  if ((s.browserIntegration || s.windowsProvider || s.mcpEnabled) && !demo) {
    if (!bridge) {
      setBridge(new BrowserBridge({ userData: app.getPath('userData'), handlers: bridgeHandlers, approve: approveBrowser }));
      await bridge.start();
    }
  } else {
    bridge?.stop();
    setBridge(null);
  }
}
