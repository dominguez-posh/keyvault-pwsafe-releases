// #480: a vault whose settings ask for the app PIN when copying (protect.pinCopy). The window asks for the PIN; the main
// process checks it here with the same counter and lockout as unlocking (#439, #473) and then lets copies from that one
// vault through for a short time (copying user name and password in a row needs one PIN). No app PIN set: the copy is
// refused – the vault demands one, whatever the personal setting says.

import { t } from '../extension/core/i18n.js';
import { verifyPin, inPinQueue } from './pin.js';
import { migrated, runProof } from './proof.js';

export const COPY_PIN_TTL_MS = 60_000;

const fail = (name, message) => Object.assign(new Error(message), { name });

export class CopyPinGate {
  /** settings(): config values, guard: PinGuard (shared counter), save(state): persists guard.toJSON() */
  constructor({ settings, guard, save, ttlMs = COPY_PIN_TTL_MS, now = Date.now, verify = null, hello = null }) {
    Object.assign(this, { settings, guard, save, ttlMs, now, hello });
    this.verify = verify || ((pin) => verifyPin(pin, this.settings().appPin)); // #537: MP or PIN once set up
    this.open = new Map(); // containerId → until
  }

  async confirm(containerId, pin) {
    const s = this.settings();
    if (!s?.appPin) throw fail('AppPinMissing', t('Dieser Tresor verlangt die App-PIN. Lege zuerst in den Einstellungen eine App-PIN fest.'));
    // #537 stage 4: MP, PIN wrapper or a Hello of its own (outside the queue); never opens the one unlock.
    return runProof(pin, { settings: s, guard: this.guard, save: this.save, verify: this.verify, hello: this.hello, purpose: 'copy' }, inPinQueue, () => {
      this.open.set(String(containerId), this.now() + this.ttlMs);
      return true;
    });
  }

  /** Before a copy from containerId: throws unless the PIN was confirmed for it a moment ago. */
  require(containerId) {
    if (!this.settings()?.appPin) throw fail('AppPinMissing', t('Dieser Tresor verlangt die App-PIN. Lege zuerst in den Einstellungen eine App-PIN fest.'));
    const until = this.open.get(String(containerId)) || 0;
    if (this.now() >= until) {
      this.open.delete(String(containerId));
      const text = migrated(this.settings()) ? t('Dieser Tresor verlangt beim Kopieren eine Bestätigung (Masterpasswort, PIN oder Windows Hello).') : t('Dieser Tresor verlangt beim Kopieren die App-PIN.');
      throw Object.assign(fail('CopyPinRequired', text), { containerId: String(containerId) });
    }
  }

  /** Locking the app ends every open confirmation. */
  clear() {
    this.open.clear();
  }
}
