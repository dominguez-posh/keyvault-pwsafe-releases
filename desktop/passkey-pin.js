// #439: every use of a passkey (extension, Windows provider, AI agent) asks for the app PIN, once per use. The PIN is
// typed in the app or in the extension's own window, never in a web page, and checked here against the stored hash with
// the same counter as unlocking (wrong attempts add up, a restart does not reset them). No grace period: a verified PIN
// is not remembered, the next use asks again.

import { t } from '../extension/core/i18n.js';
import { verifyPin, inPinQueue } from './pin.js';

const fail = (name, message) => Object.assign(new Error(message), { name });

/** On unless the user switched it off – and always on when the organization requires a PIN (policy RequirePin). */
export const passkeyPinOn = (settings) => !!settings?.requirePin || settings?.passkeyPin !== false;

export class PasskeyPinGate {
  /** settings(): config values, guard: PinGuard, save(state): persists guard.toJSON() */
  constructor({ settings, guard, save }) {
    Object.assign(this, { settings, guard, save });
  }

  /** { required, pinSet } – what a dialog needs to know before it asks. */
  state() {
    const s = this.settings();
    return { required: passkeyPinOn(s), pinSet: !!s.appPin };
  }

  /** Refuses a passkey use without a set PIN (the user is asked to set one in the app) before any dialog opens. */
  assertUsable() {
    const { required, pinSet } = this.state();
    if (required && !pinSet) throw fail('PinNotSet', t('Für Passkeys braucht Keevault eine App-PIN. Lege sie in der Keevault-App unter Einstellungen → Sicherheit fest.'));
  }

  /** Checks the PIN for exactly one use. Returns false when no PIN is asked for (setting off), true when it was verified. */
  check(pin) {
    return inPinQueue(() => this.#check(pin));
  }

  async #check(pin) {
    const s = this.settings();
    if (!passkeyPinOn(s)) return false;
    this.assertUsable();
    const wait = this.guard.waitSeconds();
    if (wait) throw fail('PinBlocked', t('Zu viele falsche Versuche – bitte {seconds} Sekunden warten', { seconds: wait }));
    if (typeof pin !== 'string' || !pin) throw fail('PinRequired', t('Bitte die App-PIN eingeben'));
    if (await verifyPin(pin, s.appPin)) {
      this.guard.success({ unlock: false });
      this.save(null);
      return true;
    }
    this.guard.failure();
    this.save(this.guard.toJSON());
    const left = this.guard.waitSeconds();
    throw fail('PinWrong', left ? t('Falsche PIN – bitte {seconds} Sekunden warten', { seconds: left }) : t('Falsche PIN'));
  }
}
