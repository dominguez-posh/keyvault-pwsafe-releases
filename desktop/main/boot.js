// First thing in the process: command-line switches (--smoke-test, --demo, --screenshot, --theme), the profile
// folder, the single-instance lock and Chromium switches. Runs while the module graph loads, before anything else.

import { app, BrowserWindow, protocol, nativeTheme } from 'electron';
import path from 'node:path';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { purgeDiskCaches } from '../secure-net.js';
import { createDemoBackend } from '../../extension/core/demo.js';
import { keepWindowsHidden } from './smoke-windows.js';
import { startSmokeGuard } from './smoke-guard.js';

export const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const appRoot = path.join(here, '..');
// Folders the renderer (app://pwsafe/…) and the passkey window (http://localhost/…) may load.
export const SERVED = ['desktop/renderer', 'desktop/assets', 'desktop/passkey', 'extension/core', 'extension/styles'];
export const RP_ID = 'localhost';
export const missingFiles = [];
export const smokeTest = process.argv.includes('--smoke-test');
// Smoke runs are headless: an uncaught error must end the run, not open Electron's error dialog on the desktop
// (Electron only shows it when nobody else listens).
if (smokeTest) process.on('uncaughtException', (e) => { console.error(`SMOKE FAIL (main process): ${e?.stack || e}`); process.exit(1); });
export const smokeGuard = smokeTest ? startSmokeGuard({ exit: (code) => app.exit(code) }) : null;
if (smokeTest && !app.isPackaged) keepWindowsHidden({ BrowserWindow, app });
export const screenshot = process.argv.find((a) => a.startsWith('--screenshot='))?.slice('--screenshot='.length);
// --theme=dark|light: screenshots in a fixed colour scheme (otherwise Windows' app mode decides).
export const forcedTheme = process.argv.find((a) => a.startsWith('--theme='))?.slice('--theme='.length);
if (forcedTheme === 'dark' || forcedTheme === 'light') nativeTheme.themeSource = forcedTheme;
export const demo = process.argv.includes('--demo') ? createDemoBackend() : null;

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// The product was renamed to Keevault; the profile (settings, encrypted token cache, PIN) stays in the folder of the
// old product name so that updates keep it.
// Native dialogs and windows without a title show the app name (the package name "keyvault-pwsafe" in development runs):
// shown name Keevault, the profile folder stays where it is.
const profileDir = app.getPath('userData');
app.setName('Keevault');
app.setPath('userData', profileDir);
if (app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'KeyVault PwSafe'));
// Development runs get their own pipe (bridge.js pipePath) and never register themselves as the browser's native
// host or the Windows passkey command – the installed app keeps both (KVPWSAFE_DEV_INTEGRATION=1 to test them).
export const devIsolated = !app.isPackaged && !process.env.KVPWSAFE_DEV_INTEGRATION;
if (!app.isPackaged) process.env.KVPWSAFE_DEV_PIPE = '1';

if (demo) {
  // Separate profile so that the demo never touches real settings, tokens or files.
  app.setPath('userData', path.join(app.getPath('temp'), `kvpwsafe-demo-${process.pid}`));
  // Smoke runs start empty: Windows reuses process IDs, and files of an earlier run ("file exists") broke the flows.
  if (smokeTest) rmSync(app.getPath('userData'), { recursive: true, force: true });
  process.env.KVPWSAFE_TENANT_ID = 'demo';
  process.env.KVPWSAFE_CLIENT_ID = 'demo';
}

const primaryInstance = smokeTest || app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
// Tests use virtual authenticators only: never route WebAuthn to the Windows API (no OS dialogs during tests).
if (smokeTest) app.commandLine.appendSwitch('disable-features', 'WebAuthenticationUseNativeWinApi');
// No HTTP cache on disk at all (the app only loads its own files); Azure traffic runs in memory (secure-net.js).
app.commandLine.appendSwitch('disable-http-cache');
// No crash dumps: a dump of this process could contain decrypted entries. Chromium's crash reporter stays off, old
// dumps go at start (purgeCrashDumps), and Windows Error Reporting excludes the app (excludeFromErrorReporting).
app.commandLine.appendSwitch('disable-crash-reporter');
if (primaryInstance) purgeDiskCaches();
