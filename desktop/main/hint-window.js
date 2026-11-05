// Explanation window (#338): when Keevault cannot sign in by itself – Windows' credential dialog ("Windows-Sicherheit")
// takes no typed input, and Credential Guard forbids handing saved credentials to remote desktop – a small window says
// why and what to do. It stays on top without taking the focus from Windows' dialog (the user pastes there next).
// The window gets finished texts only (no values, no secrets); it closes itself after a few minutes.

import { BrowserWindow, nativeTheme, screen } from 'electron';
import path from 'node:path';
import { getLanguage, t } from '../../extension/core/i18n.js';
import { here, smokeTest } from './boot.js';
import { config } from './state.js';

const WIDTH = 440;
const HEIGHT = 470;
const OPEN_MS = 5 * 60_000;

let hintWindow = null;
let closeTimer = null;
/** Smoke runs: the hints that would have been shown (no window on the desktop of whoever runs them). */
export const hintsShown = [];

const LABELS = { u: 'Benutzername', p: 'Passwort', o: 'Einmalcode' };

/**
 * Texts of the window. kind 'rdp': remote desktop started under Credential Guard (password copied, user name in the
 * dialog); kind 'secure': auto-type (Ctrl+Shift+U/P/O) into Windows' credential dialog, the value copied.
 */
export function hintContent({ kind, what = 'p', user = '' }) {
  const seconds = Number(config.get().clipboardSeconds) || 0;
  const label = t(LABELS[what] || LABELS.p);
  const note = seconds > 0
    ? t('Der Wert erscheint nicht im Zwischenablage-Verlauf und nicht in der Cloud-Zwischenablage. Nach {seconds} Sekunden löscht Keevault ihn wieder – danach einfach noch einmal anfordern.', { seconds })
    : t('Der Wert erscheint nicht im Zwischenablage-Verlauf und nicht in der Cloud-Zwischenablage.');
  const common = { lang: getLanguage(), whyTitle: t('Warum nicht automatisch?'), stepsTitle: t('So meldest du dich an'), note, close: t('Verstanden') };
  if (kind === 'rdp') {
    return {
      ...common,
      title: t('Remotedesktop: Passwort mit Strg+V einfügen'),
      why: t('Auf diesem PC ist Credential Guard aktiv. Damit verbietet Windows, gespeicherte Anmeldedaten an Remotedesktop zu übergeben. In seinen Anmeldedialog „Windows-Sicherheit“ lässt Windows außerdem bewusst kein Programm tippen – auch keine Schadsoftware. Keevault kann das Passwort dort deshalb nicht selbst eintragen.'),
      steps: [
        user ? t('Im Fenster „Windows-Sicherheit“ prüfen, dass das Konto {user} gewählt ist.', { user }) : t('Im Fenster „Windows-Sicherheit“ das Konto eintragen bzw. auswählen.'),
        t('Ins Feld „Kennwort“ klicken.'),
        t('Strg+V drücken – Keevault hat das Passwort schon in die Zwischenablage gelegt.'),
        t('Mit „OK“ bestätigen.'),
      ],
    };
  }
  return {
    ...common,
    title: t('{label} mit Strg+V einfügen', { label }),
    why: t('Das Fenster vorne ist der Windows-Anmeldedialog „Windows-Sicherheit“. Dort lässt Windows bewusst kein Programm tippen – auch keine Schadsoftware. Keevault kann den Wert deshalb nicht selbst eintippen.'),
    steps: [
      t('Im Dialog in das passende Feld klicken.'),
      t('Strg+V drücken – Keevault hat den Wert ({label}) schon in die Zwischenablage gelegt.', { label }),
      t('Mit „OK“ bestätigen.'),
    ],
  };
}

/** Shows (or replaces) the explanation window at the top right of the screen the mouse is on – without the focus. */
export function showHint(opts) {
  const content = hintContent(opts);
  if (smokeTest) {
    hintsShown.push({ ...opts, content });
    return;
  }
  if (hintWindow && !hintWindow.isDestroyed()) hintWindow.destroy();
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  hintWindow = new BrowserWindow({
    x: area.x + area.width - WIDTH - 16,
    y: area.y + 16,
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    show: false,
    title: content.title,
    icon: path.join(here, 'assets', 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#18191d' : '#ffffff',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  hintWindow.removeMenu();
  // Only its own page: no navigation, no new windows.
  hintWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  hintWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // As tall as its text (longer in English, a long account name): measured before it is shown, at most the screen.
  hintWindow.once('ready-to-show', async () => {
    const w = hintWindow;
    if (!w || w.isDestroyed()) return;
    const height = await w.webContents.executeJavaScript('document.documentElement.scrollHeight').catch(() => HEIGHT);
    if (w.isDestroyed()) return;
    w.setContentSize(WIDTH, Math.min(Math.ceil(Number(height) || HEIGHT), area.height - 32));
    w.showInactive();
  });
  hintWindow.on('closed', () => { hintWindow = null; clearTimeout(closeTimer); });
  hintWindow.loadURL(`app://pwsafe/desktop/renderer/hint.html#${encodeURIComponent(JSON.stringify(content))}`);
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => { if (hintWindow && !hintWindow.isDestroyed()) hintWindow.close(); }, OPEN_MS);
  closeTimer.unref?.();
}
