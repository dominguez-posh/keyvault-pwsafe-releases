// Signed update manifests. scripts/release.ps1 signs latest.yml with the local update-key.pem (Ed25519,
// scripts/update-key.mjs) and uploads latest.yml.sig next to it; the app accepts a new version only when the
// manifest verifies against the public key below. That closes the update path against a compromised website or
// GitHub account – the installer hash in the manifest is checked by electron-updater against the download.
// No Electron import: the functions are also used by the signing script and the unit tests.

import crypto from 'node:crypto';

// Trusted public keys (SPKI, base64) with their algorithm. Today one software key (update-key.pem); a key rotation or
// the switch to FIDO2 hardware keys (alg 'es256') adds entries instead of rebuilding the check. Changing the list means:
// apps in the field no longer accept new manifests signed only with a key they do not know – only ever change it
// together with a planned key rotation (docs/RELEASE.md).
export const UPDATE_KEYS = [
  { id: 'update-1', alg: 'ed25519', publicKey: 'MCowBQYDK2VwAyEAzyObnVhVwNBBjNJ9A2LZw0OSVCvvzb76Aw9u/osUjnc=' },
];
export const UPDATE_PUBLIC_KEY = UPDATE_KEYS[0].publicKey;

const publicKeyObject = (publicKey) => crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
const asKeyList = (keys) => (typeof keys === 'string' ? [{ alg: 'ed25519', publicKey: keys }] : Array.isArray(keys) ? keys : []);

/** Ed25519 signature (base64) over the exact bytes of the manifest; privateKey: KeyObject or PEM. */
export function signManifest(manifest, privateKey) {
  const key = typeof privateKey === 'string' || Buffer.isBuffer(privateKey) ? crypto.createPrivateKey(privateKey) : privateKey;
  return crypto.sign(null, Buffer.from(manifest), key).toString('base64');
}

// ---- Hardware key (FIDO2, ES256): the "signature" is a WebAuthn assertion over a challenge derived from the manifest.
export const WEBAUTHN_RP_ID = 'localhost';
export const WEBAUTHN_ORIGIN = 'http://localhost'; // origin of the app's passkey window (desktop/main/passkey-window.js)
const CHALLENGE_PREFIX = 'keevault-release-v1';

/** The challenge a hardware key signs for these manifest bytes: SHA-256("keevault-release-v1" || bytes), base64url. */
export function releaseChallenge(manifest) {
  return crypto.createHash('sha256').update(CHALLENGE_PREFIX).update(Buffer.from(manifest)).digest('base64url');
}

/** Assertion as stored in latest.yml.sig2: JSON with base64 authData, clientDataJSON and DER signature. */
export function encodeAssertion({ authData, clientDataJSON, signature }) {
  const b64 = (x) => Buffer.from(x).toString('base64');
  return JSON.stringify({ alg: 'es256', authData: b64(authData), clientDataJSON: b64(clientDataJSON), signature: b64(signature) });
}

function verifyAssertion(manifest, signature, publicKey, origin) {
  const a = JSON.parse(signature);
  if (a.alg !== 'es256') return false;
  const authData = Buffer.from(a.authData, 'base64');
  const clientDataJSON = Buffer.from(a.clientDataJSON, 'base64');
  if (authData.length < 37) return false;
  const client = JSON.parse(clientDataJSON.toString('utf8'));
  if (client.type !== 'webauthn.get' || client.crossOrigin === true) return false;
  if (client.origin !== origin) return false;
  if (client.challenge !== releaseChallenge(manifest)) return false;
  const rpIdHash = crypto.createHash('sha256').update(WEBAUTHN_RP_ID).digest();
  if (!crypto.timingSafeEqual(authData.subarray(0, 32), rpIdHash)) return false;
  if (!(authData[32] & 0x01)) return false; // user presence: the key was touched
  if (!(authData[32] & 0x04)) return false; // user verification: the PIN was asked (C2)
  if (authData[32] & 0x18) return false; // backup eligible / backed up: a synced passkey is software, not the hardware key
  const signed = Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]);
  return crypto.verify('sha256', signed, publicKeyObject(publicKey), Buffer.from(a.signature, 'base64'));
}

/**
 * true only when the signature belongs to exactly these manifest bytes and one of the given keys (default: the embedded
 * list). ed25519: base64 signature over the bytes; es256: WebAuthn assertion (JSON) over the release challenge.
 * origin: only for tests, the app always expects its passkey window's origin.
 */
export function verifyManifest(manifest, signature, keys = UPDATE_KEYS, origin = WEBAUTHN_ORIGIN) {
  if (!signature) return false;
  const text = String(signature).trim();
  return asKeyList(keys).some((k) => {
    try {
      if (!k?.publicKey) return false;
      if (k.alg === 'ed25519') return !text.startsWith('{') && crypto.verify(null, Buffer.from(manifest), publicKeyObject(k.publicKey), Buffer.from(text, 'base64'));
      if (k.alg === 'es256') return text.startsWith('{') && verifyAssertion(manifest, text, k.publicKey, origin);
      return false;
    } catch {
      return false;
    }
  });
}

/**
 * version, installer hash, file name and release notes from latest.yml (electron-builder's generic provider format).
 * notes: the "releaseNotes: |" block that scripts/release-notes.mjs appends from CHANGELOG.md – part of the signed
 * bytes, so the text shown in the update dialog cannot be altered on the server either.
 */
export function parseManifest(manifest) {
  const text = String(manifest);
  const block = /^releaseNotes:\s*\|-?[ \t]*\r?\n((?:(?:[ \t]+[^\n]*)?\r?\n)*)/m.exec(text)?.[1] || '';
  return {
    version: /^version:\s*(\S+)/m.exec(text)?.[1] || '',
    sha512: /^\s+sha512:\s*(\S+)/m.exec(text)?.[1] || /^sha512:\s*(\S+)/m.exec(text)?.[1] || '',
    url: /^\s+-\s+url:\s*(\S+)/m.exec(text)?.[1] || /^path:\s*(\S+)/m.exec(text)?.[1] || '',
    notes: block.split(/\r?\n/).map((l) => l.replace(/^ {2}/, '')).join('\n').trim(),
  };
}
