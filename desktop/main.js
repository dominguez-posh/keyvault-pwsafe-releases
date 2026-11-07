// Keevault desktop app (Electron main process). All network and file access and all keys stay here;
// the sandboxed renderer only calls the API (main/api/) through the preload bridge.
//
// This file is only the start-up: what happens when the app is ready and how it reacts to the app's own events.
// Everything else lives in desktop/main/ – one module per subject, see docs/ARCHITEKTUR.md ("Code-Struktur").

import { app, powerMonitor, protocol, nativeTheme, session, globalShortcut } from 'electron';
import path from 'node:path';
import { Auth } from './auth.js';
import { Config } from './config.js';
import { FileContainers } from './files.js';
import { stopAutoType } from './autotype.js';
import { Updater } from './updater.js';
import { secureFetch } from './secure-net.js';
import { McpService } from './mcp.js';
import { normalizeFolder } from '../extension/core/model.js';
import { WindowsProvider } from './windows-provider.js';
import { demo, smokeTest } from './main/boot.js';
import {
  auth, bridge, config, files, mcp, opened, quitting, setAuth, setConfig, setFiles, setMcp, setQuitting, setUpdater, setWindows, updater, vault, win,
  windows,
} from './main/state.js';
import {
  agentAdmitted, auditAgent, chooseAgentMicrosoft, confirmAgentPasskey, confirmAgentRead, confirmAgentWrite, mcpTrusted, trustAgentEntry, waitForUnlock,
} from './main/agents.js';
import { applyBrowserIntegration } from './main/browser.js';
import { excludeFromErrorReporting } from './main/clipboard.js';
import { passkeyPin, pinGuard } from './main/guards.js';
import { serve } from './main/passkey-window.js';
import { fileLocations, personalPaths, rebindPersonalKey, refreshFileLocations } from './main/personal.js';
import { DemoAuth, actor, applyLanguage, changed, lockIfWindowsLocked, lockNow, newSession, offlineMode, send } from './main/session.js';
import { scheduleSettingsSync } from './main/settings-sync.js';
import { runSmokeTest } from './main/smoke.js';
import { applyStartWithWindows, createTray, createWindow, handleLink, showWindow, startInNormalMode, tray } from './main/window.js';
import { restoreAfterWindowsRequest, setWindowStateBeforeRequest, setupWindowsProvider, windowStateBeforeRequest } from './main/windows-passkeys.js';

// Loaded for what they register (ipc handlers) – nothing here calls them by name.
import './main/api/index.js';
import './main/passkey-window.js';

app.on('before-quit', () => {
  setQuitting(true);
  stopAutoType();
  globalShortcut.unregisterAll();
});

app.on('second-instance', (_event, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  handleLink(argv.find((a) => a.startsWith('kvpwsafe://')));
});
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleLink(url);
});

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (e) => e.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(async () => {
  setConfig(new Config());
  config.onSyncChange = () => scheduleSettingsSync();
  startInNormalMode();
  pinGuard.restore(config.get().pinGuard);
  applyLanguage();
  setAuth(demo ? new DemoAuth() : new Auth({
    cachePath: path.join(app.getPath('userData'), 'msal-cache.bin'),
    getConfig: () => config.get(),
    getWindowHandle: () => {
      // The Windows sign-in dialog needs a visible parent window.
      if (!win) createWindow();
      if (!win.isVisible()) win.show();
      return win.getNativeWindowHandle();
    },
  }));
  setFiles(new FileContainers({
    personalPaths,
    locations: fileLocations,
    paths: () => config.get().fileContainers,
    // A file vault taken out of the app is no longer a personal vault either (its device key goes with it).
    setPaths: (paths) => config.update({
      fileContainers: paths,
      personalVaults: personalPaths().filter((p) => paths.includes(p)),
      personalDeviceKeys: Object.fromEntries(Object.entries(config.get().personalDeviceKeys || {}).filter(([p]) => paths.includes(p))),
    }),
    pins: () => config.get().fileIds,
    setPins: (fileIds) => config.update({ fileIds }),
    pinNotes: () => config.get().fileIdNotes,
    setPinNotes: (fileIdNotes) => config.update({ fileIdNotes }),
    onChange: () => changed(),
    onRekey: (entry) => rebindPersonalKey(entry),
  }));
  await files.load();
  refreshFileLocations().catch(() => {});
  setInterval(() => refreshFileLocations().then((changedAny) => { if (changedAny) changed(); }).catch(() => {}), 60_000).unref?.();
  newSession();
  setWindows(new WindowsProvider({
    vault: () => vault,
    isOpen: () => opened,
    actor,
    pin: passkeyPin, // #439: every passkey use asks for the app PIN
    show: () => {
      if (!win) return;
      // Remember how the window was before the passkey request, to restore that afterwards.
      if (windowStateBeforeRequest == null) setWindowStateBeforeRequest(!win.isVisible() ? 'hidden' : win.isMinimized() ? 'minimized' : 'shown');
      if (win.isMinimized()) win.restore();
      win.show();
      win.setAlwaysOnTop(true);
      win.focus();
    },
    notify: () => {
      send({ type: 'windows-request' });
      if (!windows?.pending.size) restoreAfterWindowsRequest();
    },
  }));
  if (app.isPackaged) app.setAsDefaultProtocolClient('kvpwsafe');
  applyBrowserIntegration().catch(() => {});
  if (app.isPackaged && !demo && !smokeTest) setupWindowsProvider().catch(() => {});

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'pwsafe') return new Response('Not found', { status: 404 });
    return serve(decodeURIComponent(url.pathname).replace(/^\/+/, ''));
  });

  // Auto-lock after system-wide inactivity, on screen lock and on suspend. Not in the smoke test: it runs unattended,
  // and an idle or locked PC must not lock the app halfway through the checks.
  setInterval(() => {
    const minutes = Number(config.get().autoLockMinutes) || 0;
    if (opened && !smokeTest && minutes > 0 && powerMonitor.getSystemIdleTime() >= minutes * 60) lockNow();
  }, 30_000);
  // Windows locked (#28): the "lock-screen" event does not always arrive (e.g. only in the tray, some session
  // changes) – the idle state "locked" catches it within a few seconds, so unlocking needs the PIN again.
  setInterval(() => { if (!smokeTest) lockIfWindowsLocked(); }, 3_000).unref?.();
  // Pending index writes (debounced) go out before the app quits.
  let flushedBeforeQuit = false;
  app.on('before-quit', (e) => {
    if (flushedBeforeQuit || !opened || offlineMode || demo) return;
    e.preventDefault();
    flushedBeforeQuit = true;
    vault.flushFastIndex().catch(() => {}).finally(() => app.quit());
  });
  powerMonitor.on('lock-screen', () => { if (!smokeTest) lockNow(); });
  powerMonitor.on('suspend', () => { if (!smokeTest) lockNow(); });

  createWindow();
  if (!smokeTest) createTray();
  setMcp(new McpService({
    vault: () => (opened ? vault : null),
    confirmRead: confirmAgentRead,
    confirmWrite: confirmAgentWrite,
    admitted: agentAdmitted,
    policy: (agent) => config.get().agentRules?.[agent] || { write: false },
    trusted: (agent, vaultId, entryId) => mcpTrusted().some((x) => x.agent === agent && x.vaultId === vaultId && x.entryId === entryId),
    trust: trustAgentEntry,
    waitUnlock: () => waitForUnlock(),
    // Off unless turned on in Settings → AI agents (#308, #315).
    features: () => ({ passkeys: !!config.get().mcpPasskeys, microsoft: !!config.get().mcpMicrosoft }),
    confirmPasskey: confirmAgentPasskey,
    chooseMicrosoft: chooseAgentMicrosoft,
    scope: () => {
      const s = config.get();
      const scopes = (Array.isArray(s.mcpScopes) ? s.mcpScopes : []).filter((x) => x && typeof x.vaultId === 'string')
        .map((x) => ({ vaultId: x.vaultId, folder: normalizeFolder(x.folder || '') }));
      return { all: s.mcpScope === 'all', scopes };
    },
    audit: auditAgent,
  }));
  setUpdater(new Updater({
    mode: () => (smokeTest ? 'off' : config.get().updateMode),
    channel: () => (config.get().updateChannel === 'beta' ? 'beta' : 'stable'),
    selfUpdate: () => config.get().selfUpdate !== false,
    onState: (state) => send({ type: 'update', state }),
    // New version at start (mode "ask"): the renderer shows the update dialog with the release notes.
    offer: (state) => {
      if (smokeTest) return;
      showWindow();
      send({ type: 'updateOffer', state });
    },
    // Nobody working in the app: locked, or only in the tray.
    isIdle: () => !opened || !win?.isVisible(),
    beforeInstall: () => { setQuitting(true); },
    // The update window appears centered on the app window (DIP, like WPF).
    windowCenter: () => {
      if (!win || win.isDestroyed() || !win.isVisible()) return null;
      const b = win.getBounds();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    },
    theme: () => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    fetch: secureFetch,
  }));
  updater.start();
  applyStartWithWindows();
  excludeFromErrorReporting();
  if (smokeTest) runSmokeTest();
});

app.on('window-all-closed', () => {
  // With the tray icon the app keeps running; without (tests) it ends with its window.
  if (tray && !quitting) return;
  files?.close();
  bridge?.stop();
  app.quit();
});
