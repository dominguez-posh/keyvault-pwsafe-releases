// The release signing key (#378, phase 1: software key). Ed25519, created here, kept only as an encrypted record
// (Electron safeStorage, injected). The private key is decrypted for the moment of one signature and never returned,
// logged or written anywhere else.
//
// Without an approver (phase 1 as Lucas accepted it) the record holds the key itself: it protects against theft of a
// file and against GitHub, not against another process of the same Windows account, which can decrypt the record
// (DPAPI) and sign without dialog or touch.
//
// With a registered approver (a FIDO2 hardware key, B1/B2 of the review) the key is wrapped: AES-256-GCM under a key
// derived from the approver's PRF/hmac-secret output, which the hardware key releases only on a touch. The record then
// holds no usable key; another process of the account has the ciphertext, not the secret. A new approver is added only
// with the assertion of an existing one, and only a cross-platform key counts (no Windows Hello, no synced passkey, no
// passkey of Keevault itself). #417 therefore protects against GUI control of the dialog only once an approver exists.
//
// No Electron import: encrypt/decrypt come from the caller. Only desktop/main/release-sign.js uses this module
// (npm run check enforces it).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AAGUID } from '../extension/core/webauthn.js';
import { verifyManifest, signManifest, releaseChallenge } from './update-verify.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

/**
 * A credential may become an approver only when it is a real, separate authenticator: cross-platform (a security key),
 * not Keevault's own passkey provider, no synced/backed-up passkey (flags BE/BS), user presence set, ES256.
 */
export function checkApproverCredential({ authData, publicKey, attachment }) {
  if (attachment !== 'cross-platform') throw new Error('Als Freigeber zählt nur ein FIDO2-Sicherheitsschlüssel (USB, NFC), kein Windows Hello und kein Smartphone-Passkey.');
  const data = Buffer.from(authData || '');
  if (data.length < 55) throw new Error('Unvollständige Antwort des Sicherheitsschlüssels.');
  const flags = data[32];
  if (!(flags & 0x01)) throw new Error('Der Sicherheitsschlüssel wurde nicht berührt.');
  if (!(flags & 0x40)) throw new Error('Keine Schlüsseldaten in der Antwort.');
  if (flags & 0x18) throw new Error('Dieser Passkey wird gesichert oder synchronisiert (Software) – für Releases nur ein Hardware-Schlüssel.');
  if (!(flags & 0x04)) throw new Error('Der Sicherheitsschlüssel hat keine PIN abgefragt – für Releases ist die PIN Pflicht (erst eine PIN am Schlüssel setzen).');
  if (hex(data.subarray(37, 53)) === hex(AAGUID)) throw new Error('Das ist ein Passkey von Keevault selbst – für Releases nicht erlaubt.');
  const key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('Der Schlüssel muss ES256 (P-256) sein.');
}

const b64 = (x) => Buffer.from(x).toString('base64');

function wrapKeyFrom(prfOutput, credentialId) {
  const secret = Buffer.from(String(prfOutput || ''), 'base64');
  if (secret.length !== 32) throw new Error('Der Sicherheitsschlüssel hat kein hmac-secret (PRF) geliefert.');
  return Buffer.from(crypto.hkdfSync('sha256', secret, 'keevault-release-wrap-v1', credentialId, 32));
}
function wrap(plain, prfOutput, credentialId) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKeyFrom(prfOutput, credentialId), iv);
  cipher.setAAD(Buffer.from(credentialId));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), ct: b64(ct) };
}
function unwrap(w, prfOutput, credentialId) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', wrapKeyFrom(prfOutput, credentialId), Buffer.from(w.iv, 'base64'));
    decipher.setAAD(Buffer.from(credentialId));
    decipher.setAuthTag(Buffer.from(w.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(w.ct, 'base64')), decipher.final()]);
  } catch {
    throw new Error('Der Schlüssel lässt sich mit dieser Antwort des Sicherheitsschlüssels nicht öffnen.');
  }
}

const approverEntry = (credential, number, pkcs8) => ({
  id: `approver-${number}`, alg: 'es256', publicKey: credential.publicKey, credentialId: credential.credentialId,
  prfSalt: credential.prfSalt, wrapped: wrap(pkcs8, credential.prfOutput, credential.credentialId),
});

/** The element for UPDATE_KEYS (desktop/update-verify.js) that makes this approver's signatures count: public parts only. */
export const updateKeyElement = (approver, number) => ({ id: `release-${number}`, alg: 'es256', publicKey: approver.publicKey, credentialId: approver.credentialId });

/** The same as source text, ready to paste into UPDATE_KEYS. */
export const updateKeyLine = (approver, number) => {
  const e = updateKeyElement(approver, number);
  return `  { id: '${e.id}', alg: 'es256', publicKey: '${e.publicKey}', credentialId: '${e.credentialId}' },`;
};

/** The bytes an existing approver signs to let a new one in: bound to exactly this credential and key. */
export const addApproverBytes = ({ credentialId, publicKey }) => Buffer.from(`add-approver|${credentialId}|${publicKey}`);

export function createKeyStore({ file, encrypt, decrypt }) {
  // encrypt/decrypt may be asynchronous (Electron's async safeStorage); both return the plain value.
  const load = async () => {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(await decrypt(fs.readFileSync(file)));
  };
  const save = async (record) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, await encrypt(JSON.stringify(record)), { mode: 0o600 });
  };
  const sameSite = (record, credentialId) => record.approvers.find((a) => a.credentialId === credentialId);
  /** PKCS#8 of the signing key: plain in phase 1, otherwise unwrapped with the PRF output of the approver who answered. */
  const privateKeyOf = (record, proof) => {
    if (!record.approvers.length) return Buffer.from(record.pkcs8, 'base64');
    const approver = sameSite(record, proof?.credentialId);
    if (!approver) throw new Error('Die Freigabe mit dem Sicherheitsschlüssel fehlt.');
    return unwrap(approver.wrapped, proof.prfOutput, approver.credentialId);
  };
  return {
    hasKey: () => fs.existsSync(file),
    /**
     * Creates the key once; → the public key to put into UPDATE_KEYS. With first (the credential of the first approver,
     * C4) the key exists only wrapped from its first moment: no plain copy is ever stored. Without it (phase 1) the record
     * holds the key itself, and a key from that phase is replaced after phase 1 (docs/RELEASE.md).
     */
    async generate(first) {
      if (fs.existsSync(file)) throw new Error('Es gibt bereits einen Signierschlüssel.');
      if (first) checkApproverCredential(first);
      const pair = crypto.generateKeyPairSync('ed25519');
      const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
      if (!first) {
        await save({ pkcs8: pkcs8.toString('base64'), publicKey, approvers: [] });
        return publicKey;
      }
      const record = { publicKey, approvers: [approverEntry(first, 1, pkcs8)] };
      if (!unwrap(record.approvers[0].wrapped, first.prfOutput, first.credentialId).equals(pkcs8)) throw new Error('Der Schlüssel lässt sich nicht wieder öffnen – nichts gespeichert.');
      await save(record);
      return publicKey;
    },
    async publicKey() {
      return (await load())?.publicKey || null;
    },
    /** Public parts of the registered approvers: [{ id, alg: 'es256', publicKey, credentialId, prfSalt }] (never the wrapped key). */
    async approvers() {
      return ((await load())?.approvers || []).map(({ wrapped, ...open }) => open);
    },
    /**
     * credential: { credentialId, publicKey, authData, attachment, prfSalt, prfOutput } of the new key (its PRF output
     * from a sign-in, so that the signing key can be wrapped for it). proof: { assertion, credentialId, prfOutput } of an
     * existing approver over addApproverBytes(credential) – required as soon as one exists, the first needs none.
     */
    async addApprover(credential, proof, origin) {
      checkApproverCredential(credential);
      const r = await load();
      if (!r) throw new Error('Kein Signierschlüssel vorhanden.');
      if (sameSite(r, credential.credentialId)) throw new Error('Dieser Sicherheitsschlüssel ist schon eingetragen.');
      let pkcs8;
      if (!r.approvers.length) {
        pkcs8 = Buffer.from(r.pkcs8, 'base64');
      } else {
        const existing = sameSite(r, proof?.credentialId);
        if (!existing || !proof.assertion || !verifyManifest(addApproverBytes(credential), proof.assertion, [existing], origin)) {
          throw new Error('Einen weiteren Freigeber trägt nur ein vorhandener Freigeber ein: Berührung des bisherigen Schlüssels fehlt.');
        }
        pkcs8 = unwrap(existing.wrapped, proof.prfOutput, existing.credentialId);
      }
      const entry = approverEntry(credential, r.approvers.length + 1, pkcs8);
      // The wrapped copy must open again with the same secret before the plain copy goes (C2).
      if (!unwrap(entry.wrapped, credential.prfOutput, credential.credentialId).equals(pkcs8)) throw new Error('Der Schlüssel lässt sich nicht wieder öffnen – nichts gespeichert.');
      r.approvers.push(entry);
      delete r.pkcs8; // from now on only the wrapped copies exist
      await save(r);
    },
    /**
     * Signature (base64) over exactly these manifest bytes. With approvers registered, proof = { assertion, credentialId,
     * prfOutput }: a valid WebAuthn assertion (JSON) of that approver for the release challenge of these bytes, and its
     * PRF output, which opens the wrapped key. Without both nothing is signed.
     */
    async sign(manifest, proof, origin) {
      const r = await load();
      if (!r) throw new Error('Kein Signierschlüssel vorhanden.');
      if (r.approvers.length) {
        const approver = sameSite(r, proof?.credentialId);
        if (!approver || !proof.assertion || !verifyManifest(manifest, proof.assertion, [approver], origin)) {
          throw new Error('Die Freigabe mit dem Sicherheitsschlüssel fehlt oder passt nicht zu diesem Release.');
        }
      }
      return signManifest(manifest, crypto.createPrivateKey({ key: privateKeyOf(r, proof), format: 'der', type: 'pkcs8' }));
    },
    /**
     * Phase 2: the signature of a release is the approver's own WebAuthn assertion over the release challenge of these
     * bytes (latest.yml.sig2). Nothing is signed with a software key. Returns the assertion text once it verifies against
     * the registered approver who answered; otherwise throws.
     */
    async attest(manifest, proof, origin) {
      const r = await load();
      if (!r?.approvers.length) throw new Error('Es ist noch kein Sicherheitsschlüssel als Freigeber eingetragen. Erst „Release-Schlüssel einrichten“.');
      const approver = sameSite(r, proof?.credentialId);
      if (!approver || !proof.assertion || !verifyManifest(manifest, proof.assertion, [approver], origin)) {
        throw new Error('Die Freigabe mit dem Sicherheitsschlüssel fehlt oder passt nicht zu diesem Release.');
      }
      return proof.assertion;
    },
    challenge: releaseChallenge,
  };
}
