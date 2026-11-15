// #537 stage 4: who asks for Windows Hello. With the app window visible, the Hello dialog opens over it. With the window
// hidden (tray, a passkey from the browser, the extension's unlock) a small Keevault window comes first and owns the
// dialog: "Keevault: Bestätige mit Windows Hello für <Zweck>" – so the person sees that Keevault asks, and for what.
// It reuses the explanation page (hint.html: finished texts only, no values) and closes as soon as Hello answered.
// Smoke runs: no window on anyone's desktop – the request is only noted (desktop/hello-sim.js).

import { BrowserWindow, nativeTheme, screen } from 'electron';
import path from 'node:path';
import { getLanguage, t } from '../../extension/core/i18n.js';
import { here, smokeTest } from './boot.js';
import { win } from './state.js';
import { noteHelloOwner } from '../hello-sim.js';

const WIDTH = 420;
const HEIGHT = 170;

/** What each proof is for, as the window names it. */
export const HELLO_PURPOSES = Object.freeze({
  unlock: 'Keevault entsperren',
  window: 'das Keevault-Fenster entsperren',
  extension: 'die Browser-Erweiterung entsperren',
  enable: 'das Einschalten von Windows Hello',
  passkey: 'eine Anmeldung mit Passkey',
  copy: 'das Kopieren aus diesem Tresor',
  export: 'den Export',
  admin: 'den Admin-Modus',
  confirm: 'den Zugriff auf einen Eintrag mit „Immer bestätigen“', // #537 2b
  confirmEach: 'das Umschalten von „Immer bestätigen“',
});

/** The texts of the small window (hint.html). */
export function helloOwnerContent(purpose) {
  const what = t(HELLO_PURPOSES[purpose] || HELLO_PURPOSES.unlock);
  return {
    lang: getLanguage(),
    title: t('Keevault: Bestätige mit Windows Hello für {what}', { what }),
    note: t('Windows zeigt gleich den Dialog von Windows Hello. Brich ihn ab, wenn du das nicht selbst angestoßen hast.'),
    close: t('Schließen'),
  };
}

const handleOf = (w) => {
  const handle = w?.getNativeWindowHandle?.();
  if (!handle?.length) return '0';
  return String(handle.length >= 8 ? handle.readBigUInt64LE(0) : handle.readUInt32LE(0));
};

/**
 * The owner of the Hello dialog for one request → { hwnd, done() }. The app window when it is visible; otherwise the
 * small window, shown at once and closed by done().
 */
export async function helloOwner(purpose) {
  const content = helloOwnerContent(purpose);
  const visible = !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  if (smokeTest) {
    noteHelloOwner({ purpose, title: content.title, owner: visible ? 'app' : 'own' });
    return { hwnd: '0', done: () => {} };
  }
  if (visible) {
    win.focus();
    return { hwnd: handleOf(win), done: () => {} };
  }
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const owner = new BrowserWindow({
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.round(area.y + area.height / 4),
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    title: content.title,
    icon: path.join(here, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191d' : '#ffffff',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  owner.removeMenu();
  owner.webContents.on('will-navigate', (e) => e.preventDefault());
  owner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const shown = new Promise((resolve) => {
    owner.once('ready-to-show', () => { owner.show(); owner.focus(); resolve(); });
    setTimeout(resolve, 3000).unref?.();
  });
  owner.loadURL(`app://pwsafe/desktop/renderer/hint.html#${encodeURIComponent(JSON.stringify(content))}`).catch(() => {});
  await shown;
  return { hwnd: handleOf(owner), done: () => { if (!owner.isDestroyed()) owner.close(); } };
}
