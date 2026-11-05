// Auto-type: typing values into other windows (helper exe or PowerShell), the global shortcuts and the entry
// selected in the window.

import { globalShortcut, Notification } from 'electron';
import path from 'node:path';
import { statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { typeText } from '../autotype.js';
import { totpCode } from '../../extension/core/totp.js';
import { t } from '../../extension/core/i18n.js';
import { appRoot, smokeTest } from './boot.js';
import { config, opened } from './state.js';
import { deviceLinksHere, serverAccount, usableItem } from './devices.js';
import { diag } from './diag.js';

/** Keevault-Update.exe next to the app (resources) or from the Windows build (development). */
export function helperExe() {
  const candidates = [path.join(process.resourcesPath || '', 'Keevault-Update.exe'), path.join(appRoot, 'windows', 'out', 'Keevault-Update.exe')];
  return candidates.find((p) => { try { return statSync(p).isFile(); } catch { return false; } }) || null;
}

/** Runs the own helper in one mode with the text on stdin (no command line, no window); its exit code, null if missing. */
export function runHelperExe(mode, text) {
  const exe = helperExe();
  if (!exe) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = spawn(exe, [mode], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 4000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.stdin.end(Buffer.from(text, 'utf8'));
  });
}

/**
 * Auto-type through the own helper (stdin, no command line, no window). App Control policies put PowerShell into
 * Constrained Language Mode (no Add-Type) – the PowerShell helper then cannot type at all (2026-11-01).
 * Resolves false only if the helper is missing or cannot start; then the PowerShell helper is tried.
 */
export function typeViaHelperExe(text) {
  const exe = helperExe();
  if (!exe) return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['--type'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    let started = false;
    child.on('spawn', () => { started = true; });
    child.on('error', (e) => (started ? reject(e) : resolve(false)));
    child.on('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(code === 3 ? t('Das Zielfenster nimmt keine Eingaben an (läuft es als Administrator?)') : t('Auto-Type fehlgeschlagen')));
    });
    child.stdin.end(Buffer.from(String(text), 'utf8'));
  });
}

export async function autoTypeText(text) {
  if (process.platform === 'win32' && await typeViaHelperExe(text)) return;
  diag('AUTOTYPE no Keevault-Update.exe – PowerShell helper');
  await typeText(text);
}

export const autoTypeCalls = [];
export let selectedKey = null;

let shortcutsActive = '';

/** Value of the selected entry for auto-type ('u' user name, 'p' password, 'o' one-time code). */
export async function autoTypeValue(key, what) {
  const i = key.indexOf('/');
  let item = await usableItem(key.slice(0, i), key.slice(i + 1));
  // An asset types its connection account (#316): the linked RDP/SSH login (e.g. the AD account), else its own values.
  if (item.type === 'server') item = { ...item, ...(await serverAccount(item, (await deviceLinksHere(key.slice(0, i), item)).rdpLink)) };
  const value = what === 'u' ? item.username : what === 'p' ? item.password : item.totp ? (await totpCode(item.totp))?.code : '';
  if (!value) throw new Error({ u: t('Kein Benutzername hinterlegt'), p: t('Kein Passwort hinterlegt'), o: t('Kein Einmalcode (TOTP) hinterlegt') }[what] || t('Nicht gefunden'));
  return value;
}

function notify(body) {
  if (Notification.isSupported()) new Notification({ title: 'Keevault', body, silent: true }).show();
}

/** Global auto-type: types into whatever window has the focus, for the entry selected in the app. */
export async function globalAutoType(what) {
  try {
    if (!opened) throw new Error(t('Keevault ist gesperrt'));
    if (!selectedKey) throw new Error(t('Zuerst in Keevault einen Eintrag auswählen'));
    const value = await autoTypeValue(selectedKey, what);
    if (smokeTest) {
      autoTypeCalls.push(`global:${what}`);
      return;
    }
    await autoTypeText(value);
  } catch (e) {
    notify(e.message);
  }
}

/** Global shortcuts only while unlocked (a locked app must not take keys away from other programs). */
export function applyShortcuts() {
  const modifier = opened ? config.get().autoTypeKeys : '';
  if (modifier === shortcutsActive) return;
  globalShortcut.unregisterAll();
  shortcutsActive = '';
  if (!modifier) return;
  const failed = [];
  for (const k of ['U', 'P', 'O']) {
    if (!globalShortcut.register(`${modifier}+${k}`, () => globalAutoType(k.toLowerCase()))) failed.push(k);
  }
  shortcutsActive = modifier;
  if (failed.length) notify(t('Tastenkürzel {keys} sind bereits von einem anderen Programm belegt', { keys: failed.map((k) => `${modifier.replace('CommandOrControl', 'Strg').replace('Shift', 'Umschalt')}+${k}`).join(', ') }));
}

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setSelectedKey(value) { selectedKey = value; return value; }
