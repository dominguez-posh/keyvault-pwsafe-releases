// Software WebAuthn authenticator (passkey provider). Credentials are ES256 (P-256) keys whose
// private part is stored in the vault item; they are synced passkeys (BE/BS flags set, counter 0).

import { encode as cborEncode } from './cbor.js';
import { b64uEncode, b64uDecode, utf8, concat, randomBytes, sha256, fromHex } from './util.js';
import { t } from './i18n.js';

// Identifies "Keevault" as authenticator model towards relying parties.
export const AAGUID = fromHex('6b7670772d73616665a1c3e5f70d2b9e');
export const ES256 = -7;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

export class WebAuthnError extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

function isIpAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
}

// Validates the caller origin and returns the RP ID to use (WebAuthn §5.1.3 / §5.1.4 rules).
export function effectiveRpId(origin, requestedRpId) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new WebAuthnError('SecurityError', t('Ungültiger Ursprung'));
  }
  const host = url.hostname.toLowerCase();
  const localhost = host === 'localhost' || host.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) {
    throw new WebAuthnError('SecurityError', t('Passkeys erfordern HTTPS'));
  }
  if (isIpAddress(host)) throw new WebAuthnError('SecurityError', t('IP-Adressen sind als RP-ID nicht zulässig'));
  const rpId = (requestedRpId == null || requestedRpId === '' ? host : String(requestedRpId)).toLowerCase();
  if (rpId !== host && !host.endsWith('.' + rpId)) {
    throw new WebAuthnError('SecurityError', t('RP-ID „{rpId}“ gehört nicht zu {host}', { rpId, host }));
  }
  if (!rpId.includes('.') && rpId !== 'localhost') {
    throw new WebAuthnError('SecurityError', t('RP-ID „{rpId}“ ist keine registrierbare Domain', { rpId }));
  }
  return rpId;
}

// Fixed member order so that relying parties using the "limited verification" algorithm accept it.
export function buildClientDataJSON({ type, challenge, origin, crossOrigin = false, topOrigin }) {
  let json = `{"type":${JSON.stringify(type)},"challenge":${JSON.stringify(challenge)},` +
    `"origin":${JSON.stringify(origin)},"crossOrigin":${crossOrigin ? 'true' : 'false'}`;
  if (crossOrigin && topOrigin) json += `,"topOrigin":${JSON.stringify(topOrigin)}`;
  return json + '}';
}

function u32(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function coseEs256(rawPublicKey) {
  return cborEncode(new Map([
    [1, 2], // kty: EC2
    [3, ES256], // alg
    [-1, 1], // crv: P-256
    [-2, rawPublicKey.slice(1, 33)],
    [-3, rawPublicKey.slice(33, 65)],
  ]));
}

async function authenticatorData(rpId, flags, signCount, attested) {
  return concat(await sha256(utf8(rpId)), new Uint8Array([flags]), u32(signCount), attested ?? new Uint8Array(0));
}

// WebCrypto returns ECDSA signatures as r||s; WebAuthn (ES256) requires ASN.1 DER.
export function rawSignatureToDer(signature) {
  const integer = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.slice(i);
    if (v[0] & 0x80) v = concat(new Uint8Array([0]), v);
    return concat(new Uint8Array([0x02, v.length]), v);
  };
  const half = signature.length / 2;
  const r = integer(signature.slice(0, half));
  const s = integer(signature.slice(half));
  return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

export function normalizeChallenge(challenge) {
  return b64uEncode(b64uDecode(challenge));
}

export function supportsAlgorithms(pubKeyCredParams) {
  const params = Array.isArray(pubKeyCredParams) && pubKeyCredParams.length
    ? pubKeyCredParams
    : [{ type: 'public-key', alg: ES256 }];
  return params.some((p) => p.type === 'public-key' && p.alg === ES256);
}

/**
 * Authenticator part of a registration (also used for Windows/CTAP, where only the client data hash exists).
 * user.id is base64url. Returns { passkey, authData, spki }.
 */
export async function makeCredentialData({ rpId, rpName, user, pubKeyCredParams, userVerified = true }) {
  if (!supportsAlgorithms(pubKeyCredParams)) {
    throw new WebAuthnError('NotSupportedError', t('Die Website verlangt einen nicht unterstützten Algorithmus (nur ES256)'));
  }
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', keyPair.publicKey));
  const credentialId = randomBytes(16);
  const attested = concat(
    AAGUID,
    new Uint8Array([credentialId.length >> 8, credentialId.length & 0xff]),
    credentialId,
    coseEs256(rawPublic),
  );
  const flags = FLAG_UP | (userVerified ? FLAG_UV : 0) | FLAG_BE | FLAG_BS | FLAG_AT;
  const authData = await authenticatorData(rpId, flags, 0, attested);
  const passkey = {
    credentialId: b64uEncode(credentialId),
    rpId,
    rpName: rpName || rpId,
    userHandle: user.id,
    userName: user.name || '',
    userDisplayName: user.displayName || '',
    algorithm: ES256,
    privateKey: b64uEncode(pkcs8),
    publicKey: b64uEncode(spki),
    signCount: 0,
    discoverable: true,
    created: new Date().toISOString(),
  };
  return { passkey, authData, spki };
}

/** Authenticator part of a sign-in: { authData, signature (DER), signCount }. */
export async function signAssertionData({ rpId, clientDataHash, passkey, userVerified = true }) {
  if (passkey.rpId !== rpId) throw new WebAuthnError('SecurityError', t('Passkey gehört zu einer anderen Website'));
  if (passkey.algorithm != null && passkey.algorithm !== ES256) {
    throw new WebAuthnError('NotSupportedError', t('Algorithmus des Passkeys wird nicht unterstützt'));
  }
  // Synced passkeys use counter 0; imported ones that already count keep counting.
  const signCount = passkey.signCount > 0 ? passkey.signCount + 1 : 0;
  const flags = FLAG_UP | (userVerified ? FLAG_UV : 0) | FLAG_BE | FLAG_BS;
  const authData = await authenticatorData(rpId, flags, signCount);
  const key = await crypto.subtle.importKey(
    'pkcs8', b64uDecode(passkey.privateKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, concat(authData, clientDataHash)));
  return { authData, signature: rawSignatureToDer(raw), signCount };
}

/**
 * Creates a new passkey for a web page.
 * @returns {{ passkey: object, response: object }} passkey = record to store in the vault,
 *   response = PublicKeyCredential (registration) in JSON form.
 */
export async function createCredential({
  origin, rpId, rpName, user, challenge, pubKeyCredParams,
  crossOrigin = false, topOrigin, credProps = false, userVerified = true,
}) {
  const { passkey, authData, spki } = await makeCredentialData({ rpId, rpName, user, pubKeyCredParams, userVerified });
  const attestationObject = cborEncode(new Map([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authData],
  ]));
  const clientDataJSON = buildClientDataJSON({
    type: 'webauthn.create', challenge: normalizeChallenge(challenge), origin, crossOrigin, topOrigin,
  });
  const response = {
    id: passkey.credentialId,
    rawId: passkey.credentialId,
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: b64uEncode(utf8(clientDataJSON)),
      attestationObject: b64uEncode(attestationObject),
      authenticatorData: b64uEncode(authData),
      publicKey: b64uEncode(spki),
      publicKeyAlgorithm: ES256,
      transports: ['internal'],
    },
    clientExtensionResults: credProps ? { credProps: { rk: true } } : {},
  };
  return { passkey, response };
}

/**
 * Signs an assertion for a web page with a stored passkey.
 * @returns {{ response: object, signCount: number }} response = PublicKeyCredential (assertion) in JSON form.
 */
export async function getAssertion({
  origin, rpId, challenge, passkey, crossOrigin = false, topOrigin, userVerified = true,
}) {
  const clientDataJSON = buildClientDataJSON({
    type: 'webauthn.get', challenge: normalizeChallenge(challenge), origin, crossOrigin, topOrigin,
  });
  const { authData, signature, signCount } = await signAssertionData({
    rpId, clientDataHash: await sha256(utf8(clientDataJSON)), passkey, userVerified,
  });
  return {
    signCount,
    response: {
      id: passkey.credentialId,
      rawId: passkey.credentialId,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64uEncode(utf8(clientDataJSON)),
        authenticatorData: b64uEncode(authData),
        signature: b64uEncode(signature),
        userHandle: passkey.userHandle || null,
      },
      clientExtensionResults: {},
    },
  };
}

// Picks the passkeys usable for a request (allowCredentials empty = discoverable credentials).
export function filterPasskeys(passkeys, rpId, allowCredentialIds = []) {
  const allowed = new Set((allowCredentialIds || []).map((id) => b64uEncode(b64uDecode(id))));
  return passkeys.filter((p) => p.rpId === rpId && (allowed.size === 0 || allowed.has(p.credentialId)));
}
