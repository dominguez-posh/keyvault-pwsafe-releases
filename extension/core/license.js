// Licensing per vault: without a license a vault holds up to FREE_LIMIT entries. A license is bound to the vault
// (Key Vault name, or the ID of a file vault) and signed with the publisher's Ed25519 key; the app only knows the
// public key. Vault names are globally unique, so a license key cannot be reused for another vault.
//
//   request code  KVP-XXXX-XXXX-XXXX-XXXX-XXXX  = base32(SHA-256("kvpwsafe-license-v1|" + vault)) + checksum
//   license key   KVPL-<payload>.<signature>  payload = { v, code, vault, issued, to }, both base64url

import { b64uEncode, b64uDecode, utf8, fromUtf8, sha256 } from './util.js';
import { t } from './i18n.js';

export const FREE_LIMIT = 10;

// Public keys that may sign licenses (Ed25519, SPKI, base64url): the local license tool (private key on the
// publisher's PC) and the website's admin backend (private key outside its web root).
export const LICENSE_PUBLIC_KEYS = [
  'MCowBQYDK2VwAyEASehjgZuF8UBdiD_G0tc8FO_lrgww3eiHSfwHgNxHlp8',
  'MCowBQYDK2VwAyEA4COYZFWCerXd9WZN4O2CWkEzj7qG9jfMf3FHomzn2Wo',
];

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 – easy to read out and type

function base32(bytes, length) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < length) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** Normalized vault identity: Key Vault host name (lower case) or file vault ID. */
export function licenseSubject(vaultId) {
  return String(vaultId || '').trim().toLowerCase();
}

async function checksum(body) {
  return base32(await sha256(utf8(`kvpwsafe-check|${body}`)), 4);
}

/** Request code of a vault (sent to the publisher to get a license). */
export async function requestCode(vaultId) {
  const body = base32(await sha256(utf8(`kvpwsafe-license-v1|${licenseSubject(vaultId)}`)), 16);
  return `KVP-${`${body}${await checksum(body)}`.match(/.{4}/g).join('-')}`;
}

/** Format and checksum of a request code (catches typos). */
export async function validRequestCode(code) {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^KVP/, '');
  if (clean.length !== 20 || [...clean].some((c) => !B32.includes(c))) return false;
  return (await checksum(clean.slice(0, 16))) === clean.slice(16);
}

export const normalizeRequestCode = (code) => {
  const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^KVP/, '');
  return `KVP-${clean.match(/.{1,4}/g)?.join('-') || ''}`;
};

/** Checks a license key against a vault. → { valid, reason?, payload? } */
export async function verifyLicense(key, vaultId, publicKeys = LICENSE_PUBLIC_KEYS) {
  const m = /^KVPL-([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(key || '').replace(/\s+/g, ''));
  if (!m) return { valid: false, reason: t('Das ist kein gültiger Lizenzschlüssel') };
  const keys = [].concat(publicKeys).filter((k) => k && !k.startsWith('__'));
  if (!keys.length) return { valid: false, reason: t('Diese Version kann keine Lizenzen prüfen') };
  let payload;
  try {
    let genuine = false;
    for (const publicKey of keys) {
      const k = await crypto.subtle.importKey('spki', b64uDecode(publicKey), { name: 'Ed25519' }, false, ['verify']);
      if (await crypto.subtle.verify({ name: 'Ed25519' }, k, b64uDecode(m[2]), b64uDecode(m[1]))) genuine = true;
    }
    if (!genuine) return { valid: false, reason: t('Der Lizenzschlüssel ist nicht echt') };
    payload = JSON.parse(fromUtf8(b64uDecode(m[1])));
  } catch {
    return { valid: false, reason: t('Der Lizenzschlüssel ist nicht echt') };
  }
  if (payload.v !== 1 || payload.code !== (await requestCode(vaultId))) {
    return { valid: false, reason: t('Der Lizenzschlüssel gehört zu einem anderen Tresor ({vault})', { vault: payload.vault || '?' }), payload };
  }
  return { valid: true, payload };
}

/** License tool side: signs a license for a request code. privateKey: CryptoKey (Ed25519). */
export async function issueLicense({ privateKey, code, vault = '', to = '' }) {
  const payload = { v: 1, code: normalizeRequestCode(code), vault, issued: new Date().toISOString(), to };
  const data = utf8(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data));
  return `KVPL-${b64uEncode(data)}.${b64uEncode(sig)}`;
}

export class LicenseLimitError extends Error {
  constructor(limit = FREE_LIMIT) {
    super(t('Ohne Lizenz sind {limit} Einträge pro Tresor möglich. Lizenz über Rechtsklick auf den Tresor → „Lizenz“ aktivieren.', { limit }));
    this.name = 'LicenseLimitError';
  }
}
