// #473: a plaintext export (CSV) needs the app PIN, if one is set – for every vault, the personal one too. The window
// asks for the PIN; the main process checks it here with the same counter and lockout as unlocking and passkey use
// (#439) and hands back a confirmation that is valid for one export of one vault, for a short time. exportItems takes
// it; without it there is no export, whatever the window does. No PIN set: nothing to confirm (only the warning).

import crypto from 'node:crypto';
import { t } from '../extension/core/i18n.js';
import { verifyPin, inPinQueue } from './pin.js';
import { migrated, runProof } from './proof.js';

export const EXPORT_PIN_TTL_MS = 60_000;

const fail = (name, message) => Object.assign(new Error(message), { name });

export class ExportPinGate {
  /** settings(): config values, guard: PinGuard (shared counter), save(state): persists guard.toJSON() */
  constructor({ settings, guard, save, ttlMs = EXPORT_PIN_TTL_MS, now = Date.now, verify = null, hello = null }) {
    Object.assign(this, { settings, guard, save, ttlMs, now, hello });
    this.verify = verify || ((pin) => verifyPin(pin, this.settings().appPin)); // #537: MP or PIN once set up
    this.pending = null; // { containerId, token, until } – at most one confirmation at a time
  }

  required() {
    return !!this.settings()?.appPin;
  }

  /** Checks the proof for one export of containerId. → confirmation token, or null when no PIN is set. */
  async confirm(containerId, pin) {
    this.pending = null;
    const s = this.settings();
    if (!s?.appPin) return null;
    // #537 stage 4: MP, PIN wrapper or a Hello of its own (outside the queue); confirming never opens the one unlock.
    return runProof(pin, { settings: s, guard: this.guard, save: this.save, verify: this.verify, hello: this.hello, purpose: 'export' }, inPinQueue, () => {
      const token = crypto.randomBytes(24).toString('base64url');
      this.pending = { containerId: String(containerId), token, until: this.now() + this.ttlMs };
      return token;
    });
  }

  /** Before the export: throws unless a PIN is not set or token is the fresh confirmation for containerId. Used once. */
  consume(containerId, token) {
    if (!this.required()) return;
    const p = this.pending;
    this.pending = null; // one export per confirmation, also when this one is refused
    const same = typeof token === 'string' && !!p && token.length === p.token.length
      && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(p.token));
    if (!same || p.containerId !== String(containerId) || this.now() >= p.until) {
      throw fail('ExportPinRequired', migrated(this.settings()) ? t('Für den Export bitte zuerst bestätigen (Masterpasswort, PIN oder Windows Hello)') : t('Für den Export bitte zuerst die App-PIN eingeben'));
    }
  }
}
