// #439: what the three ways to use a passkey (browser extension, Windows provider, AI agent) have in common in the app.

import { passkeyPin } from './guards.js';
import { send } from './session.js';
import { showWindow } from './window.js';

/** Before any dialog: no PIN set while one is needed → the app asks to set one, the passkey is not used. */
export function requireUsablePasskeyPin() {
  try {
    passkeyPin.assertUsable();
  } catch (e) {
    showWindow();
    send({ type: 'passkeyPinNeeded' });
    throw e;
  }
}
