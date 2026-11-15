// #537: simulated Windows Hello key for smoke runs and unit tests – never a real Windows dialog in a test. The mode comes
// from KVPWSAFE_TEST_HELLO (read on every call, so a smoke area can switch it); desktop/main/hello-key.js uses this only
// when the app runs as a smoke test.
//   sign[:<anything>]  works: an RSA key per name, PKCS#1 v1.5 signatures (deterministic, like a TPM key)
//   cancel             the user cancels the dialog
//   unavailable        Windows Hello not set up
//   remote             remote desktop session
//   random             signatures change every time (RSA-PSS): setting up must refuse
//   reset              the key answers with another key's signature (Hello container reset): the wrapper must go
//   noattest           no TPM attestation (software key): setting up must refuse
//   gone               the key is not found any more

import crypto from 'node:crypto';
import { HELLO_STATUS } from './unlock-hello.js';

// Dialogs "shown" by every simulation in this process – the smoke checks one per use (it may not import the main modules).
let shown = 0;
export const simulatedDialogs = () => shown;

// The small "Keevault: Bestätige mit Windows Hello für …" windows a smoke run would have shown (desktop/main/hello-window.js).
const owners = [];
export const noteHelloOwner = (o) => { owners.push(o); };
export const helloOwnersNoted = () => owners.slice();
// Keevault's own cards before an unlock for the browser extension (desktop/main/hello-key.js).
const cards = [];
export const noteExtensionCard = (c) => { cards.push(c); };
export const extensionCardsNoted = () => cards.slice();

export class SimulatedHello {
  constructor(mode = () => process.env.KVPWSAFE_TEST_HELLO || '') {
    this.mode = () => String(mode() || '').split(':')[0];
    this.keys = new Map();
    this.asked = 0; // dialogs "shown" by this one
  }

  async status() {
    const m = this.mode();
    return { supported: !!m && m !== 'unavailable', remote: m === 'remote' };
  }

  signWith(key, challenge) {
    if (this.mode() === 'random') return crypto.sign('sha256', challenge, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING }).toString('base64');
    return crypto.sign('sha256', challenge, { key, padding: crypto.constants.RSA_PKCS1_PADDING }).toString('base64');
  }

  async create(name, challenge) {
    this.asked += 1;
    shown += 1;
    if (this.mode() === 'cancel') return { status: HELLO_STATUS.canceled };
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.keys.set(name, privateKey);
    return {
      status: HELLO_STATUS.success,
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      signature: this.signWith(privateKey, challenge),
      attestation: this.mode() === 'noattest' ? { status: 2 } : { status: 0, simulated: true },
    };
  }

  async sign(name, challenge) {
    this.asked += 1;
    shown += 1;
    const m = this.mode();
    if (m === 'cancel') return { status: HELLO_STATUS.canceled };
    if (m === 'gone' || !this.keys.has(name)) return { status: HELLO_STATUS.notFound };
    const key = m === 'reset' ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey : this.keys.get(name);
    return { status: HELLO_STATUS.success, signature: this.signWith(key, challenge) };
  }

  async remove(name) {
    this.keys.delete(name);
    return { status: 0 };
  }
}
