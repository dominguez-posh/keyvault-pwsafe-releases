// #530: what the popup needs only after its list – the entry views (ui-item.js with its fields, history, TOTP and
// generator), the move dialogs and the QR decoder (jsQR, 250 KB) – loads on first use instead of before the first list.
// Right after the list is on screen it is fetched in the background, so opening an entry stays as quick as before.

/** Entry detail and form, generator panel (core/ui-item.js). */
export const itemUi = () => import('../core/ui-item.js');
/** Move, linked-assets and move-passkey dialogs (item-move.js). */
export const moveUi = () => import('./item-move.js');
export const moveDialog = async (...a) => (await moveUi()).moveDialog(...a);
export const linkedAssetsDialog = async (...a) => (await moveUi()).linkedAssetsDialog(...a);
export const movePasskeyDialog = async (...a) => (await moveUi()).movePasskeyDialog(...a);

let qr = null;
/** QR decoder for two-factor setup codes shown on websites: jsQR 1.4.0 (Apache-2.0, vendored in lib/jsqr.js, a classic
 * script that sets globalThis.jsQR) → the decoder function. */
export function qrDecoder() {
  if (globalThis.jsQR) return Promise.resolve(globalThis.jsQR);
  qr ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '../lib/jsqr.js';
    s.onload = () => (globalThis.jsQR ? resolve(globalThis.jsQR) : reject(new Error('jsQR')));
    s.onerror = () => {
      qr = null;
      s.remove();
      reject(new Error('jsQR'));
    };
    document.head.append(s);
  });
  return qr;
}

let warmed = false;
/** After the first list: load the rest when the popup is idle (an error here is left to the first real use). */
export function warmUp() {
  if (warmed) return;
  warmed = true;
  const go = () => Promise.all([itemUi(), moveUi()]).catch(() => {});
  if (globalThis.requestIdleCallback) requestIdleCallback(go, { timeout: 1000 });
  else setTimeout(go, 50);
}
