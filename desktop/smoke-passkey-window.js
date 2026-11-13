// Smoke check of #532: the passkey window is never visible without content. A show without a ready ceremony (the system
// restoring the owner's windows, a show before the page loaded) is undone at once and counted, and closing it without a
// ceremony hides it instead of leaving it open. Runs without a visible window: the events are emitted, never shown.
// The window is the one with the run's virtual authenticator (desktop/main/smoke.js), there after the passkey checks.

import { BrowserWindow, webContents } from 'electron';

export async function passkeyWindowCheck({ fail }) {
  const wc = webContents.getAllWebContents().find((x) => !x.isDestroyed() && x.kvAuthenticator);
  const w = wc && BrowserWindow.fromWebContents(wc);
  if (!w || w.isDestroyed()) return fail('no passkey window after the passkey checks');
  // Every ceremony of this run showed its window only once its page was ready: nothing undone so far.
  const before = w.kvStrayShows || 0;
  if (before) fail(`${before} shows of the passkey window without a ready page during the run`);
  w.emit('show');
  if ((w.kvStrayShows || 0) !== before + 1) fail('a show without a ceremony was not caught');
  if (w.isVisible()) fail('passkey window visible without a ceremony');
  let prevented = false;
  w.emit('close', { preventDefault: () => { prevented = true; } });
  if (!prevented) fail('closing the reused passkey window was not turned into hiding');
  if (w.isDestroyed()) return fail('passkey window destroyed by closing without a ceremony');
  if (w.isVisible()) fail('passkey window still visible after closing without a ceremony');
  return undefined;
}
