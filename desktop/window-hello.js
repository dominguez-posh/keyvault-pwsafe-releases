// #512: Windows Hello lifts the window lock of #507 (the vault session open for the browser extension only) besides the
// app PIN. Only the main process asks Windows Hello (Keevault-Update.exe --hello-verify, windows/Setup/Hello.cs) and
// reads the answer; the window only asks for it. Hello opens no session, gives no PIN token (requirePin stays shut),
// changes no PIN and does nothing for the normal lock screen – there the PIN stays the only way, and it stays the
// fallback here. Off by default; switched on only with the app PIN (setWindowHello). No Electron here (unit tests).

import { t } from '../extension/core/i18n.js';

/** UserConsentVerificationResult / UserConsentVerifierAvailability of Windows. */
export const HELLO_VERIFIED = 0;
export const HELLO_AVAILABLE = 0;
const HELLO_CANCELED = new Set([5, 6]); // RetriesExhausted, Canceled

/**
 * On only when the user switched it on (a preset of the organization file does not count) and an app PIN is set –
 * the PIN stays the fallback.
 */
export const helloOn = (settings, userSet) => userSet === true && settings?.windowHello === true && !!settings?.appPin
  && !settings?.enforced?.includes?.('windowHello'); // #512: the organization switched it off (only false is enforced)

/** The number under `key` in the helper's one JSON line (exit code 0), else null. */
export function helloOutput(code, out, key) {
  if (code !== 0) return null;
  try {
    const v = JSON.parse(String(out || '').trim())[key];
    return Number.isInteger(v) ? v : null;
  } catch {
    return null;
  }
}

const failure = (name, message) => Object.assign(new Error(message), { name });

/**
 * One Hello request at a time, only while the window is locked alone, and only for the lock it was asked for:
 * locked: () => ({ opened, windowLocked, epoch }) – epoch changes with every new window lock.
 * verify: async () => the result number of Windows Hello (null: no answer).
 */
export class WindowHelloGate {
  constructor({ on, locked, verify }) {
    this.on = on;
    this.locked = locked;
    this.verify = verify;
    this.busy = false;
  }

  /** Resolves when Windows Hello confirmed the user for the current window lock; throws otherwise. */
  async confirm() {
    if (!this.on()) throw failure('HelloOff', t('Windows Hello ist zum Entsperren nicht eingeschaltet – bitte die PIN eingeben'));
    const before = this.locked();
    if (!before.opened || !before.windowLocked) throw failure('NotWindowLocked', t('Das Fenster ist nicht gesperrt'));
    if (this.busy) throw failure('HelloBusy', t('Windows Hello fragt bereits'));
    this.busy = true;
    let result;
    try {
      result = await this.verify();
    } catch {
      result = null;
    } finally {
      this.busy = false;
    }
    if (result !== HELLO_VERIFIED) {
      if (HELLO_CANCELED.has(result)) throw failure('HelloCanceled', t('Windows Hello abgebrochen – bitte die PIN eingeben'));
      throw failure('HelloUnavailable', t('Windows Hello ist nicht verfügbar – bitte die PIN eingeben'));
    }
    // Locked, unlocked or locked anew while Windows asked: this answer belongs to a lock that is gone.
    const after = this.locked();
    if (!this.on() || !after.opened || !after.windowLocked || after.epoch !== before.epoch) {
      throw failure('HelloStale', t('Die Sperre hat sich inzwischen geändert – bitte erneut entsperren'));
    }
    return true;
  }
}
