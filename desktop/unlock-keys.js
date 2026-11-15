// #537: the device key DK and its wrappers. ONE master password (MP) for the whole app; on this device a random device
// key DK opens everything local (binding of the personal vault, offline mirror). DK is wrapped several times: with the
// MP (always), optionally with an app PIN, later with Windows Hello. Every check that used to compare a PIN hash now
// unwraps DK – a correct secret yields key material, not a yes. Pure Node, no Electron: the record is stored by
// desktop/main/unlock.js, additionally protected with DPAPI. Unit tests: test/unlock-keys-537.test.js.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { hashPin, isShortPin, MIN_PIN_LENGTH } from './pin.js';

const pbkdf2 = promisify(crypto.pbkdf2);

export const MP_MIN_LENGTH = 12;
export const PW_ITERATIONS = 600_000;
export const PIN_ITERATIONS = 310_000;
/** E6 (Konrad: own counter): after this many wrong PINs the PIN wrapper is deleted – then only the MP opens. */
export const PIN_WRAP_MAX_FAILURES = 10;
const PURPOSES = new Set(['check', 'personal', 'offline', 'settings', 'member-key']); // #539 H1: the device copy of the member keys
const DK_BYTES = 32;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (text) => Buffer.from(String(text || ''), 'base64');
const aadOf = (record, kind) => `keevault/unlock/${record.id}/${kind}`;

/** A fresh device key. */
export const newDk = () => crypto.randomBytes(DK_BYTES);

/** Key for one purpose, derived from DK – the parts never share a key (context: e.g. the vault id). */
export function subKey(dk, purpose, context = '') {
  if (!PURPOSES.has(purpose)) throw new Error(`unknown purpose ${purpose}`);
  return Buffer.from(crypto.hkdfSync('sha256', dk, Buffer.alloc(0), `keevault/dk/${purpose}/v1|${context}`, 32));
}

/** AES-256-GCM: iv ‖ ciphertext ‖ tag, base64. */
export function sealWith(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  return b64(Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]));
}

/** → Buffer, or null when key or data don't fit (GCM tag). */
export function openWith(key, sealed, aad) {
  const data = unb64(sealed);
  if (data.length < 28) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([d.update(data.subarray(12, data.length - 16)), d.final()]);
  } catch {
    return null;
  }
}

async function secretKey(secret, salt, iterations, kind) {
  const bits = await pbkdf2(String(secret).normalize('NFC'), salt, iterations, 32, 'sha256');
  return Buffer.from(crypto.hkdfSync('sha256', bits, Buffer.alloc(0), `keevault/unlock/${kind}/v1`, 32));
}

async function wrapSecret(record, dk, secret, iterations, kind) {
  const salt = crypto.randomBytes(16);
  const key = await secretKey(secret, salt, iterations, kind);
  return { salt: b64(salt), iterations, wrapped: sealWith(key, dk, aadOf(record, kind)), at: new Date().toISOString() };
}

async function unwrapSecret(record, kind, secret) {
  const w = record?.[kind];
  if (!w?.wrapped) return null;
  const key = await secretKey(secret, unb64(w.salt), w.iterations || (kind === 'pw' ? PW_ITERATIONS : PIN_ITERATIONS), kind);
  const dk = openWith(key, w.wrapped, aadOf(record, kind));
  return dk && dkMatches(record, dk) ? dk : null;
}

/** Does this DK belong to the record? (its check value) */
export function dkMatches(record, dk) {
  if (!record?.check || dk?.length !== DK_BYTES) return false;
  const ok = openWith(subKey(dk, 'check'), record.check, aadOf(record, 'check'));
  return !!ok && ok.toString() === 'ok';
}

/**
 * New record: DK wrapped with the MP. minLength: policy (MasterPasswordMinLength), at least MP_MIN_LENGTH. existing: the
 * MP is the one the personal vault's keyring already accepted (the keyring is the source of truth; its own minimum is 8).
 */
export async function createRecord(dk, password, { minLength = MP_MIN_LENGTH, existing = false } = {}) {
  const min = existing ? 8 : Math.max(MP_MIN_LENGTH, Number(minLength) || 0);
  if (String(password ?? '').length < min) throw new Error(`MP_TOO_SHORT:${min}`);
  const record = { v: 1, id: crypto.randomBytes(12).toString('base64url'), created: new Date().toISOString() };
  record.check = sealWith(subKey(dk, 'check'), Buffer.from('ok'), aadOf(record, 'check'));
  record.pw = await wrapSecret(record, dk, password, PW_ITERATIONS, 'pw');
  return record;
}

/** PIN wrapper (optional; replaces an earlier one, its counter starts at 0). */
export async function setPinWrap(record, dk, pin) {
  if (!dkMatches(record, dk)) throw new Error('DK_MISMATCH');
  if (isShortPin(pin)) throw new Error(`PIN_TOO_SHORT:${MIN_PIN_LENGTH}`);
  return { ...record, pin: { ...(await wrapSecret(record, dk, pin, PIN_ITERATIONS, 'pin')), failures: 0 } };
}

/** The record without one wrapper ('pin' | 'hello'); the MP wrapper never goes. */
export function dropWrap(record, kind) {
  if (kind === 'pw') throw new Error('the MP wrapper stays');
  const { [kind]: _gone, ...rest } = record;
  return rest;
}

/** MP → DK or null. */
export const openWithPassword = (record, password) => unwrapSecret(record, 'pw', password);

/**
 * PIN → { dk, record }: dk null when wrong. The record carries the PIN's own counter (E6): reset by a correct PIN only,
 * and the PIN wrapper is gone after PIN_WRAP_MAX_FAILURES wrong ones. The caller stores the record it gets back.
 */
export async function openWithPin(record, pin) {
  if (!record?.pin) return { dk: null, record, gone: true };
  const dk = await unwrapSecret(record, 'pin', pin);
  if (dk) return { dk, record: record.pin.failures ? { ...record, pin: { ...record.pin, failures: 0 } } : record };
  const failures = (Number(record.pin.failures) || 0) + 1;
  if (failures >= PIN_WRAP_MAX_FAILURES) return { dk: null, record: dropWrap(record, 'pin'), gone: true };
  return { dk: null, record: { ...record, pin: { ...record.pin, failures } } };
}

// ---------------------------------------------------------------- Windows Hello (stage 3 uses it; Konrad: PKCS#1 v1.5 checked)

/**
 * Hello signature → key. The signature is verified first as RSASSA-PKCS1-v1_5/SHA-256 over the stored challenge with the
 * stored public key (RSA, at least 2048 bit): an answer that is no valid signature of our key never becomes key material.
 */
function helloKey(hello, signature) {
  const pub = crypto.createPublicKey({ key: unb64(hello.publicKey), format: 'der', type: 'spki' });
  if (pub.asymmetricKeyType !== 'rsa' || (pub.asymmetricKeyDetails?.modulusLength || 0) < 2048) return null;
  const sig = Buffer.from(signature);
  const ok = crypto.verify('sha256', unb64(hello.challenge), { key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, sig);
  if (!ok) return null;
  return Buffer.from(crypto.hkdfSync('sha256', crypto.createHash('sha256').update(sig).digest(), Buffer.alloc(0), 'keevault/hello/v1', 32));
}

/** hello: { name, publicKey (SPKI DER, base64), signature (Buffer), challenge (Buffer) } – the challenge is stored. */
export function setHelloWrap(record, dk, { name, publicKey, signature, challenge }) {
  if (!dkMatches(record, dk)) throw new Error('DK_MISMATCH');
  const hello = { name: String(name || ''), publicKey: String(publicKey || ''), challenge: b64(challenge) };
  const key = helloKey(hello, signature);
  if (!key) throw new Error('HELLO_SIGNATURE');
  return { ...record, hello: { ...hello, wrapped: sealWith(key, dk, aadOf(record, 'hello')), at: new Date().toISOString() } };
}

/** The challenge the helper signs for this record (null without Hello). */
export const helloChallenge = (record) => (record?.hello ? unb64(record.hello.challenge) : null);

/** Hello signature → DK or null (wrong key, reset container, not a valid signature). */
export function openWithHello(record, signature) {
  if (!record?.hello) return null;
  let key;
  try { key = helloKey(record.hello, signature); } catch { return null; }
  const dk = key && openWith(key, record.hello.wrapped, aadOf(record, 'hello'));
  return dk && dkMatches(record, dk) ? dk : null;
}

// ---------------------------------------------------------------- moving from the app PIN (E3: never an MP hash)

/**
 * E3: what `appPin` holds after the move. An older app version reads only appPin: with the user's old PIN hash it keeps
 * asking that PIN; without a PIN before, a hash of a random value nobody knows – an older app never opens unchecked.
 * Never a hash of the MP (Konrad): a cheaper second verifier of the MP would weaken it.
 */
export async function legacyAppPin(previous) {
  if (previous?.hash && previous?.salt) return previous;
  return { ...(await hashPin(crypto.randomBytes(32).toString('base64'))), random: true };
}

/**
 * The one settings patch of the move (Konrad: atomic). Everything that changes goes into ONE write: the new record,
 * the device bindings of the personal vaults re-wrapped for DK, appPin per E3 and the counter. Before that write
 * nothing has changed; after it everything has.
 */
export async function migrationPatch({ previousAppPin, appPin = null, unlockKeys, personalDeviceKeys }) {
  if (!unlockKeys?.blob) throw new Error('no record');
  // appPin: chosen by the caller (N1: the hash of the PIN that unlocks, else random); by default per E3.
  return { unlockKeys, personalDeviceKeys: { ...(personalDeviceKeys || {}) }, appPin: appPin || await legacyAppPin(previousAppPin), pinGuard: null };
}
