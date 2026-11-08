// #473: a plaintext export (CSV) needs the app PIN, if one is set – for every vault, the personal one too. The window
// asks for the PIN; the main process checks it here with the same counter and lockout as unlocking and passkey use
// (#439) and hands back a confirmation that is valid for one export of one vault, for a short time. exportItems takes
// it; without it there is no export, whatever the window does. No PIN set: nothing to confirm (only the warning).

import crypto from 'node:crypto';
import { t } from '../extension/core/i18n.js';
import { verifyPin, inPinQueue } from './pin.js';

export const EXPORT_PIN_TTL_MS = 60_000;

const fail = (name, message) => Object.assign(new Error(message), { name });

export class ExportPinGate {
  /** settings(): config values, guard: PinGuard (shared counter), save(state): persists guard.toJSON() */
  constructor({ settings, guard, save, ttlMs = EXPORT_PIN_TTL_MS, now = Date.now }) {
    Object.assign(this, { settings, guard, save, ttlMs, now });
    this.pending = null; // { containerId, token, until } – at most one confirmation at a time
  }

  required() {
    return !!this.settings()?.appPin;
  }

  /** Checks the PIN for one export of containerId. → confirmation token, or null when no PIN is set. */
  confirm(containerId, pin) {
    return inPinQueue(() => this.#confirm(containerId, pin));
  }

  async #confirm(containerId, pin) {
    this.pending = null;
    const s = this.settings();
    if (!s?.appPin) return null;
    const wait = this.guard.waitSeconds();
    if (wait) throw fail('PinBlocked', t('Zu viele falsche Versuche – bitte {seconds} Sekunden warten', { seconds: wait }));
    if (typeof pin !== 'string' || !pin) throw fail('PinRequired', t('Bitte die App-PIN eingeben'));
    if (await verifyPin(pin, s.appPin)) {
      // unlock: false – confirming an export must not open the one unlock a verified PIN allows.
      this.guard.success({ unlock: false });
      this.save(null);
      const token = crypto.randomBytes(24).toString('base64url');
      this.pending = { containerId: String(containerId), token, until: this.now() + this.ttlMs };
      return token;
    }
    this.guard.failure();
    this.save(this.guard.toJSON());
    const left = this.guard.waitSeconds();
    throw fail('PinWrong', left ? t('Falsche PIN – bitte {seconds} Sekunden warten', { seconds: left }) : t('Falsche PIN'));
  }

  /** Before the export: throws unless a PIN is not set or token is the fresh confirmation for containerId. Used once. */
  consume(containerId, token) {
    if (!this.required()) return;
    const p = this.pending;
    this.pending = null; // one export per confirmation, also when this one is refused
    const same = typeof token === 'string' && !!p && token.length === p.token.length
      && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(p.token));
    if (!same || p.containerId !== String(containerId) || this.now() >= p.until) {
      throw fail('ExportPinRequired', t('Für den Export bitte zuerst die App-PIN eingeben'));
    }
  }
}
