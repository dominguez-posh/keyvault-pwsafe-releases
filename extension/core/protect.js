// Client-side encryption for containers ("extra protection" for Key Vault containers, always on for file
// containers). A random container key (AES-256-GCM) encrypts the entries; the keyring stores that key
// wrapped once per unlock method: master password (PBKDF2), passkeys (WebAuthn PRF), recovery key and
// one-time invitations for additional users. Each method unlocks on its own.

import { b64uEncode, b64uDecode, utf8, fromUtf8, concat, randomBytes } from './util.js';
import { t } from './i18n.js';

export const PBKDF2_ITERATIONS = 600_000;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export class UnlockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnlockError';
  }
}

export class ContainerLockedError extends Error {
  constructor(message = t('Dieser Tresor ist zusätzlich geschützt und gesperrt')) {
    super(message);
    this.name = 'ContainerLockedError';
  }
}

const importAes = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function hkdf(ikm, info) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(info) }, key, 256));
}

export async function seal(raw, plaintext, aad) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, await importAes(raw), plaintext);
  return b64uEncode(concat(iv, new Uint8Array(ct)));
}

export async function unseal(raw, sealed, aad) {
  const data = b64uDecode(sealed);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12), additionalData: utf8(aad) }, await importAes(raw), data.slice(12));
  return new Uint8Array(pt);
}

export async function passwordKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', utf8(String(password).normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256);
  return hkdf(new Uint8Array(bits), 'kvpwsafe/password/v1');
}

export const passkeyKey = (prfOutput) => hkdf(prfOutput, 'kvpwsafe/passkey/v1');
const codeKey = (bytes, kind) => hkdf(bytes, `kvpwsafe/${kind}/v1`);

/** Container key with a cached CryptoKey. */
export class ContainerKey {
  static async generate() {
    return ContainerKey.fromRaw(randomBytes(32));
  }

  static async fromRaw(raw) {
    const k = new ContainerKey();
    k.raw = raw instanceof Uint8Array ? raw : b64uDecode(raw);
    k.key = await importAes(k.raw);
    return k;
  }

  get exported() {
    return b64uEncode(this.raw);
  }

  async encrypt(text, aad) {
    const iv = randomBytes(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, this.key, utf8(text));
    return b64uEncode(concat(iv, new Uint8Array(ct)));
  }

  async decrypt(sealed, aad) {
    const data = b64uDecode(sealed);
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12), additionalData: utf8(aad) }, this.key, data.slice(12));
      return fromUtf8(new Uint8Array(pt));
    } catch {
      throw new Error(t('Daten lassen sich nicht entschlüsseln (beschädigt oder falscher Schlüssel)'));
    }
  }
}

// ---------------------------------------------------------------- codes (recovery key, invitations)

function base32(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text) {
    const i = BASE32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function formatCode(prefix, bytes) {
  return `${prefix}-${base32(bytes).match(/.{1,4}/g).join('-')}`;
}

function parseCode(code) {
  const clean = String(code || '').toUpperCase().replace(/^\s*(RK|IN)[-\s]*/, '').replace(/[^A-Z2-7]/g, '');
  return unbase32(clean);
}

// ---------------------------------------------------------------- keyring

const entryAad = (keyring, entry) => `kvpwsafe/keyring/${keyring.scope}/${entry.id}/${entry.type}`;
const now = () => new Date().toISOString();
const newId = () => b64uEncode(randomBytes(9));

/** New keyring for a container (scope = container ID) plus its fresh container key. */
export async function createKeyring(scope, actor = '') {
  const ck = await ContainerKey.generate();
  return { keyring: { v: 1, id: crypto.randomUUID(), scope, created: now(), createdBy: actor, entries: [], removed: [] }, ck };
}

async function addEntry(keyring, ck, entry, kek, replaceType) {
  const e = { id: newId(), created: now(), ...entry };
  e.wrapped = await seal(kek, ck.raw, entryAad(keyring, e));
  const kept = keyring.entries.filter((x) => !(replaceType && x.type === replaceType));
  const removed = keyring.entries.filter((x) => !kept.includes(x)).map((x) => x.id);
  return { ...keyring, entries: [...kept, e], removed: [...new Set([...(keyring.removed || []), ...removed])], updated: now() };
}

export async function setPassword(keyring, ck, password, actor = '') {
  if (String(password).length < 8) throw new Error(t('Das Masterpasswort muss mindestens 8 Zeichen lang sein'));
  const salt = randomBytes(16);
  const kek = await passwordKey(password, salt);
  return addEntry(keyring, ck, { type: 'password', salt: b64uEncode(salt), iterations: PBKDF2_ITERATIONS, createdBy: actor }, kek, 'password');
}

/** passkey: { credentialId, rpId, prfSalt, prfOutput, label } */
export async function addPasskey(keyring, ck, passkey, actor = '') {
  const kek = await passkeyKey(b64uDecode(passkey.prfOutput));
  return addEntry(keyring, ck, {
    type: 'passkey', credentialId: passkey.credentialId, rpId: passkey.rpId, prfSalt: passkey.prfSalt, label: passkey.label || '', createdBy: actor,
  }, kek);
}

export async function newRecoveryKey(keyring, ck, actor = '') {
  const secret = randomBytes(20);
  const next = await addEntry(keyring, ck, { type: 'recovery', createdBy: actor }, await codeKey(secret, 'recovery'), 'recovery');
  return { keyring: next, recoveryKey: formatCode('RK', secret) };
}

export async function createInvite(keyring, ck, { label = '', days = 7 } = {}, actor = '') {
  const secret = randomBytes(20);
  const expires = new Date(Date.now() + days * 86_400_000).toISOString();
  const next = await addEntry(keyring, ck, { type: 'invite', label, expires, createdBy: actor }, await codeKey(secret, 'invite'));
  return { keyring: next, inviteCode: formatCode('IN', secret), expires };
}

export function removeEntry(keyring, entryId) {
  const entries = keyring.entries.filter((e) => e.id !== entryId);
  if (!entries.some((e) => e.type === 'password' || e.type === 'passkey' || e.type === 'recovery')) {
    throw new Error(t('Mindestens ein Masterpasswort, ein Passkey oder ein Wiederherstellungsschlüssel muss bleiben'));
  }
  return { ...keyring, entries, removed: [...new Set([...(keyring.removed || []), entryId])], updated: now() };
}

async function tryEntries(keyring, entries, kekFor) {
  for (const e of entries) {
    try {
      const raw = await unseal(await kekFor(e), e.wrapped, entryAad(keyring, e));
      return { ck: await ContainerKey.fromRaw(raw), entry: e };
    } catch {
      // Wrong secret for this entry.
    }
  }
  return null;
}

export async function unlockWithPassword(keyring, password) {
  const entries = keyring.entries.filter((e) => e.type === 'password');
  if (!entries.length) throw new UnlockError(t('Für diesen Tresor ist kein Masterpasswort eingerichtet'));
  const r = await tryEntries(keyring, entries, (e) => passwordKey(password, b64uDecode(e.salt), e.iterations));
  if (!r) throw new UnlockError(t('Falsches Masterpasswort'));
  return r;
}

export async function unlockWithPasskey(keyring, credentialId, prfOutput) {
  const entries = keyring.entries.filter((e) => e.type === 'passkey' && e.credentialId === credentialId);
  const kek = await passkeyKey(b64uDecode(prfOutput));
  const r = await tryEntries(keyring, entries, async () => kek);
  if (!r) throw new UnlockError(t('Dieser Passkey passt nicht zu diesem Tresor'));
  return r;
}

/** Recovery key or invitation code. Returns { ck, entry } (entry.type tells which). */
export async function unlockWithCode(keyring, code) {
  const secret = parseCode(code);
  if (secret.length !== 20) throw new UnlockError(t('Ungültiger Code'));
  const entries = keyring.entries.filter((e) => e.type === 'recovery' || (e.type === 'invite' && new Date(e.expires) > new Date()));
  const r = await tryEntries(keyring, entries, (e) => codeKey(secret, e.type));
  if (!r) throw new UnlockError(t('Der Code passt nicht zu diesem Tresor oder ist abgelaufen'));
  return r;
}

/** Passkeys usable by a client (rpId), as needed for the PRF evaluation. */
export const passkeyEntries = (keyring, rpId) => keyring.entries
  .filter((e) => e.type === 'passkey' && e.rpId === rpId)
  .map((e) => ({ credentialId: e.credentialId, prfSalt: e.prfSalt }));

/** Public view of a keyring (no key material). */
export function describeKeyring(keyring, rpId) {
  const entries = keyring?.entries || [];
  return {
    password: entries.some((e) => e.type === 'password'),
    passwordId: entries.find((e) => e.type === 'password')?.id || null,
    recovery: entries.some((e) => e.type === 'recovery'),
    passkeys: entries.filter((e) => e.type === 'passkey').map((e) => ({
      id: e.id, label: e.label, rpId: e.rpId, usable: e.rpId === rpId, created: e.created, createdBy: e.createdBy,
    })),
    invites: entries.filter((e) => e.type === 'invite').map((e) => ({
      id: e.id, label: e.label, expires: e.expires, expired: new Date(e.expires) <= new Date(), created: e.created, createdBy: e.createdBy,
    })),
  };
}

/**
 * Applies a management operation to a keyring (needs the unlocked container key).
 * op: { type: 'setPassword', password } | { type: 'addPasskey', passkey } | { type: 'removeEntry', entryId }
 *   | { type: 'newRecovery' } | { type: 'createInvite', label, days }
 * Returns { keyring, recoveryKey?, inviteCode?, expires? }.
 */
export async function applyKeyringOp(keyring, ck, op, actor = '') {
  switch (op.type) {
    case 'setPassword':
      return { keyring: await setPassword(keyring, ck, op.password, actor) };
    case 'addPasskey':
      return { keyring: await addPasskey(keyring, ck, op.passkey, actor) };
    case 'removeEntry':
      return { keyring: removeEntry(keyring, op.entryId) };
    case 'newRecovery':
      return newRecoveryKey(keyring, ck, actor);
    case 'createInvite':
      return createInvite(keyring, ck, { label: op.label, days: op.days }, actor);
    default:
      throw new Error(`Unknown keyring operation ${op.type}`);
  }
}

/** New keyring with the chosen methods plus a recovery key: { keyring, ck, recoveryKey }. */
export async function setupKeyring(scope, { password, passkey }, actor = '') {
  if (!password && !passkey) throw new Error(t('Bitte ein Masterpasswort und/oder einen Passkey festlegen'));
  const created = await createKeyring(scope, actor);
  let keyring = created.keyring;
  if (password) keyring = await setPassword(keyring, created.ck, password, actor);
  if (passkey) keyring = await addPasskey(keyring, created.ck, passkey, actor);
  const r = await newRecoveryKey(keyring, created.ck, actor);
  return { keyring: r.keyring, ck: created.ck, recoveryKey: r.recoveryKey };
}

/** Unlock with { password } | { credentialId, prfOutput } | { code } → { ck, entry }. */
export function unlockKeyring(keyring, params) {
  if (params.password != null) return unlockWithPassword(keyring, params.password);
  if (params.prfOutput) return unlockWithPasskey(keyring, params.credentialId, params.prfOutput);
  return unlockWithCode(keyring, params.code);
}

/** Union of two keyring versions (concurrent edits by several users), honoring removals on both sides. */
export function mergeKeyrings(a, b) {
  if (!a) return b;
  if (!b) return a;
  const removed = new Set([...(a.removed || []), ...(b.removed || [])]);
  const byId = new Map();
  for (const e of [...b.entries, ...a.entries]) if (!removed.has(e.id)) byId.set(e.id, e);
  return { ...a, entries: [...byId.values()], removed: [...removed] };
}
