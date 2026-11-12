// #480: a vault whose settings ask for the app PIN when copying (protect.pinCopy). The window asks for the PIN; the main
// process checks it here with the same counter and lockout as unlocking (#439, #473) and then lets copies from that one
// vault through for a short time (copying user name and password in a row needs one PIN). No app PIN set: the copy is
// refused – the vault demands one, whatever the personal setting says.

import { t } from '../extension/core/i18n.js';
import { verifyPin, inPinQueue } from './pin.js';

export const COPY_PIN_TTL_MS = 60_000;

const fail = (name, message) => Object.assign(new Error(message), { name });

export class CopyPinGate {
  /** settings(): config values, guard: PinGuard (shared counter), save(state): persists guard.toJSON() */
  constructor({ settings, guard, save, ttlMs = COPY_PIN_TTL_MS, now = Date.now }) {
    Object.assign(this, { settings, guard, save, ttlMs, now });
    this.open = new Map(); // containerId → until
  }

  confirm(containerId, pin) {
    return inPinQueue(async () => {
      const s = this.settings();
      if (!s?.appPin) throw fail('AppPinMissing', t('Dieser Tresor verlangt die App-PIN. Lege zuerst in den Einstellungen eine App-PIN fest.'));
      const wait = this.guard.waitSeconds();
      if (wait) throw fail('PinBlocked', t('Zu viele falsche Versuche – bitte {seconds} Sekunden warten', { seconds: wait }));
      if (typeof pin !== 'string' || !pin) throw fail('PinRequired', t('Bitte die App-PIN eingeben'));
      if (await verifyPin(pin, s.appPin)) {
        this.guard.success({ unlock: false }); // never opens the one unlock a verified PIN allows
        this.save(null);
        this.open.set(String(containerId), this.now() + this.ttlMs);
        return true;
      }
      this.guard.failure();
      this.save(this.guard.toJSON());
      const left = this.guard.waitSeconds();
      throw fail('PinWrong', left ? t('Falsche PIN – bitte {seconds} Sekunden warten', { seconds: left }) : t('Falsche PIN'));
    });
  }

  /** Before a copy from containerId: throws unless the PIN was confirmed for it a moment ago. */
  require(containerId) {
    if (!this.settings()?.appPin) throw fail('AppPinMissing', t('Dieser Tresor verlangt die App-PIN. Lege zuerst in den Einstellungen eine App-PIN fest.'));
    const until = this.open.get(String(containerId)) || 0;
    if (this.now() >= until) {
      this.open.delete(String(containerId));
      throw Object.assign(fail('CopyPinRequired', t('Dieser Tresor verlangt beim Kopieren die App-PIN.')), { containerId: String(containerId) });
    }
  }

  /** Locking the app ends every open confirmation. */
  clear() {
    this.open.clear();
  }
}
