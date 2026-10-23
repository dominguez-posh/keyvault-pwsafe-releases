// Secured file containers (format version 2): passkey-only access with members and roles.
//
// Every member has two P-256 key pairs (ECDH for receiving the container key, ECDSA for signing changes).
// The private keys are sealed once per passkey of that member (WebAuthn PRF), so there is no password and no
// recovery code that could open the file without a passkey. Admins grant access by wrapping the container key
// for the member's ECDH key and signing a grant (role, status). The file ID is derived from the creator's
// signing key, so the chain of grants starts at a key that nobody can replace without changing the ID.

import { b64uEncode, b64uDecode, utf8, fromUtf8, concat, randomBytes, sha256 } from './util.js';
import { hkdf, seal, unseal, passkeyKey, ContainerKey, UnlockError } from './protect.js';
import { t } from './i18n.js';

export const FILE_ROLES = ['admin', 'editor', 'reader'];
export const ROLE_NAMES = { admin: 'Admin', editor: 'Bearbeiten', reader: 'Lesen' };
export const canWrite = (role) => role === 'admin' || role === 'editor';

const EC = { name: 'ECDH', namedCurve: 'P-256' };
const DSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' };
const now = () => new Date().toISOString();
const newId = () => b64uEncode(randomBytes(9));

/** Deterministic JSON (sorted object keys) as the signed representation. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------- identities

/** New member identity: { ecdh, sign } public keys (SPKI, base64url) plus the private keys. */
export async function newIdentity() {
  const ecdh = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
  const sign = await crypto.subtle.generateKey(DSA, true, ['sign', 'verify']);
  const secret = {
    ecdh: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('spki', ecdh.publicKey))),
    sign: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('spki', sign.publicKey))),
    ecdhPrivate: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', ecdh.privateKey))),
    signPrivate: b64uEncode(new Uint8Array(await crypto.subtle.exportKey('pkcs8', sign.privateKey))),
  };
  return loadIdentity(secret);
}

/** Identity with imported (non-extractable) CryptoKeys; `secret` stays for sealing to further passkeys. */
export async function loadIdentity(secret) {
  return {
    secret,
    ecdh: secret.ecdh,
    sign: secret.sign,
    ecdhKey: await crypto.subtle.importKey('pkcs8', b64uDecode(secret.ecdhPrivate), EC, false, ['deriveBits']),
    signKey: await crypto.subtle.importKey('pkcs8', b64uDecode(secret.signPrivate), DSA, false, ['sign']),
  };
}

const identityAad = (scope, memberId, credId) => `kvpwsafe/identity/${scope}/${memberId}/${credId}`;
const wrapAad = (scope, memberId, kv) => `kvpwsafe/member-key/${scope}/${memberId}/${kv}`;

async function sealIdentity(identity, prfOutput, aad) {
  return seal(await passkeyKey(b64uDecode(prfOutput)), utf8(JSON.stringify(identity.secret)), aad);
}

async function openIdentity(sealed, prfOutput, aad) {
  return loadIdentity(JSON.parse(fromUtf8(await unseal(await passkeyKey(b64uDecode(prfOutput)), sealed, aad))));
}

export async function fileIdFor(rootSign) {
  return `file-${b64uEncode(await sha256(b64uDecode(rootSign))).slice(0, 22)}`;
}

// ---------------------------------------------------------------- signatures and key wrapping

const verifyKeys = new Map();

export async function signObject(identity, obj) {
  return b64uEncode(new Uint8Array(await crypto.subtle.sign(SIGN_ALG, identity.signKey, utf8(canonical(obj)))));
}

export async function verifyObject(signSpki, obj, sig) {
  if (!signSpki || !sig) return false;
  try {
    let key = verifyKeys.get(signSpki);
    if (!key) {
      key = await crypto.subtle.importKey('spki', b64uDecode(signSpki), DSA, false, ['verify']);
      verifyKeys.set(signSpki, key);
    }
    return await crypto.subtle.verify(SIGN_ALG, key, b64uDecode(sig), utf8(canonical(obj)));
  } catch {
    return false;
  }
}

/** ECDH-ES: wraps the raw container key for a member's ECDH public key. */
export async function wrapKey(raw, ecdhSpki, aad) {
  const eph = await crypto.subtle.generateKey(EC, true, ['deriveBits']);
  const pub = await crypto.subtle.importKey('spki', b64uDecode(ecdhSpki), EC, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256));
  const epk = new Uint8Array(await crypto.subtle.exportKey('spki', eph.publicKey));
  const kek = await hkdf(concat(shared, epk), aad);
  return { epk: b64uEncode(epk), ct: await seal(kek, raw, aad) };
}

export async function unwrapKey(wrapped, identity, aad) {
  const epk = b64uDecode(wrapped.epk);
  const pub = await crypto.subtle.importKey('spki', epk, EC, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: pub }, identity.ecdhKey, 256));
  return unseal(await hkdf(concat(shared, epk), aad), wrapped.ct, aad);
}

/** Code both sides compare before an admin approves a request (e.g. read out over the phone). */
export async function safetyCode(member) {
  const hash = await sha256(utf8(canonical({ email: member.email, ecdh: member.ecdh, sign: member.sign })));
  const digits = [...hash.slice(0, 8)].map((b) => String(b % 100).padStart(2, '0')).join('');
  return digits.match(/.{4}/g).join(' ');
}

// ---------------------------------------------------------------- roster (verified grants)

const grantBody = (scope, member, g) => ({
  file: scope, member: member.id, email: member.email, ecdh: member.ecdh, sign: member.sign, role: g.role, status: g.status, at: g.at, by: g.by,
});

/**
 * Replays all grants in time order. A grant counts if it is signed by a member who is an active admin at
 * that moment; the creator's first grant is signed by the root key itself.
 * Returns { members: Map(id → { member, role, status, timeline }), roleAt(id, at), current(id) }.
 */
export async function verifyRoster(keyring) {
  const byId = new Map(keyring.members.map((m) => [m.id, m]));
  const grants = keyring.members.flatMap((m) => (m.grants || []).map((g) => ({ m, g })))
    .sort((a, b) => a.g.at.localeCompare(b.g.at) || a.g.sig.localeCompare(b.g.sig));
  const state = new Map();
  const timeline = new Map();
  for (const { m, g } of grants) {
    if (!FILE_ROLES.includes(g.role) || !['active', 'removed'].includes(g.status)) continue;
    const signer = byId.get(g.by);
    const bootstrap = g.by === m.id && m.sign === keyring.root && !timeline.size;
    const signerOk = bootstrap || (signer && state.get(signer.id)?.status === 'active' && state.get(signer.id)?.role === 'admin');
    if (!signerOk || !(await verifyObject(signer?.sign, grantBody(keyring.scope, m, g), g.sig))) continue;
    state.set(m.id, { role: g.role, status: g.status });
    timeline.set(m.id, [...(timeline.get(m.id) || []), { at: g.at, role: g.role, status: g.status, by: g.by }]);
  }
  const members = new Map(keyring.members.map((m) => [m.id, {
    member: m, role: state.get(m.id)?.role || null, status: state.get(m.id)?.status || 'pending', timeline: timeline.get(m.id) || [],
  }]));
  const roleAt = (id, at) => {
    const tl = members.get(id)?.timeline || [];
    let r = null;
    for (const x of tl) if (x.at <= at) r = x.status === 'active' ? x.role : null;
    return r;
  };
  return { members, roleAt, current: (id) => members.get(id) || null };
}

// ---------------------------------------------------------------- keyring operations

function credentialEntry(passkey, sealed, id, platform) {
  return {
    id, credentialId: passkey.credentialId, rpId: passkey.rpId, prfSalt: passkey.prfSalt, label: passkey.label || '',
    platform: !!platform, created: now(), sealed,
  };
}

async function addGrant(keyring, ctx, member, role, status) {
  const g = { role, status, at: now(), by: ctx.memberId };
  g.sig = await signObject(ctx.identity, grantBody(keyring.scope, member, g));
  return { ...member, grants: [...(member.grants || []), g] };
}

const replaceMember = (keyring, member) => ({ ...keyring, members: keyring.members.map((m) => (m.id === member.id ? member : m)), updated: now() });

/**
 * New secured keyring. creator: { email, passkey: { credentialId, rpId, prfSalt, prfOutput, label, platform } }
 * Returns { keyring, ck, identity, memberId, id } (id = file ID derived from the creator's signing key).
 */
export async function createSecureKeyring({ email, passkey }) {
  const identity = await newIdentity();
  const scope = await fileIdFor(identity.sign);
  const ck = await ContainerKey.generate();
  const memberId = newId();
  const credId = newId();
  let member = {
    id: memberId, email, ecdh: identity.ecdh, sign: identity.sign, requested: now(), grants: [],
    credentials: [credentialEntry(passkey, await sealIdentity(identity, passkey.prfOutput, identityAad(scope, memberId, credId)), credId, passkey.platform)],
    removedCredentials: [],
  };
  let keyring = { v: 2, scope, root: identity.sign, keyVersion: 1, members: [member], sharing: null, created: now() };
  member = await addGrant(keyring, { identity, memberId }, member, 'admin', 'active');
  member.wrapped = { kv: 1, ...(await wrapKey(ck.raw, identity.ecdh, wrapAad(scope, memberId, 1))) };
  keyring = replaceMember(keyring, member);
  return { keyring, ck, identity, memberId, id: scope };
}

/** Access request of a new user (no container key needed): { keyring, identity, memberId, safetyCode }. */
export async function requestAccess(keyring, { email, passkey }) {
  if (!keyring.sharing?.enabled) throw new Error(t('Die Freigabe ist für diese Datei nicht aktiviert – bitte einen Admin der Datei fragen'));
  const identity = await newIdentity();
  const memberId = newId();
  const credId = newId();
  const member = {
    id: memberId, email, ecdh: identity.ecdh, sign: identity.sign, requested: now(), grants: [],
    credentials: [credentialEntry(passkey, await sealIdentity(identity, passkey.prfOutput, identityAad(keyring.scope, memberId, credId)), credId, passkey.platform)],
    removedCredentials: [],
  };
  return { keyring: { ...keyring, members: [...keyring.members, member], updated: now() }, identity, memberId, safetyCode: await safetyCode(member) };
}

/** Passkeys of all members that this client (rpId) can use – pending requests included. */
export function secureCredentials(keyring, rpId) {
  return keyring.members.flatMap((m) => (m.credentials || []).filter((c) => c.rpId === rpId && !(m.removedCredentials || []).includes(c.id))
    .map((c) => ({ credentialId: c.credentialId, prfSalt: c.prfSalt })));
}

/** Opens the identity behind a passkey and, if access is granted, the container key. */
export async function unlockSecure(keyring, credentialId, prfOutput) {
  const member = keyring.members.find((m) => (m.credentials || []).some((c) => c.credentialId === credentialId));
  const cred = member?.credentials.find((c) => c.credentialId === credentialId && !(member.removedCredentials || []).includes(c.id));
  if (!cred) throw new UnlockError(t('Dieser Passkey passt nicht zu diesem Tresor'));
  let identity;
  try {
    identity = await openIdentity(cred.sealed, prfOutput, identityAad(keyring.scope, member.id, cred.id));
  } catch {
    throw new UnlockError(t('Dieser Passkey passt nicht zu diesem Tresor'));
  }
  const roster = await verifyRoster(keyring);
  const state = roster.current(member.id);
  if (identity.sign !== member.sign) throw new UnlockError(t('Die Mitgliedsdaten dieser Datei sind ungültig'));
  if (state.status === 'removed') throw new UnlockError(t('Dein Zugriff auf diese Datei wurde entfernt'));
  if (state.status !== 'active' || !member.wrapped || member.wrapped.kv !== keyring.keyVersion) {
    return { pending: true, memberId: member.id, email: member.email, safetyCode: await safetyCode(member) };
  }
  const raw = await unwrapKey(member.wrapped, identity, wrapAad(keyring.scope, member.id, member.wrapped.kv));
  const hasPlatform = member.credentials.some((c) => c.platform && !(member.removedCredentials || []).includes(c.id));
  return { ck: await ContainerKey.fromRaw(raw), identity, memberId: member.id, role: state.role, roster, platform: !!cred.platform, hasPlatform };
}

function requireAdmin(roster, ctx) {
  if (roster.current(ctx.memberId)?.role !== 'admin' || roster.current(ctx.memberId)?.status !== 'active') {
    throw new Error(t('Nur Admins der Datei können Benutzer verwalten'));
  }
}

function activeAdmins(roster) {
  return [...roster.members.values()].filter((x) => x.status === 'active' && x.role === 'admin').map((x) => x.member.id);
}

/**
 * Member and sharing management. ctx: { ck, identity, memberId }.
 * op: { type: 'approve', memberId, role } | { type: 'setRole', memberId, role } | { type: 'remove', memberId }
 *   | { type: 'reject', memberId } | { type: 'sharing', enabled } | { type: 'addCredential', passkey }
 *   | { type: 'removeCredential', credentialEntryId }
 * Returns { keyring, rotate? } – rotate: the caller has to re-encrypt with a new container key (rekeyMembers).
 */
export async function applySecureOp(keyring, ctx, op) {
  const roster = await verifyRoster(keyring);
  const target = op.memberId && keyring.members.find((m) => m.id === op.memberId);
  if (op.memberId && !target) throw new Error(t('Nicht gefunden'));
  switch (op.type) {
    case 'approve': {
      requireAdmin(roster, ctx);
      if (!FILE_ROLES.includes(op.role)) throw new Error('Unknown role');
      let m = await addGrant(keyring, ctx, target, op.role, 'active');
      m = { ...m, wrapped: { kv: keyring.keyVersion, ...(await wrapKey(ctx.ck.raw, m.ecdh, wrapAad(keyring.scope, m.id, keyring.keyVersion))) } };
      return { keyring: replaceMember(keyring, m) };
    }
    case 'setRole': {
      requireAdmin(roster, ctx);
      if (!FILE_ROLES.includes(op.role)) throw new Error('Unknown role');
      if (op.role !== 'admin' && activeAdmins(roster).join() === target.id) throw new Error(t('Die Datei braucht mindestens einen Admin'));
      return { keyring: replaceMember(keyring, await addGrant(keyring, ctx, target, op.role, 'active')) };
    }
    case 'remove':
    case 'reject': {
      requireAdmin(roster, ctx);
      const state = roster.current(target.id);
      if (state.status === 'active' && state.role === 'admin' && activeAdmins(roster).length === 1) throw new Error(t('Die Datei braucht mindestens einen Admin'));
      if (op.type === 'reject' || state.status !== 'active') {
        return {
          keyring: {
            ...keyring, members: keyring.members.filter((m) => m.id !== target.id), rejected: [...new Set([...(keyring.rejected || []), target.id])], updated: now(),
          },
        };
      }
      const m = await addGrant(keyring, ctx, target, state.role || 'reader', 'removed');
      return { keyring: replaceMember(keyring, { ...m, wrapped: null }), rotate: true };
    }
    case 'sharing': {
      requireAdmin(roster, ctx);
      const sharing = { enabled: !!op.enabled, at: now(), by: ctx.memberId };
      sharing.sig = await signObject(ctx.identity, { file: keyring.scope, sharing: sharing.enabled, at: sharing.at, by: sharing.by });
      return { keyring: { ...keyring, sharing, updated: now() } };
    }
    case 'addCredential': {
      const me = keyring.members.find((m) => m.id === ctx.memberId);
      if (me.credentials.some((c) => c.credentialId === op.passkey.credentialId)) throw new Error(t('Dieser Passkey ist bereits registriert'));
      const credId = newId();
      const sealed = await sealIdentity(ctx.identity, op.passkey.prfOutput, identityAad(keyring.scope, me.id, credId));
      return { keyring: replaceMember(keyring, { ...me, credentials: [...me.credentials, credentialEntry(op.passkey, sealed, credId, op.passkey.platform)] }) };
    }
    case 'removeCredential': {
      const me = keyring.members.find((m) => m.id === ctx.memberId);
      const left = me.credentials.filter((c) => c.id !== op.credentialEntryId && !(me.removedCredentials || []).includes(c.id));
      if (!left.length) throw new Error(t('Mindestens ein Passkey muss bleiben – sonst kommst du nicht mehr an die Datei'));
      return {
        keyring: replaceMember(keyring, {
          ...me,
          credentials: me.credentials.filter((c) => c.id !== op.credentialEntryId),
          removedCredentials: [...new Set([...(me.removedCredentials || []), op.credentialEntryId])],
        }),
      };
    }
    default:
      throw new Error(`Unknown member operation ${op.type}`);
  }
}

/** New container key version: wraps newCk for every active member. */
export async function rekeyMembers(keyring, newCk) {
  const roster = await verifyRoster(keyring);
  const kv = keyring.keyVersion + 1;
  const members = [];
  for (const m of keyring.members) {
    const s = roster.current(m.id);
    members.push(s.status === 'active'
      ? { ...m, wrapped: { kv, ...(await wrapKey(newCk.raw, m.ecdh, wrapAad(keyring.scope, m.id, kv))) } }
      : { ...m, wrapped: null });
  }
  return { ...keyring, keyVersion: kv, members, updated: now() };
}

/** Sharing state, accepted only with a valid admin signature. */
export async function sharingEnabled(keyring, roster) {
  const s = keyring.sharing;
  if (!s) return false;
  const signer = keyring.members.find((m) => m.id === s.by);
  return roster.roleAt(s.by, s.at) === 'admin'
    && (await verifyObject(signer?.sign, { file: keyring.scope, sharing: s.enabled, at: s.at, by: s.by }, s.sig)) && s.enabled;
}

/** View for the UI (no key material). */
export async function describeSecure(keyring, roster, myId, rpId) {
  const members = [];
  for (const [id, x] of roster.members) {
    const m = x.member;
    members.push({
      id, email: m.email, role: x.role, status: x.status, me: id === myId, requested: m.requested,
      since: x.timeline.find((g) => g.status === 'active')?.at || null,
      safetyCode: x.status === 'pending' ? await safetyCode(m) : null,
      credentials: id === myId ? m.credentials.filter((c) => !(m.removedCredentials || []).includes(c.id))
        .map((c) => ({ id: c.id, label: c.label, platform: c.platform, created: c.created, usable: c.rpId === rpId })) : undefined,
      passkeyCount: (m.credentials || []).filter((c) => !(m.removedCredentials || []).includes(c.id)).length,
    });
  }
  const order = { active: 0, pending: 1, removed: 2 };
  members.sort((a, b) => order[a.status] - order[b.status] || a.email.localeCompare(b.email));
  return { secure: true, sharing: await sharingEnabled(keyring, roster), members, myRole: roster.current(myId)?.role || null, keyVersion: keyring.keyVersion };
}

/** Union of two versions of a secured keyring (concurrent writers). */
export function mergeSecureKeyrings(a, b) {
  if (!a) return b;
  if (!b) return a;
  const byId = new Map();
  for (const m of [...b.members, ...a.members]) {
    const other = byId.get(m.id);
    if (!other) {
      byId.set(m.id, m);
      continue;
    }
    const removedCredentials = [...new Set([...(other.removedCredentials || []), ...(m.removedCredentials || [])])];
    const creds = new Map([...(other.credentials || []), ...(m.credentials || [])].map((c) => [c.id, c]));
    const grants = new Map([...(other.grants || []), ...(m.grants || [])].map((g) => [g.sig, g]));
    const wrapped = [other.wrapped, m.wrapped].filter(Boolean).sort((x, y) => y.kv - x.kv)[0] || null;
    const lastGrant = [...grants.values()].sort((x, y) => y.at.localeCompare(x.at))[0];
    byId.set(m.id, {
      ...m,
      grants: [...grants.values()],
      credentials: [...creds.values()].filter((c) => !removedCredentials.includes(c.id)),
      removedCredentials,
      wrapped: lastGrant?.status === 'removed' ? null : wrapped,
    });
  }
  const rejected = [...new Set([...(a.rejected || []), ...(b.rejected || [])])];
  const members = [...byId.values()].filter((m) => !rejected.includes(m.id));
  const sharing = [a.sharing, b.sharing].filter(Boolean).sort((x, y) => y.at.localeCompare(x.at))[0] || null;
  return { ...a, keyVersion: Math.max(a.keyVersion, b.keyVersion), members, sharing, rejected };
}
