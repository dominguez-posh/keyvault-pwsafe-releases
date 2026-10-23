// Passkeys as unlock method: WebAuthn with the PRF extension derives a stable secret per passkey.
// Runs in a page (extension page with RP ID = extension ID, desktop passkey window with RP ID "localhost").

import { b64uEncode, b64uDecode, randomBytes } from './util.js';
import { t } from './i18n.js';

function explain(e) {
  if (e?.name === 'NotAllowedError') return new Error(t('Passkey-Vorgang abgebrochen oder abgelaufen'));
  if (e?.name === 'InvalidStateError') return new Error(t('Dieser Passkey ist bereits registriert'));
  if (e?.name === 'SecurityError' || e?.name === 'NotSupportedError') return new Error(t('Passkeys sind hier nicht verfügbar ({message})', { message: e.message }));
  return e;
}

/** Evaluates PRF for one of the given passkeys: [{ credentialId, prfSalt }] → { credentialId, prfOutput }. */
export async function evaluatePrf(rpId, passkeys, { timeout = 120_000 } = {}) {
  if (!passkeys.length) throw new Error(t('Für diese App ist kein Passkey registriert'));
  let assertion;
  try {
    assertion = await navigator.credentials.get({
      publicKey: {
        rpId,
        challenge: randomBytes(32),
        userVerification: 'required',
        timeout,
        allowCredentials: passkeys.map((p) => ({ type: 'public-key', id: b64uDecode(p.credentialId) })),
        extensions: { prf: { evalByCredential: Object.fromEntries(passkeys.map((p) => [p.credentialId, { first: b64uDecode(p.prfSalt) }])) } },
      },
    });
  } catch (e) {
    throw explain(e);
  }
  const first = assertion.getClientExtensionResults().prf?.results?.first;
  if (!first) throw new Error(t('Der Passkey hat keinen Schlüssel geliefert (PRF wird nicht unterstützt)'));
  return { credentialId: b64uEncode(new Uint8Array(assertion.rawId)), prfOutput: b64uEncode(new Uint8Array(first)) };
}

/**
 * Registers a new passkey with PRF. Returns { credentialId, prfSalt, prfOutput, rpId }.
 * Some authenticators only return the PRF value on sign-in; then a second confirmation follows.
 */
export async function registerPrf(rpId, { userName, displayName, excludeCredentialIds = [], timeout = 120_000, attachment }) {
  const prfSalt = randomBytes(32);
  let credential;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId, name: 'Keevault' },
        user: { id: randomBytes(16), name: userName, displayName: displayName || userName },
        challenge: randomBytes(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged', authenticatorAttachment: attachment || undefined },
        excludeCredentials: excludeCredentialIds.map((id) => ({ type: 'public-key', id: b64uDecode(id) })),
        timeout,
        extensions: { prf: { eval: { first: prfSalt } } },
      },
    });
  } catch (e) {
    throw explain(e);
  }
  const ext = credential.getClientExtensionResults().prf;
  const credentialId = b64uEncode(new Uint8Array(credential.rawId));
  const salt = b64uEncode(prfSalt);
  const platform = credential.authenticatorAttachment === 'platform';
  if (ext?.results?.first) return { rpId, credentialId, prfSalt: salt, prfOutput: b64uEncode(new Uint8Array(ext.results.first)), platform };
  // Some platforms (Windows Hello) only report PRF on sign-in: try once before giving up.
  try {
    const r = await evaluatePrf(rpId, [{ credentialId, prfSalt: salt }], { timeout });
    return { rpId, credentialId, prfSalt: salt, prfOutput: r.prfOutput, platform };
  } catch (e) {
    if (ext?.enabled) throw e;
    throw new Error(t('Dieser Passkey unterstützt keine Schlüsselableitung (PRF). Nutze einen FIDO2-Sicherheitsschlüssel, Windows Hello (aktuelles Windows 11) oder ein Smartphone.'));
  }
}
