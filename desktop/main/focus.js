// #468: bring a window to the front so that the field in it can be typed into at once (PIN questions). No Electron import,
// so that it can be tested with a stand-in window.

/**
 * Window to the front, then the keyboard to its web page. Windows' focus lock can refuse the foreground to a program that
 * is not in front: then the taskbar button flashes instead (Windows stops it when the window gets the focus).
 * The field inside is focused by the page itself (see `focusField` in the window code); this never presses a button.
 */
export function bringToFront(w, { wait = 150, later = setTimeout } = {}) {
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.moveTop();
  w.focus();
  w.webContents.focus();
  later(() => {
    if (!w.isDestroyed() && !w.isFocused()) w.flashFrame(true);
  }, wait);
}
