// #537: the one master password (MP) of the app on this device. The record of desktop/unlock-keys.js (device key DK,
// wrapped with the MP and optionally a PIN) lives in the settings under `unlockKeys`, additionally protected with DPAPI.
// Checking a secret means unwrapping DK – the result opens the personal vault binding and the offline mirror. Also here:
// the move from the app PIN (one write, Konrad), a new DK whenever the MP changes, and the fresh MP or recovery key that
// changing the MP, recovery key or sticks of the personal vault needs (purpose-bound, used once).
// No Electron: desktop/main/unlock.js wires it up (DPAPI, settings, personal vault, mirror); unit tests use stand-ins.

import { t } from '../extension/core/i18n.js';
import { ckFingerprint, descendsFrom, unlockWithCode, unlockWithPassword } from '../extension/core/protect.js';
import * as U from './unlock-keys.js';
import { hashPin, isShortPin, MIN_PIN_LENGTH, verifyPin } from './pin.js';

const RECENT_MS = 10 * 60_000;
const FRESH_MS = 120_000;
/** What a fresh MP or recovery key may be confirmed for (Konrad: purpose-bound). */
// personal-adopt (H2): a personal vault whose master password differs from the app's becomes it only with the current one.
export const FRESH_PURPOSES = Object.freeze(['personal-keyring', 'personal-adopt']);

const fail = (name, message) => Object.assign(new Error(message), { name });
const waitError = (seconds) => new Error(t('Zu viele falsche Versuche – bitte {seconds} Sekunden warten', { seconds }));

export class UnlockService {
  /**
   * config: { get(), update(patch) }; dpapi: { available(), protect(text) → base64, unprotect(base64) → text };
   * guard: PinGuard (shared counter); queue(fn): inPinQueue; personal: { entries(), binding(id, raw, dk), unlockWithDk(dk) };
   * mirror: { wanted(), unlockFactor(f), switchFactor(f), remove() }; recentPin(): { pin, at } | null; forgetPin(): drops
   * it; diag(text). personal.unlockWithDk(dk) → { stale: [entries] } – vaults whose key moved on (changed elsewhere).
   */
  constructor({ config, dpapi, guard, queue, personal, mirror, recentPin = () => null, forgetPin = () => {}, diag = () => {}, now = Date.now, removeHelloKey = async () => {} }) {
    Object.assign(this, { config, dpapi, guard, queue, personal, mirror, recentPin, forgetPin, diag, now, removeHelloKey });
    this.recent = null; // { dk, at } after a correct MP or PIN: binds a personal vault opened later in the same session
    this.fresh = null; // { purpose, until } – one fresh MP / recovery key for one action
  }

  isMigrated() {
    return !!this.config.get().unlockKeys?.blob;
  }

  /** What the window may know: set up, PIN wrapper there, minimum length. Never key material. */
  info() {
    const u = this.config.get().unlockKeys;
    return { migrated: !!u?.blob, pin: !!u?.pin, hello: !!u?.hello, minLength: U.MP_MIN_LENGTH, helloOffer: this.helloOfferDue() };
  }

  /**
   * #537 live test: "Windows Hello aktivieren?" once per device – also after an upgrade from the app PIN, where the first
   * start (that asks it) never runs. Due when the master password is set up, Hello is not on and it was not asked yet.
   * → null (not due), 'hello' (a PIN kept from before counts as the chosen alternative: only Hello) or 'hello-or-pin'.
   */
  helloOfferDue() {
    const s = this.config.get();
    const u = s.unlockKeys;
    if (!u?.blob || u.hello || s.helloOffered === true) return null;
    return u.pin ? 'hello' : 'hello-or-pin';
  }

  /** The question was shown (answered or skipped): never again on this device. */
  helloOffered() {
    if (this.config.get().helloOffered !== true) this.config.update({ helloOffered: true });
  }

  /** DK of the last correct MP or PIN in this session (10 minutes), else null. */
  recentDk() {
    if (!this.recent || this.now() - this.recent.at > RECENT_MS) return null;
    return this.recent.dk;
  }

  /** DK just proven another way (the personal vault opened with the MP that the record accepts). */
  rememberDk(dk) {
    this.recent = { dk, at: this.now() };
  }

  /** After an MP verified in the same call (creating the personal vault): one fresh confirmation for its next step. */
  grantFresh(purpose) {
    if (!FRESH_PURPOSES.includes(purpose)) throw new Error('unknown purpose');
    this.fresh = { purpose, until: this.now() + FRESH_MS };
  }

  /** Locking forgets DK and every fresh confirmation. */
  forget() {
    this.recent = null;
    this.fresh = null;
  }

  async readRecord() {
    const u = this.config.get().unlockKeys;
    if (!u?.blob) return null;
    return JSON.parse(await this.dpapi.unprotect(u.blob));
  }

  /** The form stored in the settings: flags for the lock screen, the record itself only under DPAPI. */
  async stored(record) {
    if (!(await this.dpapi.available())) throw new Error(t('Der Windows-Schlüsselspeicher ist nicht verfügbar'));
    return { v: 1, pin: !!record.pin, hello: !!record.hello, blob: await this.dpapi.protect(JSON.stringify(record)) };
  }

  /** The personal vault whose keyring this MP opens (MP changed on another device, or a vault adopted here): [{ entry, ck }] or null. */
  async personalKeyFor(password) {
    for (const entry of this.personal.entries()) {
      if (!entry.vault?.keyring) continue;
      try {
        const { ck } = await unlockWithPassword(entry.vault.keyring, password);
        return [{ entry, ck }];
      } catch {
        // not this one
      }
    }
    return null;
  }

  /** H2: the vault and key the record belongs to – the fingerprint of the bound container key. */
  async withLineage(record, entry, ck) {
    return { ...record, lineage: { vault: entry.id, fp: await ckFingerprint(ck) } };
  }

  /** H2: is this vault the one bound here, or its successor by key changes? */
  async inLineage(record, entry, ck) {
    return !!record?.lineage && record.lineage.vault === entry.id && descendsFrom(entry.vault.keyring, ck, record.lineage.fp);
  }

  /** H2: binding a personal vault to this device is allowed for the vault of the record (lineage) only. */
  async mayBind(entry, ck) {
    return this.inLineage(await this.readRecord(), entry, ck);
  }

  /**
   * H2: the personal vault created or opened with the app's master password (checked by the caller, or a fresh one for
   * a vault with another master password) is the vault of the record from now on.
   */
  async adoptLineage(entry, ck) {
    const record = await this.readRecord();
    if (record) this.config.update({ unlockKeys: await this.stored(await this.withLineage(record, entry, ck)) });
  }

  /** N1: what appPin holds for older app versions – the hash of the PIN that still unlocks, else of a random value. */
  appPinFor(pinText) {
    return pinText ? hashPin(String(pinText)) : U.legacyAppPin(null);
  }

  /**
   * Checks a secret against the record, without counting (the callers count in the guard). kind: 'password' | 'pin' |
   * undefined (both; the PIN only when a PIN wrapper exists). → { dk, via } or null. An MP that only the personal vault
   * knows (changed elsewhere) becomes the app's MP here, with a new DK.
   */
  async checkSecret(secret, { kind } = {}) {
    const record = await this.readRecord();
    const text = String(secret ?? '');
    if (!record || !text) return null;
    if (kind !== 'pin') {
      const dk = await U.openWithPassword(record, text);
      if (dk) return { dk, via: 'password' };
      // H2: only the successor of the vault bound here (changed on another device) makes its MP the app's.
      const opened = await this.personalKeyFor(text);
      if (opened && (await this.inLineage(record, opened[0].entry, opened[0].ck))) return { dk: await this.rotate(text, opened), via: 'password', rotated: true };
    }
    if (kind !== 'password' && record.pin) {
      const r = await U.openWithPin(record, text);
      if (r.record !== record) {
        // N1: a PIN wrapper deleted by E6 takes the old PIN's hash in appPin along.
        this.config.update({ unlockKeys: await this.stored(r.record), ...(r.record.pin ? {} : { appPin: await this.appPinFor(null) }) });
      }
      if (r.gone) this.diag('UNLOCK pin wrapper removed after too many wrong PINs (E6)');
      if (r.dk) return { dk: r.dk, via: 'pin' };
    }
    return null;
  }

  /** For the PIN gates (passkey, copy, export): the secret is right – MP or PIN once set up, else the old PIN hash. */
  async secretMatches(secret) {
    if (this.isMigrated()) return !!(await this.checkSecret(secret));
    return verifyPin(secret, this.config.get().appPin);
  }

  countFailure(message) {
    this.guard.failure();
    this.config.update({ pinGuard: this.guard.toJSON() });
    throw fail('WrongSecret', message(this.guard.waitSeconds()));
  }

  succeed({ unlock }) {
    this.guard.success({ unlock });
    if (this.config.get().pinGuard) this.config.update({ pinGuard: null });
  }

  /**
   * Unlocking with MP or PIN (api.verifyPin once set up). One after the other with the shared counter; success allows
   * exactly one unlock (guard) and opens the personal vault and the offline mirror with DK.
   */
  verifyUnlock(secret, { kind } = {}) {
    return this.queue(async () => {
      const wait = this.guard.waitSeconds();
      if (wait) throw waitError(wait);
      const r = await this.checkSecret(secret, { kind });
      if (!r) this.countFailure((s) => (s ? t('Falsches Masterpasswort oder falsche PIN – bitte {seconds} Sekunden warten', { seconds: s }) : t('Falsches Masterpasswort oder falsche PIN')));
      try {
        return await this.unlockWithDk(r.dk);
      } catch (e) {
        // #539 M-a (Konrad): another device changed the key and kept the master password (removing a recovery stick).
        // The record still takes the MP, the vault refuses the old binding – without this, MasterPasswordChanged for ever.
        // The MP opens the successor of the vault bound here: the old DK was just proven (its member-key copy is rescued
        // by personal.unlockWithDk's caller), now a new DK for it, as after an MP changed elsewhere.
        if (e.name !== 'MasterPasswordChanged' || r.via !== 'password' || r.rotated) throw e;
        const text = String(secret ?? '');
        const opened = await this.personalKeyFor(text);
        if (!opened || !(await this.inLineage(await this.readRecord(), opened[0].entry, opened[0].ck))) throw e;
        return this.unlockWithDk(await this.rotate(text, opened));
      }
    });
  }

  /** After a proven DK (MP, PIN or Hello): the personal vault, the offline mirror and exactly one unlock (guard). */
  async unlockWithDk(dk) {
    // M2: the personal vault got a new key on another device – the old MP (or the PIN, or Hello) must not open the app.
    const opened = await this.personal.unlockWithDk(dk).catch((e) => { this.diag(`PERSONAL dk unlock failed: ${e.message}`); return null; });
    if (opened?.stale?.length) {
      throw fail('MasterPasswordChanged', t('Dein Masterpasswort wurde auf einem anderen Gerät geändert – bitte das neue eingeben.'));
    }
    this.succeed({ unlock: true });
    this.rememberDk(dk);
    if (this.mirror.wanted()) await this.mirror.unlockFactor(U.subKey(dk, 'offline')).catch(() => {});
    return true;
  }

  /** Only the MP (counted): for the PIN dialog, the fresh confirmation and the new personal vault. → DK */
  verifyPasswordCounted(password) {
    return this.queue(async () => {
      const wait = this.guard.waitSeconds();
      if (wait) throw waitError(wait);
      const r = await this.checkSecret(password, { kind: 'password' });
      if (!r) this.countFailure((s) => (s ? t('Falsches Masterpasswort – bitte {seconds} Sekunden warten', { seconds: s }) : t('Falsches Masterpasswort')));
      this.succeed({ unlock: false });
      this.rememberDk(r.dk);
      return r.dk;
    });
  }

  /** The new DK moves the offline mirror along (or drops it); a mirror that is off stays off. */
  async moveMirror(dk) {
    if (!this.config.get().offlineMirror) return;
    await this.mirror.switchFactor(U.subKey(dk, 'offline')).catch(() => this.mirror.remove().catch(() => {}));
  }

  /**
   * Konrad: a new MP gets a new DK. The record holds only the MP afterwards (PIN and Hello are set up again), the
   * bindings of the opened personal vaults are made for the new DK, the offline mirror moves to it – one write.
   */
  async rotate(password, opened = []) {
    const previous = await this.readRecord().catch(() => null);
    const dk = U.newDk();
    let record = await U.createRecord(dk, password, { existing: true });
    if (opened[0]) record = await this.withLineage(record, opened[0].entry, opened[0].ck);
    const keys = {};
    for (const { entry, ck } of opened) keys[entry.path] = await this.personal.binding(entry.id, ck.raw, dk);
    // N1: no PIN wrapper any more – appPin holds a random value's hash, an older app opens with no old PIN.
    this.config.update({ unlockKeys: await this.stored(record), personalDeviceKeys: keys, appPin: await this.appPinFor(null) });
    // Konrad (review of 5d81351): the old Hello key opens nothing any more – it goes from the Hello container too.
    if (previous?.hello?.name) await this.removeHelloKey(previous.hello.name).catch(() => {});
    for (const { entry, ck } of opened) if (entry.vault?.locked) await entry.vault.unlock(new Uint8Array(ck.raw)).catch(() => {});
    await this.moveMirror(dk);
    this.rememberDk(dk);
    this.diag('UNLOCK new device key (master password changed)');
    return dk;
  }

  /**
   * The move from the app PIN (or from no PIN) to the master password. The old PIN (just entered, or given here) proves the
   * person; with a personal vault the MP must be its master password, without one it is set here. Everything new is built
   * first and written in ONE settings update (Konrad: atomic) – an error before leaves the old state as it was.
   * keepPin: the old PIN stays as a convenience wrapper of DK (only with 6 characters or more). newPin: without an old PIN
   * (first start), an optional PIN for this device.
   */
  async migrate({ password, pin = null, keepPin = true, newPin = null }) {
    if (this.isMigrated()) throw new Error(t('Das Masterpasswort ist schon eingerichtet'));
    const s = this.config.get();
    const text = String(password ?? '');
    let pinText = null;
    if (s.appPin) {
      const last = this.recentPin();
      const remembered = last && this.now() - last.at < RECENT_MS ? last.pin : null;
      pinText = pin != null && pin !== '' ? String(pin) : remembered;
      if (!pinText) throw fail('PinRequired', t('Bitte die bisherige PIN eingeben'));
    }
    // M1 (Konrad): the MP first and counted, then the old PIN; a right PIN never resets a counted wrong MP.
    const opened = [];
    await this.queue(async () => {
      const wait = this.guard.waitSeconds();
      if (wait) throw waitError(wait);
      for (const entry of this.personal.entries()) {
        if (!entry.vault?.keyring) continue;
        const r = await unlockWithPassword(entry.vault.keyring, text).catch(() => null);
        if (!r) return this.countFailure(() => t('Das ist nicht das Masterpasswort deines persönlichen Tresors'));
        opened.push({ entry, ck: r.ck });
      }
      if (pinText && !(await verifyPin(pinText, s.appPin))) return this.countFailure(() => t('Falsche PIN'));
      return undefined;
    });
    if (!opened.length && text.length < U.MP_MIN_LENGTH) throw new Error(t('Das Masterpasswort braucht mindestens {n} Zeichen', { n: U.MP_MIN_LENGTH }));
    const dk = U.newDk();
    let record = await U.createRecord(dk, text, { existing: opened.length > 0 });
    if (opened[0]) record = await this.withLineage(record, opened[0].entry, opened[0].ck);
    const pinKept = !!(keepPin && pinText && !isShortPin(pinText));
    let appPin;
    if (pinKept) {
      record = await U.setPinWrap(record, dk, pinText);
      appPin = s.appPin; // E3: an older app keeps asking the same PIN
    } else if (!s.appPin && newPin != null && newPin !== '') {
      if (isShortPin(newPin)) throw new Error(t('Die PIN braucht mindestens {n} Zeichen', { n: MIN_PIN_LENGTH }));
      record = await U.setPinWrap(record, dk, String(newPin));
      appPin = await this.appPinFor(newPin); // N1
    } else appPin = await this.appPinFor(null); // N1: the old PIN no longer unlocks here, so not in an older app either
    const keys = {};
    for (const { entry, ck } of opened) keys[entry.path] = await this.personal.binding(entry.id, ck.raw, dk);
    this.config.update(await U.migrationPatch({ previousAppPin: s.appPin, appPin, unlockKeys: await this.stored(record), personalDeviceKeys: keys }));
    this.forgetPin(); // M1: the old PIN is no longer kept in memory
    // Written. From here on only what follows from it: open what the MP opened, move the mirror to DK.
    for (const { entry, ck } of opened) if (entry.vault?.locked) await entry.vault.unlock(new Uint8Array(ck.raw)).catch(() => {});
    await this.moveMirror(dk);
    this.rememberDk(dk);
    this.diag('UNLOCK master password set up');
    return { pinKept: !!record.pin };
  }

  /** PIN wrapper on, changed or off – always with the MP (Konrad: never with the PIN or Hello alone). next null: off. */
  async setPinWrapWithPassword(password, next) {
    if (next != null && next !== '' && isShortPin(next)) throw new Error(t('Die PIN braucht mindestens {n} Zeichen', { n: MIN_PIN_LENGTH }));
    const dk = await this.verifyPasswordCounted(password);
    let record = await this.readRecord();
    record = next == null || next === '' ? U.dropWrap(record, 'pin') : await U.setPinWrap(record, dk, String(next));
    this.config.update({ unlockKeys: await this.stored(record), appPin: await this.appPinFor(record.pin ? next : null) }); // N1
    return true;
  }

  /**
   * Stage 6 (2a, E1): the master password reset with the recovery stick of the personal vault. open() runs the stick
   * ceremony and opens the vault's keyring with it (role recovery) → { ck }; a stick that does not fit (UnlockError)
   * counts on the shared counter, a cancelled ceremony does not. Only the vault this device's record belongs to. Then the
   * real key change (#402) with the new MP: rekey(ck, password) → { recoveryKey } – the caller's onRekey makes the new
   * DK (rotate). The stick's PRF is the proof here (Konrad): no fresh MP. → { recoveryKey, dk }
   */
  resetWithStick(entry, password, ops) {
    // Konrad N2: one after the other with every other check of a secret (shared counter, no two key changes at once).
    return this.queue(() => this.resetWithStickNow(entry, password, ops));
  }

  async resetWithStickNow(entry, password, { open, rekey }) {
    const text = String(password ?? '');
    if (text.length < U.MP_MIN_LENGTH) throw new Error(t('Das Masterpasswort braucht mindestens {n} Zeichen', { n: U.MP_MIN_LENGTH }));
    const record = await this.readRecord();
    if (!record) throw new Error(t('Das Masterpasswort ist noch nicht eingerichtet'));
    const wait = this.guard.waitSeconds();
    if (wait) throw waitError(wait);
    let opened;
    try {
      opened = await open();
    } catch (e) {
      if (e?.name === 'UnlockError') this.countFailure(() => t('Dieser Sicherheitsschlüssel passt nicht zu deinem persönlichen Tresor'));
      throw e;
    }
    if (!opened?.ck || !(await this.inLineage(record, entry, opened.ck))) {
      throw fail('NotBound', t('Dieser Tresor ist nicht der persönliche Tresor dieses Geräts'));
    }
    const r = await rekey(opened.ck, text);
    const dk = this.recentDk();
    if (!dk) throw new Error('no device key after the key change');
    this.diag('UNLOCK master password reset with the recovery stick');
    return { recoveryKey: r?.recoveryKey || null, dk };
  }

  /**
   * A fresh MP or recovery key for one action (purpose). Changing the MP, the recovery key or the sticks of the personal
   * vault takes it (Konrad): an unlocked app – opened with the PIN or later Hello – is not enough for those.
   */
  async confirmFresh({ password, code } = {}, purpose) {
    if (!FRESH_PURPOSES.includes(purpose)) throw new Error('unknown purpose');
    this.fresh = null;
    if (code != null && code !== '') {
      if (purpose !== 'personal-keyring') throw new Error(t('Bitte das Masterpasswort eingeben'));
      await this.queue(async () => {
        const wait = this.guard.waitSeconds();
        if (wait) throw waitError(wait);
        for (const entry of this.personal.entries()) {
          const r = await unlockWithCode(entry.vault?.keyring || { entries: [] }, code).catch(() => null);
          if (r?.entry.type === 'recovery') return this.succeed({ unlock: false });
        }
        return this.countFailure(() => t('Der Wiederherstellungsschlüssel passt nicht'));
      });
    } else {
      await this.verifyPasswordCounted(password);
    }
    this.fresh = { purpose, until: this.now() + FRESH_MS };
    return true;
  }

  /** Takes the fresh confirmation for purpose (once); throws FreshProofRequired without one. */
  consumeFresh(purpose) {
    const f = this.fresh;
    this.fresh = null;
    if (!f || f.purpose !== purpose || this.now() > f.until) {
      throw Object.assign(fail('FreshProofRequired', t('Bitte zuerst das Masterpasswort oder den Wiederherstellungsschlüssel eingeben')), { purpose });
    }
  }
}
