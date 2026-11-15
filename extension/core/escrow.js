// Asymmetric keyring entries (#537, Konrad): a recovery stick ("Wiederherstellung") and the break-glass stick of a vault.
// Each stick gets its own ECDH key pair (P-256). The private part is sealed with the stick's PRF output, the public part
// lies open in the keyring. So the container key can be wrapped for the stick WITHOUT the stick: a key change (#402)
// carries these entries over to the new key, and the break-glass stick in the safe never has to be fetched for it.
// Only the stick (PRF, user verification) opens its private part, and only that opens the wrapped container key.
// Pure WebCrypto, no packages: runs in the extension and in the desktop app.

import { b64uEncode, b64uDecode, bytesEqual, concat, utf8 } from './util.js';
// protect.js imports this module too; only functions cross, called at run time, so the cycle is harmless.
import { hkdf, seal, unseal } from './protect.js';
import { t } from './i18n.js';

export const ESCROW_ROLES = Object.freeze(['recovery', 'breakglass']);

const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
// Purpose-bound: the PRF output of a stick never doubles as the key of a normal passkey entry (kvpwsafe/passkey/v1).
const privKey = (prfOutput) => hkdf(prfOutput, 'kvpwsafe/escrow-priv/v1');
const privAad = (scope, credentialId) => `kvpwsafe/escrow-priv/${scope}/${credentialId}`;
const wrapInfo = (scope, id, kv) => `kvpwsafe/escrow-wrap/v1|${scope}|${id}|${kv}`;

const importPublic = (raw) => crypto.subtle.importKey('raw', raw, CURVE, true, []);

/** Shared secret → wrapping key; bound to both public keys, the vault, the entry and its key generation. */
async function wrapKey(shared, epk, pub, scope, id, kv) {
  return hkdf(concat(new Uint8Array(shared), epk, pub), wrapInfo(scope, id, kv));
}

/**
 * New key pair for a stick. stick: { credentialId, prfOutput } (PRF output of the ceremony that registers it).
 * → { pub, sealedPriv } – the fields an escrow entry keeps besides its wrapping.
 */
export async function createEscrowKeys(scope, { credentialId, prfOutput }) {
  if (!credentialId || !prfOutput) throw new Error(t('Der Sicherheitsschlüssel hat keine PRF-Ausgabe geliefert'));
  const pair = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const sealedPriv = await seal(await privKey(b64uDecode(prfOutput)), pkcs8, privAad(scope, credentialId));
  return { pub: b64uEncode(pub), sealedPriv };
}

/** Wraps raw (the container key) for the entry's public key: → { epk, wrapped }. Needs no stick. */
export async function wrapForEscrow(entry, scope, raw, aad) {
  const pub = b64uDecode(entry.pub);
  const recipient = await importPublic(pub); // refuses a point that is not on the curve
  const eph = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, eph.privateKey, 256);
  const kek = await wrapKey(shared, epk, pub, scope, entry.id, entry.kv || 1);
  return { epk: b64uEncode(epk), wrapped: await seal(kek, raw, aad) };
}

/**
 * Konrad H1: the fields of a stick entry, authenticated under the container key. The public part lies open in the
 * keyring – without this, whoever may only write the keyring could slip in their own public key and get the next key.
 */
async function macKey(ckRaw) {
  return crypto.subtle.importKey('raw', await hkdf(ckRaw, 'kvpwsafe/escrow-mac/v1'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
const macData = (scope, e) => utf8(JSON.stringify([scope, e.id, e.kv || 1, e.role, e.pub, e.sealedPriv, e.credentialId, e.rpId, e.prfSalt, e.createdBy || '']));

export async function escrowMac(ckRaw, scope, entry) {
  return b64uEncode(new Uint8Array(await crypto.subtle.sign('HMAC', await macKey(ckRaw), macData(scope, entry))));
}

/** Was this entry made by someone holding the container key? */
export async function escrowMacValid(ckRaw, scope, entry) {
  if (typeof entry?.mac !== 'string') return false;
  try {
    return bytesEqual(b64uDecode(entry.mac), b64uDecode(await escrowMac(ckRaw, scope, entry)));
  } catch {
    return false;
  }
}

/** The stick's PRF output opens its private part, that one the wrapped key. → raw key; throws on a wrong stick. */
export async function openEscrow(entry, scope, prfOutput, aad) {
  const pkcs8 = await unseal(await privKey(b64uDecode(prfOutput)), entry.sealedPriv, privAad(scope, entry.credentialId));
  const priv = await crypto.subtle.importKey('pkcs8', pkcs8, CURVE, false, ['deriveBits']);
  const epk = b64uDecode(entry.epk);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPublic(epk) }, priv, 256);
  const kek = await wrapKey(shared, epk, b64uDecode(entry.pub), scope, entry.id, entry.kv || 1);
  return unseal(kek, entry.wrapped, aad);
}
