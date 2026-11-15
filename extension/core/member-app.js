// #539 Etappe 8: the member identity of a secured file (format 2) at the app's one master password.
//
// Every person has one member key MK (32 random bytes with a generation) kept in their personal vault, so it sits behind
// the app's master password (Hello, MP or PIN → device key → personal vault → MK). A key change of the personal vault
// (new MP, reset with the recovery stick) re-encrypts MK: the identities stay, only wrapped anew.
// In each secured file the identity stays per file and member (as with passkeys); an "app credential" seals it with a
// key derived from MK for exactly this file, member and credential. Its tag (HKDF of MK and the file ID) finds the own
// credential without trying them all and links nothing across files. No rpId and no credentialId: older app versions
// skip it (they look for passkeys of their rpId, by credential ID).

import { b64uEncode, b64uDecode, utf8, fromUtf8, randomBytes, sha256 } from './util.js';
import { hkdf, seal, unseal } from './protect.js';

export const APP_KIND = 'app';
export const MEMBER_KEY_BYTES = 32;

export const isAppCredential = (c) => c?.kind === APP_KIND;

/** AAD of a sealed identity – the same for passkeys and the app credential. */
export const identityAad = (scope, memberId, credId) => `kvpwsafe/identity/${scope}/${memberId}/${credId}`;

const appKeyInfo = (scope, memberId, credId) => `kvpwsafe/member-app/v1|${scope}|${memberId}|${credId}`;

export const newMemberKey = () => randomBytes(MEMBER_KEY_BYTES);

function checkMk(mk) {
  if (!(mk instanceof Uint8Array) || mk.length !== MEMBER_KEY_BYTES) throw new Error('member key missing');
  return mk;
}

/** Tag of the own app credential in one file: unlinkable across files, no key material. */
export async function appTag(mk, scope) {
  return b64uEncode(await hkdf(checkMk(mk), `kvpwsafe/member-app-tag/v1|${scope}`)).slice(0, 22);
}

/** Fingerprint of MK (device memory against putting back an older one; never the key itself). */
export async function memberKeyFingerprint(mk) {
  return b64uEncode(await sha256(await hkdf(checkMk(mk), 'kvpwsafe/member-key-fp/v1'))).slice(0, 22);
}

/** Credential entry that seals the identity's secret for this file with MK. */
// Konrad M4: app credential IDs start with "app-", so a removed one stays recognizable in removedCredentials.
export const APP_ID_PREFIX = 'app-';
export const removedAppCredential = (m) => (m?.removedCredentials || []).some((id) => String(id).startsWith(APP_ID_PREFIX));

export async function appCredential(secret, mk, scope, memberId, credId, label = '') {
  const key = await hkdf(checkMk(mk), appKeyInfo(scope, memberId, credId));
  return {
    id: credId, kind: APP_KIND, tag: await appTag(mk, scope), label: String(label || '').slice(0, 80),
    created: new Date().toISOString(), sealed: await seal(key, utf8(JSON.stringify(secret)), identityAad(scope, memberId, credId)),
  };
}

/** The identity secret behind an app credential, or null (another MK, another file, changed). */
export async function openAppSecret(cred, mk, scope, memberId) {
  if (!isAppCredential(cred) || typeof cred.sealed !== 'string' || typeof cred.id !== 'string') return null;
  try {
    const key = await hkdf(checkMk(mk), appKeyInfo(scope, memberId, cred.id));
    return JSON.parse(fromUtf8(await unseal(key, cred.sealed, identityAad(scope, memberId, cred.id))));
  } catch {
    return null;
  }
}

/** Live (not removed) credentials of a member. */
export const liveCredentials = (m) => (m?.credentials || []).filter((c) => !(m.removedCredentials || []).includes(c.id));

/** Does the member still have a passkey (not only the app credential)? */
export const hasPasskey = (m) => liveCredentials(m).some((c) => !isAppCredential(c));

/** The members whose live app credential carries this MK's tag for the file: [{ member, cred }]. */
export async function ownAppCredentials(keyring, mk) {
  const tag = await appTag(mk, keyring.scope);
  return (keyring.members || []).flatMap((m) => liveCredentials(m).filter((c) => isAppCredential(c) && c.tag === tag).map((cred) => ({ member: m, cred })));
}

// ---------------------------------------------------------------- the member keys in the personal vault

// Konrad M1: a list, not one record – two devices creating the first key at the same time (or one renewing while another
// writes) both keep theirs; merging unites the lists, opening tries every key. Each entry: { gen, fp, at, data }, the
// key and its mark "compromised" encrypted under the personal vault's key, generation and fingerprint in the AAD.
const mkAad = (gen, fp) => `member-key/${gen}/${fp}`;
const validEntry = (e) => e && Number.isInteger(e.gen) && e.gen >= 1 && typeof e.fp === 'string' && typeof e.data === 'string';

/** One sealed entry for the personal vault document (ck: its container key). */
export async function sealMemberKey(ck, { mk, gen, compromised = false }, aad) {
  if (!Number.isInteger(gen) || gen < 1) throw new Error('member key generation');
  const fp = await memberKeyFingerprint(mk);
  const data = await ck.encrypt(JSON.stringify({ k: b64uEncode(checkMk(mk)), compromised: !!compromised }), aad(mkAad(gen, fp)));
  return { gen, fp, at: Date.now(), data };
}

/** The entries that open with ck and match their fingerprint: [{ gen, fp, mk, compromised }]. */
export async function openMemberKeys(ck, list, aad) {
  const out = [];
  for (const e of Array.isArray(list) ? list.filter(validEntry) : []) {
    try {
      const v = JSON.parse(await ck.decrypt(e.data, aad(mkAad(e.gen, e.fp))));
      const mk = b64uDecode(v.k);
      if (mk.length === MEMBER_KEY_BYTES && (await memberKeyFingerprint(mk)) === e.fp) out.push({ gen: e.gen, fp: e.fp, mk, compromised: !!v.compromised });
    } catch { /* another key (changed by an older app), or changed: not readable here */ }
  }
  return uniteKeys(out);
}

/** Union by fingerprint (compromised once = compromised); the current key first, then by generation. */
export function uniteKeys(...lists) {
  const by = new Map();
  for (const k of lists.flat().filter(Boolean)) {
    const x = by.get(k.fp);
    by.set(k.fp, x ? { ...x, gen: Math.max(x.gen, k.gen), compromised: x.compromised || k.compromised } : { ...k });
  }
  return [...by.values()].sort((a, b) => Number(a.compromised) - Number(b.compromised) || b.gen - a.gen || a.fp.localeCompare(b.fp));
}

/** The key new credentials are sealed with: the highest generation that is not compromised, or null. */
export const currentKey = (keys) => keys.find((k) => !k.compromised) || null;

/** Merge of two documents' lists: every entry kept (by generation and fingerprint), the newer write of one entry wins. */
export function mergeMemberKeyLists(a, b) {
  const by = new Map();
  for (const e of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])].filter(validEntry)) {
    const k = `${e.gen}/${e.fp}`;
    if (!by.has(k) || (e.at || 0) > (by.get(k).at || 0)) by.set(k, e);
  }
  return by.size ? [...by.values()] : undefined;
}

/** Re-encrypts every entry for a new container key (the key change of the personal vault). */
export async function recryptMemberKeys(list, recrypt) {
  if (!Array.isArray(list)) return list;
  const out = [];
  for (const e of list.filter(validEntry)) out.push({ ...e, data: await recrypt(e.data, mkAad(e.gen, e.fp)) });
  return out;
}
