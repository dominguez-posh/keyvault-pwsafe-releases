// #439: every use of a passkey (extension, Windows provider, AI agent) asks for the app PIN, once per use. The PIN is
// typed in the app or in the extension's own window, never in a web page, and checked here against the stored hash with
// the same counter as unlocking (wrong attempts add up, a restart does not reset them). No grace period: a verified PIN
// is not remembered, the next use asks again.

import { t } from '../extension/core/i18n.js';
import { verifyPin, inPinQueue } from './pin.js';
import { migrated, runProof } from './proof.js';

const fail = (name, message) => Object.assign(new Error(message), { name });

/** On unless the user switched it off – and always on when the organization requires a PIN (policy RequirePin). */
export const passkeyPinOn = (settings) => !!settings?.requirePin || settings?.passkeyPin !== false;

export class PasskeyPinGate {
  /**
   * settings(): config values, guard: PinGuard, save(state): persists guard.toJSON(). verify(pin): the secret is right –
   * #537: the master password or the PIN wrapper once set up (desktop/main/unlock.js); by default the stored PIN hash.
   */
  constructor({ settings, guard, save, verify = null, hello = null, forced = null, forcedSeen = null }) {
    // #537 2b: forced() → Promise<boolean>: "Immer bestätigen" is on – every use asks; forcedSeen() the last known answer (dialogs).
    Object.assign(this, { settings, guard, save, hello, forced, forcedSeen }); // #537 stage 4: hello(purpose) – a fresh Windows Hello confirmation
    this.verify = verify || ((pin) => verifyPin(pin, this.settings().appPin));
  }

  /** { required, pinSet } – what a dialog needs to know before it asks. */
  state() {
    const s = this.settings();
    // #537 stage 4: once the master password is set up the dialogs say so, and offer Windows Hello when it is on.
    return { required: passkeyPinOn(s) || !!this.forcedSeen?.(), pinSet: !!s.appPin, ...(migrated(s) ? { masterPassword: true, hello: !!s.unlockKeys?.hello } : {}) };
  }

  /** Refuses a passkey use without a set PIN (the user is asked to set one in the app) before any dialog opens. */
  assertUsable() {
    const { required, pinSet } = this.state();
    if (required && !pinSet) throw fail('PinNotSet', t('Für Passkeys braucht Keevault eine App-PIN. Lege sie in der Keevault-App unter Einstellungen → Sicherheit fest.'));
  }

  /**
   * Checks the proof for exactly one use. Returns false when none is asked for (setting off), true when it held.
   * #537 stage 4: the master password, the PIN wrapper, or { hello: true } – a Hello of its own for this one use, asked
   * outside the PIN queue (runProof).
   */
  async check(pin) {
    const s = this.settings();
    if (!passkeyPinOn(s) && !(this.forced && (await this.forced()))) return false;
    if (!s.appPin) throw fail('PinNotSet', t('Für Passkeys braucht Keevault eine App-PIN. Lege sie in der Keevault-App unter Einstellungen → Sicherheit fest.'));
    return runProof(pin, { settings: s, guard: this.guard, save: this.save, verify: this.verify, hello: this.hello, purpose: 'passkey' }, inPinQueue, () => true);
  }
}
