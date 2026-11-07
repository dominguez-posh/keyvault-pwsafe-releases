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
import { passkeyPin, requireOpen } from './guards.js';
import { effectiveRpId, getAssertion } from '../../extension/core/webauthn.js';
import { copyToClipboard } from './clipboard.js';
import { changed, lockNow, send } from './session.js';
import { extensionOutdated, extensionStatus } from '../versions.js';
import { restoreStoredKeys, withoutPasskeyKeys } from '../passkey-keys.js';
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

export const APP_CAPS = ['passkeySign', 'copy']; // (not the other way round: the key scanner would read the pair as a text)

/** An extension that reports no usable version or an old one gets one hint in the app (the claim is not trusted for
 * anything else; an old extension cannot show a hint itself). Returns whether the hint applies. */
export function noteExtension(client) {
  const outdated = extensionOutdated(client?.extVersion);
  if (outdated && client && !client.hinted) {
    client.hinted = true;
    send({ type: 'extensionOutdated' });
  }
  return outdated;
}

/** Smoke only: a simulated list of bridge clients instead of the real ones (null = real). */
let simulatedClients = null;
export function simulateExtensionClients(list) { simulatedClients = list; }

/** #454: state of the browser extension for the hint at the bottom right. */
export function currentExtensionStatus() {
  const clients = simulatedClients || (bridge ? [...bridge.clients] : []);
  return extensionStatus(clients, app.getVersion());
}

/** #439: an item saved by the browser gets the stored private keys of its passkeys back. */
const withStoredPasskeyKeys = (containerId, item) => restoreStoredKeys(item, () => vault.getItem(containerId, item.id, { fresh: true }));

export const browserHandlers = {
  // Admin tools: the account for a sign-in started in the app (only for the host it was started for, see signInFor).
  signIn: async ({ host, tab }) => (opened ? signInFor(host, tab) : null),
  /** The extension filled the last step: the job is used up – a second sign-in on the page (other admin center, other
   * user) is left alone. */
  signInDone: async ({ host }) => {
    const h = String(host || '').toLowerCase();
    setSignInJobs(signInJobs.filter((j) => !hostIn(h, j.hosts)));
    return true;
  },
  // caps: what this app can do for the extension (feature check instead of a version comparison: it also holds for
  // development and pre-release builds, and an app without the list simply has none of them).
  hello: async (_msg, client) => {
    noteExtension(client);
    send({ type: 'extensionChanged' });
    return { version: app.getVersion(), caps: APP_CAPS, opened, pinSet: !!config.get().appPin, passkeyPin: passkeyPin.state(), containers: await browserContainers() };
  },
  // Everything the extension lists in one answer, straight from the cache (never waits for Azure when there is a
  // cache); outdated vaults are reloaded afterwards and announced with "changed".
  snapshot: async () => {
    const pinSet = !!config.get().appPin;
    if (!opened) return { version: app.getVersion(), opened: false, pinSet, passkeyPin: passkeyPin.state(), containers: [], summaries: [] };
    const summaries = await vault.summaries({ maxAgeMs: Infinity });
    refreshStaleForBrowser().catch(() => {});
    // Native messaging allows 1 MB per message: big lists go in pages (summariesPage).
    const out = { version: app.getVersion(), opened: true, pinSet, passkeyPin: passkeyPin.state(), containers: await browserContainers(), summaries: summaries.slice(0, SNAPSHOT_PAGE) };
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
  // #439: no private passkey key goes to the browser; save puts the stored ones back.
  item: async ({ containerId, itemId }) => {
    requireOpen();
    return withoutPasskeyKeys(await vault.getItem(containerId, itemId, { fresh: true }));
  },
  // Changes from the browser show up in the app (and other browsers) at once.
  save: async ({ containerId, item, expectedVersion }) => {
    requireOpen();
    const saved = await vault.saveItem(containerId, await withStoredPasskeyKeys(containerId, item), { expectedVersion });
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
  // #439: no key material in the list – signing is passkeySign, which asks for the PIN (an extension before 0.9.29 can no longer sign here).
  passkeyCandidates: async ({ rpId }) => (opened ? (await vault.passkeyCandidates(rpId)).map((c) => ({ ...c, passkey: { ...c.passkey, privateKey: '' } })) : []),
  /**
   * #439: the assertion for one sign-in. The PIN typed in the extension's own window (never in a web page) is checked here,
   * for this one use; wrong, missing or no PIN set: nothing is signed. The extension gets the signed answer, not a key.
   */
  passkeySign: async ({ containerId, itemId, credentialId, origin, rpId, challenge, pin }) => {
    requireOpen();
    await passkeyPin.check(typeof pin === 'string' ? pin : '');
    const rp = effectiveRpId(String(origin || ''), rpId);
    const candidate = (await vault.passkeyCandidates(rp))
      .find((c) => c.containerId === containerId && c.itemId === itemId && c.passkey.credentialId === credentialId);
    if (!candidate) throw new Error(t('Passkey nicht gefunden'));
    const { response, signCount } = await getAssertion({ origin: String(origin), rpId: rp, challenge, passkey: candidate.passkey });
    if (signCount > 0) {
      const item = await vault.getItem(containerId, itemId, { fresh: true });
      await vault.saveItem(containerId, { ...item, passkeys: item.passkeys.map((k) => (k.credentialId === credentialId ? { ...k, signCount } : k)) }).catch(() => {});
    }
    return { response };
  },
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
