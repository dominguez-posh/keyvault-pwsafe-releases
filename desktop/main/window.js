// The main window and the tray icon: creating them, title bar, view settings, start with Windows, links (kvpwsafe://).

import { app, BrowserWindow, nativeTheme, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { t } from '../../extension/core/i18n.js';
import { demo, forcedTheme, here, smokeTest } from './boot.js';
import { config, opened, quitting, setQuitting, setWin, win } from './state.js';
import { lockNow, send } from './session.js';

/**
 * View settings: zoom of the window content and the transparency of the whole window (programs behind it shine through).
 */
export function applyView() {
  if (!win || win.isDestroyed()) return;
  const v = config.get();
  win.webContents.setZoomFactor(Math.min(1.5, Math.max(0.8, Number(v.zoom) || 1)));
  // Colour scheme from the menu (screenshots with --theme keep theirs); the title bar recolours on 'updated'.
  if (!forcedTheme) nativeTheme.themeSource = v.theme === 'light' || v.theme === 'dark' ? v.theme : 'system';
  // Transparency: the whole window becomes see-through, the programs behind it shine through (light 98.5 %, strong 95 %).
  win.setOpacity(v.transparency === 'strong' ? 0.95 : v.transparency === 'light' ? 0.985 : 1);
}

/** Window buttons over the hidden title bar: the ground colour of the app (extension/styles/app.css --bg). */
export function titleBarColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  // While a dialog is open the page lies under a dark veil (rgba(10, 12, 16, .45), app.css .modal::backdrop): the
  // window buttons get the same shade so they do not stand out light against it.
  if (titleBarDimmed) return { color: dark ? '#121317' : '#8b8d90', symbolColor: dark ? '#868889' : '#13151a', height: 52 };
  return { color: dark ? '#18191d' : '#f5f6f8', symbolColor: dark ? '#eceef2' : '#1b1d22', height: 52 };
}
export let titleBarDimmed = false;

/** Windows login item of the installed app (tray only, --background); development and MSIX stay untouched. */
export function applyStartWithWindows() {
  if (!app.isPackaged || process.platform !== 'win32' || process.windowsStore || demo) return;
  app.setLoginItemSettings({ openAtLogin: !!config.get().startWithWindows, args: ['--background'] });
}

export function handleLink(url) {
  if (!/^kvpwsafe:\/\//i.test(url || '')) return;
  // kvpwsafe://open: started by the browser extension through the Windows shell – just be there, no dialog.
  if (/^kvpwsafe:\/\/open\/?$/i.test(url)) return;
  win?.show();
  win?.focus();
  send({ type: 'link', url });
}

export let tray = null;

export function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Icon next to the clock: the app (passkeys via Windows and the browser) keeps running without a window. */
export function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(here, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.setToolTip('Keevault');
  const menu = () => Menu.buildFromTemplate([
    { label: t('Öffnen'), click: showWindow },
    { label: t('Passwort-Generator'), click: () => {
      showWindow();
      send({ type: 'generator' });
    } },
    { label: t('Passwort-Check'), enabled: opened, click: () => {
      showWindow();
      send({ type: 'health' });
    } },
    { label: t('Zugriffsbericht'), enabled: opened, click: () => {
      showWindow();
      send({ type: 'access' });
    } },
    { label: t('Sperren'), enabled: opened, click: () => lockNow() },
    { label: t('Nach Updates suchen …'), click: () => {
      showWindow();
      send({ type: 'checkUpdates' });
    } },
    { type: 'separator' },
    { label: t('Beenden'), click: () => { setQuitting(true); app.quit(); } },
  ]);
  tray.on('click', showWindow);
  tray.on('right-click', () => tray.popUpContextMenu(menu()));
}

export function createWindow() {
  setWin(new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 880,
    minHeight: 560,
    title: 'Keevault',
    icon: path.join(here, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191d' : '#f5f6f8',
    autoHideMenuBar: true,
    show: false,
    // Windows: no title bar – the app's ground colour runs up to the top edge with the logo top left; minimise,
    // maximise and close stay native as an overlay top right (colours follow light/dark).
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: titleBarColors() } : {}),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  }));
  win.removeMenu();
  if (process.platform === 'win32') {
    const recolor = () => { if (win && !win.isDestroyed()) win.setTitleBarOverlay(titleBarColors()); };
    nativeTheme.on('updated', recolor);
    win.once('closed', () => nativeTheme.off('updated', recolor));
  }
  win.loadURL('app://pwsafe/desktop/renderer/index.html');
  win.webContents.on('did-finish-load', applyView);
  win.once('ready-to-show', () => {
    // Started with Windows (setting "Start with Windows"): only in the tray, the window opens on demand.
    if (!smokeTest && !process.argv.includes('--background')) win.show();
  });
  // First start after an update from the update window (windows/Setup): the success animation with the new version.
  if (process.argv.some((x) => x.startsWith('--updated-from='))) {
    win.webContents.once('did-finish-load', () => setTimeout(() => {
      if (win?.isVisible()) send({ type: 'passkeyFlash', text: t('Aktualisiert auf {version}', { version: app.getVersion() }) });
    }, 900));
  }
  // Closing hides the window; the app stays in the notification area until "Beenden".
  win.on('close', (e) => {
    if (quitting || smokeTest || !tray) return;
    e.preventDefault();
    win.hide();
    if (!config.get().trayHintShown) {
      config.update({ trayHintShown: true });
      tray.displayBalloon({ title: 'Keevault', content: t('Läuft im Infobereich weiter – Passkeys funktionieren auch ohne Fenster. Beenden über das Symbol neben der Uhr.') });
    }
  });
  win.on('closed', () => {
    setWin(null);
  });
  const link = process.argv.find((a) => a.startsWith('kvpwsafe://'));
  if (link) win.webContents.once('did-finish-load', () => handleLink(link));
}

/** Every start begins in the normal mode: admin mode is switched on deliberately, with the PIN, each time. */
export function startInNormalMode() {
  if (config.get().adminTools) config.update({ adminTools: false, pimButton: false });
}

// Other modules read these bindings directly and change them through the setters (imports are read-only).
export function setTitleBarDimmed(value) { titleBarDimmed = value; return value; }
