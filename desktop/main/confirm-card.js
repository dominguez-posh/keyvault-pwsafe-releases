// A confirmation as a Keevault card instead of the Windows message box (#459): frameless, rounded, light and dark, at the
// top centre over the app window (or the screen). The page is built here (desktop/release-dialog.js, confirmCardHtml), has no
// network and no access to anything but its own answer; only the card's own page can answer, closing and Esc are a "no",
// Enter confirms only after the waiting time and only as a real key press. A card that cannot be shown counts as "no".

import { BrowserWindow, ipcMain, screen } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { here, smokeTest } from './boot.js';
import { confirmCardHtml } from '../release-dialog.js';
import { placeCard } from '../card-placement.js';

/**
 * x/y for a card of this size: top centre over the parent window (a minimised one is restored first; a hidden one is not
 * used), else over the work area of the screen under the cursor; always inside the work area of the matching screen.
 */
export function cardPlacement(width, parent, height = 280) {
  let ref = null;
  if (parent && !parent.isDestroyed()) {
    if (parent.isMinimized()) parent.restore();
    if (parent.isVisible()) ref = parent.getBounds();
  }
  const display = ref ? screen.getDisplayMatching(ref) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  return placeCard({ width, height }, ref || display.workArea, display.workArea);
}

/**
 * Shows a card window whose page reported content and arms its waiting time only while it is shown and has the focus
 * (#459): every focus starts the time over, losing the focus locks the button. A hidden smoke window is armed at once.
 */
export function showCard(window, id) {
  if (window.isDestroyed()) return;
  const wc = window.webContents;
  const arm = (on) => { if (!window.isDestroyed() && !wc.isDestroyed()) wc.send(`release:armed:${id}`, on); };
  if (smokeTest) { arm(true); return; }
  window.on('focus', () => arm(true));
  window.on('blur', () => arm(false));
  window.show();
  window.focus();
  if (window.isFocused()) arm(true);
}

/** card: { title, detail, go, cancel, enter } → Promise<boolean>. `onWindow` (smoke only) receives the card's window. */
export function confirmInCard(card, { parent, delayMs = 1500, loadTimeoutMs = 10_000, onWindow } = {}) {
  const id = randomUUID();
  const nonce = randomBytes(16).toString('base64');
  const [width, height] = [460, 280];
  const window = new BrowserWindow({
    parent: (!smokeTest && parent) || undefined,
    width,
    height,
    ...cardPlacement(width, parent, height),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: !smokeTest,
    show: false,
    title: card.title,
    webPreferences: { preload: path.join(here, 'release-window', 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, additionalArguments: [`--release-dialog=${id}`], partition: `card-${id}` },
  });
  window.removeMenu();
  if (smokeTest) onWindow?.(window);
  const wc = window.webContents;
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  return new Promise((resolve) => {
    const decideChannel = `release:decide:${id}`;
    const readyChannel = `release:ready:${id}`;
    let done = false;
    let timer = null;
    const finish = (yes) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ipcMain.removeListener(decideChannel, onDecide);
      ipcMain.removeListener(readyChannel, onReady);
      if (!window.isDestroyed()) window.destroy();
      resolve(yes === true);
    };
    const onDecide = (event, yes) => { if (event.sender === wc) finish(yes === true); };
    const onReady = (event, filled) => {
      if (event.sender !== wc) return;
      clearTimeout(timer);
      if (filled !== true) return finish(false);
      showCard(window, id);
      return undefined;
    };
    ipcMain.on(decideChannel, onDecide);
    ipcMain.on(readyChannel, onReady);
    window.on('close', (e) => { e.preventDefault(); finish(false); });
    window.on('closed', () => finish(false));
    for (const ev of ['did-fail-load', 'preload-error', 'render-process-gone', 'unresponsive']) wc.on(ev, () => finish(false));
    timer = setTimeout(() => finish(false), loadTimeoutMs);
    wc.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(confirmCardHtml(card, { nonce, delayMs })).toString('base64')}`).catch(() => finish(false));
  });
}
