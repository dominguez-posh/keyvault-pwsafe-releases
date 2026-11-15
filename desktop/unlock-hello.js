// #537 stage 3: Windows Hello as a way to unwrap the device key (DK). A TPM-bound RSA key of the Windows Hello container
// (KeyCredentialManager, windows/Setup/HelloKey.cs) signs a stored challenge; the signature – checked as RSASSA-PKCS1-v1_5
// with the key's public part – derives the key of the Hello wrapper (desktop/unlock-keys.js). Konrad's conditions:
// - Hello counts only as an unwrapped AES-GCM wrapper, never as a yes/no; signature and key are never kept or logged.
// - Only with a TPM attestation (desktop/hello-attest.js); switched on only with the MP; the organization can forbid it.
// - One Hello request at a time; a cancel counts nothing, a signature that no longer opens the wrapper (Hello reset,
//   new device PIN set-up, another key) drops the wrapper – the MP is asked and offers to set Hello up again.
// No Electron (unit tests use stand-ins); desktop/main/hello-key.js runs the helper or, in smoke runs, the simulation.

import crypto from 'node:crypto';
import { t } from '../extension/core/i18n.js';
import * as U from './unlock-keys.js';

/** After a cancelled Hello asked by the browser extension: no new request for this long (Konrad). */
export const EXTENSION_HELLO_WAIT_MS = 30_000;
/** At most this many unlock requests of the extension in this time (Konrad); then only the master password or the PIN. */
export const EXTENSION_HELLO_MAX = 3;
export const EXTENSION_HELLO_WINDOW_MS = 10 * 60_000;

export const HELLO_STATUS = Object.freeze({ success: 0, notFound: 2, canceled: 3 }); // KeyCredentialStatus (part)

const fail = (name, message) => Object.assign(new Error(message), { name });

export class HelloUnlock {
  /**
   * service: UnlockService. hello: { status() → { supported, remote }, create(name, challenge) → { status, publicKey,
   * signature, attestation }, sign(name, challenge) → { status, signature }, remove(name), attested(attestation) → bool,
   * allowed() → bool (policy), confirmExtension() → bool (Keevault's own card before an unlock for the extension) }.
   */
  constructor({ service, hello, now = Date.now }) {
    Object.assign(this, { service, hello, now });
    this.busy = false;
    this.extensionWaitUntil = 0;
  }

  /** For the window: on, allowed, available on this device – never key material. */
  async info() {
    await this.enforcePolicy();
    const on = !!this.service.config.get().unlockKeys?.hello;
    const allowed = this.hello.allowed();
    const status = allowed ? await this.hello.status().catch(() => null) : null;
    return { on, allowed, available: !!status?.supported && !status?.remote, remote: !!status?.remote };
  }

  /** One request at a time (Konrad); the second one is refused, not queued behind a dialog. */
  async once(fn) {
    if (this.busy) throw fail('HelloBusy', t('Windows Hello fragt bereits'));
    this.busy = true;
    try {
      return await fn();
    } finally {
      this.busy = false;
    }
  }

  async requireAvailable() {
    if (!this.hello.allowed()) throw fail('HelloForbidden', t('Eure Organisation hat das Entsperren mit Windows Hello abgeschaltet'));
    const status = await this.hello.status().catch(() => null);
    if (status?.remote) throw fail('HelloUnavailable', t('Windows Hello steht in einer Remotesitzung nicht zur Verfügung – bitte das Masterpasswort eingeben'));
    if (!status?.supported) throw fail('HelloUnavailable', t('Windows Hello ist auf diesem Gerät nicht eingerichtet'));
  }

  /**
   * Switches Hello on – only with the MP (counted). Creates a new key (Windows Hello asks), checks the TPM attestation and
   * the signature, wraps DK. A key that fails a check is deleted again; the previous Hello key goes after the write.
   */
  async enable(password) {
    if (!this.service.isMigrated()) throw new Error(t('Bitte zuerst das Masterpasswort einrichten'));
    await this.requireAvailable();
    const dk = await this.service.verifyPasswordCounted(password);
    return this.once(async () => {
      const name = `Keevault-${crypto.randomBytes(12).toString('hex')}`;
      const challenge = crypto.randomBytes(32);
      const r = await this.hello.create(name, challenge, 'enable').catch(() => null);
      const drop = (e) => this.hello.remove(name).catch(() => {}).then(() => { throw e; });
      // No answer, a cancel or no key: a key may still have been made (late answer, sign failed) – it goes (Konrad).
      if (r?.status === HELLO_STATUS.canceled) return drop(fail('HelloCanceled', t('Windows Hello abgebrochen')));
      if (r?.status !== HELLO_STATUS.success || !r.signature) return drop(fail('HelloUnavailable', t('Windows Hello hat keinen Schlüssel angelegt')));
      if (!this.hello.attested(r.attestation)) {
        return drop(fail('HelloNoTpm', t('Windows Hello hält den Schlüssel auf diesem Gerät nicht im TPM – Entsperren mit Windows Hello ist hier nicht möglich')));
      }
      const before = await this.service.readRecord();
      let record;
      try {
        record = U.setHelloWrap(before, dk, { name, publicKey: r.publicKey, signature: Buffer.from(String(r.signature), 'base64'), challenge });
      } catch {
        return drop(fail('HelloSignature', t('Die Antwort von Windows Hello lässt sich nicht als Schlüssel verwenden – Entsperren mit Windows Hello ist hier nicht möglich')));
      }
      this.service.config.update({ unlockKeys: await this.service.stored(record) });
      if (before.hello?.name && before.hello.name !== name) await this.hello.remove(before.hello.name).catch(() => {});
      this.service.diag('UNLOCK windows hello on');
      return true;
    });
  }

  /** Off – with the MP (Konrad: removing Hello needs the MP). The key in the Hello container is deleted too. */
  async disable(password) {
    await this.service.verifyPasswordCounted(password);
    return this.drop('off');
  }

  /** Drops the wrapper and the key without asking: the organization forbids Hello, or the key no longer opens it. */
  async drop(why) {
    const record = await this.service.readRecord();
    if (!record?.hello) return false;
    this.service.config.update({ unlockKeys: await this.service.stored(U.dropWrap(record, 'hello')) });
    await this.hello.remove(record.hello.name).catch(() => {});
    this.service.diag(`UNLOCK windows hello removed (${why})`);
    return true;
  }

  /** Hello forbidden by the organization → the wrapper and the key go at the next look at Hello (policy WindowHello = 0). */
  async enforcePolicy() {
    if (!this.hello.allowed()) await this.drop('policy').catch(() => {});
  }

  /**
   * Windows Hello signs the stored challenge → DK, or throws: HelloCanceled (counts nothing), HelloUnavailable, HelloReset
   * (the wrapper went; the MP is asked). Nothing else changes here.
   */
  async proveDk(purpose = 'unlock') {
    await this.enforcePolicy();
    const record = await this.service.readRecord();
    if (!record?.hello) throw fail('HelloOff', t('Windows Hello ist zum Entsperren nicht eingeschaltet – bitte das Masterpasswort eingeben'));
    await this.requireAvailable();
    return this.once(async () => {
      const r = await this.hello.sign(record.hello.name, U.helloChallenge(record), purpose).catch(() => null);
      if (r?.status === HELLO_STATUS.canceled) throw fail('HelloCanceled', t('Windows Hello abgebrochen – bitte das Masterpasswort eingeben'));
      if (r?.status === HELLO_STATUS.notFound) {
        await this.drop('key gone');
        throw fail('HelloReset', t('Windows Hello wurde auf diesem Gerät zurückgesetzt – bitte das Masterpasswort eingeben und Windows Hello danach neu einrichten'));
      }
      if (r?.status !== HELLO_STATUS.success || !r.signature) throw fail('HelloUnavailable', t('Windows Hello ist nicht verfügbar – bitte das Masterpasswort eingeben'));
      const dk = U.openWithHello(record, Buffer.from(String(r.signature), 'base64'));
      if (!dk) {
        await this.drop('signature no longer opens');
        throw fail('HelloReset', t('Windows Hello wurde auf diesem Gerät zurückgesetzt – bitte das Masterpasswort eingeben und Windows Hello danach neu einrichten'));
      }
      return dk;
    });
  }

  /** The lock screen: Hello instead of the MP – opens like the MP (personal vault, mirror, one unlock). */
  unlock(purpose = 'unlock') {
    // Konrad (review of stage 4): the Hello dialog runs outside the PIN queue; the wait check before it and the unlock
    // with DK after it run in the queue.
    const blocked = () => {
      const wait = this.service.guard.waitSeconds();
      if (wait) throw new Error(t('Zu viele falsche Versuche – bitte {seconds} Sekunden warten', { seconds: wait }));
    };
    return this.service.queue(async () => blocked()).then(async () => {
      const dk = await this.proveDk(purpose);
      return this.service.queue(async () => {
        blocked();
        return this.service.unlockWithDk(dk);
      });
    });
  }

  /**
   * #537 stage 4, unlockRequest of the browser extension (Konrad, reviews of the plan and of stage 4). A process of the
   * same user can reach the pipe claiming to be the extension, and Windows Hello names no purpose – so before every Hello
   * Keevault itself asks in a card of its own, "Browser-Erweiterung möchte entsperren", Zulassen/Ablehnen (no Enter, a
   * click delay); only "Zulassen" leads to Hello. Only with a Hello wrapper; one request at a time; a wait after a
   * refusal, a cancel, a timeout or Hello unavailable; at most EXTENSION_HELLO_MAX requests in EXTENSION_HELLO_WINDOW_MS
   * (then only the master password or the PIN). One diagnosis line per request, no secrets. The caller opens only the
   * extension's session – the window lock stays.
   */
  async unlockForExtension() {
    if (!this.service.config.get().unlockKeys?.hello || !this.hello.allowed()) {
      throw fail('HelloOff', t('Windows Hello ist zum Entsperren nicht eingeschaltet – bitte das Masterpasswort eingeben'));
    }
    const now = this.now();
    this.extensionRequests = (this.extensionRequests || []).filter((at) => now - at < EXTENSION_HELLO_WINDOW_MS);
    if (this.extensionRequests.length >= EXTENSION_HELLO_MAX) {
      this.service.diag('UNLOCK extension hello refused: limit');
      throw fail('HelloLimit', t('Zu viele Anfragen der Browser-Erweiterung – bitte mit Masterpasswort oder PIN entsperren'));
    }
    const wait = Math.ceil((this.extensionWaitUntil - now) / 1000);
    if (wait > 0) throw fail('HelloWait', t('Windows Hello wurde abgebrochen – bitte {seconds} Sekunden warten oder das Masterpasswort eingeben', { seconds: wait }));
    if (this.extensionBusy) throw fail('HelloBusy', t('Windows Hello fragt bereits'));
    this.extensionBusy = true;
    this.extensionRequests.push(now);
    this.service.diag('UNLOCK extension hello request');
    try {
      if (!(await Promise.resolve().then(() => this.hello.confirmExtension()).catch(() => false))) {
        this.service.diag('UNLOCK extension hello refused in Keevault');
        throw fail('HelloRefused', t('Entsperren in Keevault abgelehnt'));
      }
      const r = await this.unlock('extension');
      this.service.diag('UNLOCK extension hello unlocked');
      return r;
    } catch (e) {
      this.extensionWaitUntil = this.now() + EXTENSION_HELLO_WAIT_MS;
      if (e.name !== 'HelloRefused') this.service.diag(`UNLOCK extension hello failed: ${e.name}`);
      throw e;
    } finally {
      this.extensionBusy = false;
    }
  }
}
