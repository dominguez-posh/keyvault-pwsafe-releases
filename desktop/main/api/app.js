// API: state of the app, settings, PIN and admin mode, unlocking, signing in and out, updates, log.

import { app, dialog, shell, net } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { entraSettings } from '../../auth.js';
import { hashPin, verifyPin, inPinQueue, isShortPin, markShort, MIN_PIN_LENGTH, pinOnlyKeys } from '../../pin.js';
import { warmUpAutoType } from '../../autotype.js';
import { UPDATE_MODES } from '../../updater.js';
import { vaultHost } from '../../../extension/core/keyvault.js';
import { isNetworkError } from '../../offline.js';
import { t } from '../../../extension/core/i18n.js';
import { removeProvider } from '../../windows-provider.js';
import { demo, smokeTest } from '../boot.js';
import { auth, config, files, mcp, opened, setOpened, updater, vault, win } from '../state.js';
import { api } from './index.js';
import { applyBrowserIntegration } from '../browser.js';
import { applyExtensionChannel } from '../extension-channel.js';
import { diag } from '../diag.js';
import { windowLogLine } from '../../../extension/core/log-mask.js';
import { appSigningRefusal } from '../release-gate.js';
import { pinGuard, requireOpen, requirePin } from '../guards.js';
import { otherInstallation } from '../install.js';
import { bindPersonalKeys, pendingRecoveryIds, personalPaths, recentPin, renewedRecoveryIds, setRecentPin, unlockPersonalWithPin } from '../personal.js';
import {
  applyLanguage, changed, forcedLanguage, keptAccount, keptVault, lockNow, mirrorWanted, newSession, offline, offlineMirror, offlineMode, refreshAll,
  setKeptVault, setOfflineMode, signedIn,
} from '../session.js';
import { syncSettings } from '../settings-sync.js';
import { applyShortcuts } from '../typing.js';
import { applyStartWithWindows, applyView, setTitleBarDimmed, titleBarColors, titleBarDimmed } from '../window.js';
import { buildKind } from '../../build-kind.js';
import { setupWindowsProvider } from '../windows-passkeys.js';

export const appApi = {
  async state() {
    const settings = config.get();
    const containers = opened ? await vault.containers() : (await files.containers()).map((c) => ({ ...c, kind: 'file' }));
    const index = opened && signedIn() ? await vault.index() : {};
    const out = [];
    for (const c of containers) {
      let count = index[c.id]?.items.length ?? null;
      if (c.kind === 'file' && !c.locked && !c.error) count = (await files.summaries(c.id)).length;
      // Vault settings decide which functions non-admins see (null: file vault or not readable).
      const policy = opened && c.kind === 'keyvault' && !c.error ? (await vault.policy(c.id).catch(() => null))?.features ?? null : null;
      out.push({ ...c, count, policy, error: c.error || index[c.id]?.error || null });
    }
    return {
      ownApp: entraSettings(settings).ownApp,
      signedIn: signedIn(),
      opened,
      hasFiles: settings.fileContainers.length > 0,
      pinSet: !!settings.appPin,
      pinShort: !!settings.appPin?.short, // #475: set before the 6-character rule; known once it was entered
      offline: offlineMode,
      offlineAt: offlineMode ? offline?.at || null : null,
      signInMode: auth.useBroker?.() ? 'windows' : 'browser',
      requirePin: !!settings.requirePin,
      passkeyPinFixed: !!settings.requirePin,
      account: auth.account ? { name: auth.account.name, username: auth.account.username, tenantId: auth.account.tenantId, id: auth.account.localAccountId || '' } : null,
      containers: out,
      recoveryPending: pendingRecoveryIds(),
      recoveryRenewed: renewedRecoveryIds(),
      settings: forcedLanguage() ? { ...settings, language: forcedLanguage() } : settings,
      version: app.getVersion(),
      build: buildKind(),
      autoUpdates: updater ? updater.mode() === 'auto' : false,
      updateKind: updater?.kind || 'dev',
      passkeyAvailable: process.platform === 'win32' || !!demo,
      smoke: !!smokeTest, // tests: no dialogs that open by themselves
      releaseSigning: !appSigningRefusal(app, { demo, smoke: smokeTest }), // menu entries "Release signieren"
      platform: process.platform,
    };
  },
  updateSettings: async (patch) => {
    const before = config.get();
    // Admin mode is switched on only through activateAdminMode (with the app PIN) – never through a settings patch.
    if (patch?.adminTools === true && before.adminTools !== true) throw new Error(t('Den Admin-Modus aktiviert nur „Admin-Modus aktivieren“ mit deiner PIN.'));
    // #472 (review): the app PIN, its wrong-attempt counter and the personal device keys change only through the PIN functions.
    if (pinOnlyKeys(patch).length) throw new Error(t('Die App-PIN änderst du nur unter „PIN festlegen“ – nicht über die Einstellungen.'));
    const s = config.update(patch);
    applyLanguage();
    if (before.autoTypeKeys !== s.autoTypeKeys) applyShortcuts();
    if (before.startWithWindows !== s.startWithWindows) applyStartWithWindows();
    if (before.zoom !== s.zoom || before.transparency !== s.transparency || before.theme !== s.theme) applyView();
    // #455: the browser extension follows the channel (asks first, UAC; never changes a company policy).
    if (before.updateChannel !== s.updateChannel) applyExtensionChannel({ reason: 'channel' }).catch((e) => dialog.showErrorBox(t('Umstellung fehlgeschlagen'), e.message));
    if (before.updateMode !== s.updateMode || before.updateChannel !== s.updateChannel) {
      if (!UPDATE_MODES.includes(s.updateMode)) config.update({ updateMode: 'off' });
      updater?.applyMode();
      if (config.get().updateMode !== 'off') updater?.background();
    }
    // Passkey provider on demand: installed when turned on, removed again when turned off.
    if (app.isPackaged && !demo && before.windowsProvider !== s.windowsProvider) {
      if (s.windowsProvider) setupWindowsProvider().catch(() => {});
      else removeProvider().catch(() => {});
    }
    if (before.browserIntegration !== s.browserIntegration || before.windowsProvider !== s.windowsProvider
      || JSON.stringify(before.extensionIds) !== JSON.stringify(s.extensionIds) || before.mcpEnabled !== s.mcpEnabled) await applyBrowserIntegration();
    if (before.mcpEnabled && !s.mcpEnabled) mcp?.revoke();
    if (!!before.autoDiscover !== !!s.autoDiscover && opened) {
      // Off: the vaults connected so far stay (as added by hand), only new ones no longer appear by themselves.
      if (!s.autoDiscover) {
        const known = new Set(s.containers.map((c) => vaultHost(c.vaultUrl)));
        const keep = (await vault.containers()).filter((c) => c.kind === 'keyvault' && c.sources?.includes('discovered') && !c.sources.includes('policy') && !known.has(c.id))
          .map((c) => ({ name: c.name, vaultUrl: c.vaultUrl, ...(c.tenantId ? { tenantId: c.tenantId } : {}) }));
        if (keep.length) config.update({ containers: [...s.containers, ...keep] });
      }
      if (signedIn()) refreshAll().then(() => changed()).catch(() => {});
    }
    return config.get();
  },
  /** entra: also sign in to Microsoft Entra ID (Key Vault containers). */
  // #439: one after the other – parallel guesses must not slip past the attempt lock.
  verifyPin: (pin) => inPinQueue(async () => {
    const record = config.get().appPin;
    if (!record) return true;
    const wait = pinGuard.waitSeconds();
    if (wait) throw new Error(t('Zu viele falsche Versuche – bitte {seconds} Sekunden warten', { seconds: wait }));
    if (await verifyPin(pin, record)) {
      pinGuard.success();
      // #475: an old PIN shorter than the minimum still unlocks; remember it so settings and unlock ask to change it.
      const marked = markShort(record, pin);
      if (marked) config.update({ appPin: marked });
      setRecentPin({ pin: String(pin), at: Date.now() });
      // The same PIN opens the personal vault on this device (one PIN for app and vault).
      await unlockPersonalWithPin(String(pin)).catch((e) => diag(`PERSONAL pin unlock failed: ${e.message}`));
      if (config.get().pinGuard) config.update({ pinGuard: null });
      if (mirrorWanted()) await offlineMirror().unlockKey(pin).catch(() => {});
      return true;
    }
    pinGuard.failure();
    config.update({ pinGuard: pinGuard.toJSON() });
    throw new Error(pinGuard.waitSeconds() ? t('Falsche PIN – bitte {seconds} Sekunden warten', { seconds: pinGuard.waitSeconds() }) : t('Falsche PIN'));
  }),
  /** Admin mode on: only with the app PIN (no PIN set → not possible). Returns the settings. */
  async activateAdminMode(pin) {
    requireOpen();
    // Demo (#309): admin mode to try out without a PIN – there is nothing real to protect. The smoke test keeps the PIN.
    if (demo && !smokeTest) {
      config.update({ adminTools: true, pimButton: false, showOthersPrivate: false });
      return config.get();
    }
    if (!config.get().appPin) throw new Error(t('Für den Admin-Modus brauchst du eine App-PIN – lege sie unter Einstellungen fest.'));
    await api.verifyPin(String(pin || ''));
    config.update({ adminTools: true, pimButton: false, showOthersPrivate: false });
    diag('ADMIN mode on');
    return config.get();
  },
  /** Admin mode off: no PIN needed. */
  deactivateAdminMode: async () => {
    config.update({ adminTools: false, pimButton: false, showOthersPrivate: false });
    diag('ADMIN mode off');
    return config.get();
  },
  /** { current?, next } – next null removes the PIN (not when the organization requires one). */
  async setPin({ current, next }) {
    requireOpen();
    const s = config.get();
    if (s.appPin) await api.verifyPin(current);
    pinGuard.consume();
    // #475: checked before the offline mirror is re-keyed, so a refused PIN changes nothing.
    if (next != null && isShortPin(next)) throw new Error(t('Die PIN braucht mindestens {n} Zeichen', { n: MIN_PIN_LENGTH }));
    // A mirror that cannot be re-keyed would stay readable with the old PIN: better none at all.
    if (s.offlineMirror && next) await offlineMirror().rekey(current, next).catch(() => offlineMirror().remove().catch(() => {}));
    if (!next) await offlineMirror().remove().catch(() => {});
    if (next == null) {
      if (s.requirePin) throw new Error(t('Eure Organisation verlangt eine PIN'));
      if (personalPaths().length) throw new Error(t('Der persönliche Tresor braucht eine App-PIN'));
      config.update({ appPin: null });
      return api.state();
    }
    config.update({ appPin: await hashPin(next) });
    // The personal vault key on this device is bound to the PIN: re-bind it to the new one (or drop it while locked –
    // then the master password is asked once).
    setRecentPin({ pin: String(next), at: Date.now() });
    await bindPersonalKeys({ force: true }).catch(() => config.update({ personalDeviceKeys: {} }));
    return api.state();
  },
  /** background: unlocked from the browser extension (PIN) – the window stays where it is. */
  async unlock({ entra = true, background = false } = {}) {
    requirePin();
    if (entra) {
      // With a PIN the silent sign-in from the encrypted token cache is enough; the Microsoft window only
      // appears when the tenant demands it (e.g. expired MFA). An unlock prompt enforced by policy stays.
      const silent = !!config.get().appPin && !config.get().enforced.includes('unlockPrompt');
      const canOffline = mirrorWanted() && offlineMirror().ready && (await offlineMirror().exists());
      if (canOffline && !net.isOnline()) return api.unlockOffline();
      try {
        await auth.unlock(silent ? 'none' : config.get().unlockPrompt);
      } catch (e) {
        if (canOffline && isNetworkError(e)) return api.unlockOffline();
        throw e;
      }
      if (!config.get().entraUsed) config.update({ entraUsed: true });
      if (!background) {
        win?.show();
        win?.focus();
      }
    }
    // Same account and kept data: show the state from memory at once, refresh in the background (concurrent
    // edits in the vault stay safe – every save checks the entry's version and reports a conflict).
    const kept = keptVault && entra && (auth.account?.homeAccountId || null) === keptAccount;
    setKeptVault(false);
    if (!kept) newSession();
    setOpened(true);
    if (!smokeTest && !demo) warmUpAutoType();
    applyShortcuts();
    if (kept) {
      refreshAll({ quick: true }).then(() => { if (opened) changed(); }).catch(() => {});
      changed();
      return api.state();
    }
    const discoverError = await refreshAll({ quick: true });
    changed();
    return { ...(await api.state()), discoverError };
  },
  /** Read-only session from the encrypted mirror (no network): the last state the app has seen. */
  async unlockOffline() {
    const mirror = offlineMirror();
    const info = await mirror.load();
    setOfflineMode(true);
    setKeptVault(false);
    newSession();
    setOpened(true);
    applyShortcuts();
    await vault.refreshContainers({ configured: mirror.containers.map((c) => ({ ...c, source: 'manual' })), discover: false, access: false });
    await vault.refreshIndex().catch(() => {});
    changed();
    return { ...(await api.state()), offlineAt: info.at };
  },
  async signIn() {
    await auth.unlock(config.get().unlockPrompt);
    win?.show();
    win?.focus();
    const discoverError = await refreshAll({ quick: true });
    changed();
    return { ...(await api.state()), discoverError };
  },
  lock: () => lockNow(),
  async signOut() {
    await lockNow();
    // Signing out ends the kept session: another account must never see the previous account's data.
    await vault.clear();
    newSession();
    setKeptVault(false);
    await offlineMirror().remove().catch(() => {});
    await auth.signOut();
  },

  /** Settings ↔ personal vault right now (the first-start wizard waits for the settings of another device). */
  syncSettings: () => syncSettings(),

  /**
   * True for exactly one caller: the first start's wizards open once. Checked and set without waiting in between,
   * because the window may draw twice at the same moment (#399).
   */
  claimFirstStart() {
    if (config.get().setupOffered) return false;
    config.update({ personalOffered: true, setupOffered: true });
    return true;
  },

  /** Renderer: a dialog opened or closed – the window buttons follow the veil behind it. */
  titleBarDim(dim) {
    setTitleBarDimmed(!!dim);
    if (process.platform === 'win32' && win && !win.isDestroyed()) win.setTitleBarOverlay(titleBarColors());
    return true;
  },
  otherInstallation: () => otherInstallation(),
  /** Windows "Installed apps" (to remove a second Keevault installation). */
  openAppsSettings: () => shell.openExternal('ms-settings:appsfeatures'),
  openExternal: (url) => {
    if (!/^https?:\/\//i.test(url)) return;
    // Smoke runs open no browser; they count the calls (#443: one click opens once).
    if (smokeTest) globalThis.kvSmokeOpened = (globalThis.kvSmokeOpened || 0) + 1;
    else shell.openExternal(url);
  },
  updateState: () => updater?.state || null,
  checkForUpdates: () => updater.check(),
  installUpdate: () => updater.installNow(),
  /** Diagnostics log in the profile (no secret values): renderer errors, passkey failures. Rotates at 1 MB. */
  async log({ level = 'error', message = '', detail = '' }) {
    const file = path.join(app.getPath('userData'), 'keevault.log');
    try {
      if ((await fs.stat(file).catch(() => null))?.size > 1_000_000) await fs.rename(file, `${file}.1`);
      await fs.appendFile(file, windowLogLine({ level, message, detail })); // masked: IDs and UPNs never reach the file
    } catch {
      // Logging must never fail the app.
    }
    return true;
  },
};
