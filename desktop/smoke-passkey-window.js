// Smoke check of #532: the passkey window is never visible without content. A show without a ready ceremony (the system
// restoring the owner's windows, a show before the page loaded) is undone at once and counted, and closing it without a
// ceremony hides it instead of leaving it open. Runs without a visible window: the events are emitted, never shown.
// The window is the one with the run's virtual authenticator (desktop/main/smoke.js), there after the passkey checks.

import { BrowserWindow, webContents } from 'electron';

export async function passkeyWindowCheck({ fail, passkeyCeremony }) {
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
  // #536: during a running ceremony the page shows text and Cancel, and X as well as Esc end it at once.
  await runningCeremonyEnds(w, fail, passkeyCeremony, 'X', () => w.emit('close', { preventDefault() {} }));
  await runningCeremonyEnds(w, fail, passkeyCeremony, 'Esc', () => w.webContents.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', key: 'Escape' }));
  return undefined;
}

const CANCEL = /Abbrechen|Cancel/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A ceremony for a passkey the virtual authenticator does not have: it waits as for a Windows dialog nobody answers. */
async function runningCeremonyEnds(w, fail, passkeyCeremony, how, end) {
  let settled = null;
  passkeyCeremony({ mode: 'evaluate', containerName: 'Smoke #536', autoStart: true, passkeys: [{ credentialId: 'AAAAAAAAAAAAAAAAAAAAAA', prfSalt: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }] })
    .then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
  let text = '';
  for (let i = 0; i < 50 && !CANCEL.test(text); i++) {
    await sleep(100);
    text = await w.webContents.executeJavaScript('document.body.innerText').catch(() => '');
  }
  if (!text.includes('Smoke #536') || !CANCEL.test(text)) fail(`${how}: passkey page without text and Cancel during the ceremony: "${text.replace(/\s+/g, ' ').trim()}"`);
  end();
  for (let i = 0; i < 20 && !settled; i++) await sleep(100);
  if (settled !== 'rejected') fail(`${how} did not end the running ceremony (${settled || 'still running'})`);
  if (w.isVisible()) fail(`passkey window still visible after ${how} during a ceremony`);
  await sleep(300);
  if (w.webContents.getURL() !== 'about:blank') fail(`${how}: the waiting page was not dropped (${w.webContents.getURL()})`);
}
