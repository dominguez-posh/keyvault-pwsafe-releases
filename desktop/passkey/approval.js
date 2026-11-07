// Release approval in the passkey window (#378, #417): registers a hardware key / Windows Hello as release approver
// and answers the approval request with a WebAuthn assertion over the release challenge. Plain WebAuthn without PRF,
// a separate authenticator from the one that unlocks vaults. The window is only a carrier: the main process builds the
// challenge from the manifest bytes it hashed itself and verifies the answer before anything is signed.

import { b64uDecode, b64uEncode, randomBytes } from '../../extension/core/util.js';

const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));

/** Registers an approver: ES256 only, no resident key, no extension. → { credentialId, publicKey, authData, attachment } */
export async function registerApprover({ label, timeout }) {
  const credential = await navigator.credentials.create({
    publicKey: {
      rp: { id: 'localhost', name: 'Keevault' },
      user: { id: randomBytes(16), name: label, displayName: label },
      challenge: randomBytes(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged', authenticatorAttachment: 'cross-platform' },
      attestation: 'none',
      extensions: { prf: {} },
      timeout,
    },
  });
  return {
    credentialId: b64uEncode(new Uint8Array(credential.rawId)),
    publicKey: b64(credential.response.getPublicKey()),
    authData: b64(credential.response.getAuthenticatorData()),
    attachment: credential.authenticatorAttachment || '',
    prfEnabled: credential.getClientExtensionResults().prf?.enabled === true,
  };
}

/**
 * Assertion for the given challenge (base64url) from one of the registered credentials [{ credentialId, prfSalt }], with the
 * credential's PRF output (the secret that opens the wrapped signing key). → { credentialId, authData, clientDataJSON, signature, prfOutput }
 */
export async function assertApproval({ challenge, credentials, timeout }) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      rpId: 'localhost',
      challenge: b64uDecode(challenge),
      userVerification: 'required',
      allowCredentials: credentials.map((c) => ({ type: 'public-key', id: b64uDecode(c.credentialId) })),
      extensions: { prf: { evalByCredential: Object.fromEntries(credentials.map((c) => [c.credentialId, { first: b64uDecode(c.prfSalt) }])) } },
      timeout,
    },
  });
  const prf = assertion.getClientExtensionResults().prf?.results?.first;
  if (!prf) throw new Error('Der Sicherheitsschlüssel liefert kein hmac-secret (PRF).');
  return {
    credentialId: b64uEncode(new Uint8Array(assertion.rawId)),
    authData: b64(assertion.response.authenticatorData),
    clientDataJSON: b64(assertion.response.clientDataJSON),
    signature: b64(assertion.response.signature),
    prfOutput: b64(prf),
  };
}
