// Signed update manifests. scripts/release.ps1 signs latest.yml with the local update-key.pem (Ed25519,
// scripts/update-key.mjs) and uploads latest.yml.sig next to it; the app accepts a new version only when the
// manifest verifies against the public key below. That closes the update path against a compromised website or
// GitHub account – the installer hash in the manifest is checked by electron-updater against the download.
// No Electron import: the functions are also used by the signing script and the unit tests.

import crypto from 'node:crypto';

// Public key (SPKI, base64) of update-key.pem. Changing it means: apps in the field no longer accept new manifests
// until they are updated by hand – only ever replace it together with a planned key rotation.
export const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAzyObnVhVwNBBjNJ9A2LZw0OSVCvvzb76Aw9u/osUjnc=';

const publicKeyObject = (publicKey) => crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });

/** Ed25519 signature (base64) over the exact bytes of the manifest; privateKey: KeyObject or PEM. */
export function signManifest(manifest, privateKey) {
  const key = typeof privateKey === 'string' || Buffer.isBuffer(privateKey) ? crypto.createPrivateKey(privateKey) : privateKey;
  return crypto.sign(null, Buffer.from(manifest), key).toString('base64');
}

/** true only when the signature belongs to exactly these manifest bytes and the given public key. */
export function verifyManifest(manifest, signature, publicKey = UPDATE_PUBLIC_KEY) {
  try {
    if (!publicKey || !signature) return false;
    return crypto.verify(null, Buffer.from(manifest), publicKeyObject(publicKey), Buffer.from(String(signature).trim(), 'base64'));
  } catch {
    return false;
  }
}

/** version, installer hash and file name from latest.yml (electron-builder's generic provider format). */
export function parseManifest(manifest) {
  const text = String(manifest);
  return {
    version: /^version:\s*(\S+)/m.exec(text)?.[1] || '',
    sha512: /^\s+sha512:\s*(\S+)/m.exec(text)?.[1] || /^sha512:\s*(\S+)/m.exec(text)?.[1] || '',
    url: /^\s+-\s+url:\s*(\S+)/m.exec(text)?.[1] || /^path:\s*(\S+)/m.exec(text)?.[1] || '',
  };
}
