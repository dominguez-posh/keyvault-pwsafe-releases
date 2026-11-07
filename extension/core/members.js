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

/** #440: an entry dated later than this ahead of the own clock does not count (yet); it stays in the file. */
export const FUTURE_SLACK_MS = 10 * 60_000;

/**
 * Replays all grants in time order. A grant counts if it is signed by a member who is an active admin at
 * that moment; the creator's first grant is signed by the root key itself.
 *
 * #440 (Konrad, high): the signer writes the `at` themselves, so a removed admin could date a grant, a rejection or the
 * sharing setting back to their admin time. `known` is the floor of what counted before (rollback.js, floorOf with
 * the roster). What is new against it counts only if dated after the last verified known entry of the signer's own
 * timeline (grants for or by them, e.g. their removal) – replayed in time order it then comes after that removal.
 * Each signer is measured against their own timeline only, so a clock running ahead on one device costs nobody else
 * their entries. Entries more than FUTURE_SLACK_MS ahead count nowhere. Nothing that does not count is deleted.
 * Returns { members: Map(id → { member, role, status, timeline }), roleAt(id, at), current(id), accepted: Set of
 * "memberId sig", counts({ by, at, sig }) for rejections and the sharing setting, lastAt(id) }.
 */
export async function verifyRoster(keyring, known = null, nowMs = Date.now()) {
  const byId = new Map(keyring.members.map((m) => [m.id, m]));
  const limit = new Date(nowMs + FUTURE_SLACK_MS).toISOString();
  const knownGrants = known ? new Set(known.grants || []) : null;
  const raw = keyring.members.flatMap((m) => (m.grants || []).map((g) => ({ m, g, key: `${m.id} ${g?.sig}` })));
  const all = raw.filter(({ g }) => typeof g?.at === 'string' && typeof g.sig === 'string')
    .sort((a, b) => a.g.at.localeCompare(b.g.at) || a.g.sig.localeCompare(b.g.sig));
  // #444 (Konrad, high): a known grant (in the floor) that is there but no longer verifies was changed – e.g. a removal
  // turned into "active" with its signature kept. The caller refuses such a file instead of dropping the grant quietly.
  let tampered = raw.some((x) => knownGrants?.has(x.key) && !all.includes(x));
  const grants = [];
  for (const x of all) {
    const signer = byId.get(x.g.by);
    if (await verifyObject(signer?.sign, grantBody(keyring.scope, x.m, x.g), x.g.sig)) grants.push(x);
    else if (knownGrants?.has(x.key)) tampered = true;
  }
  const knownAt = new Map(); // member → last verified known entry for or by them
  const later = (id, at) => { if (at > (knownAt.get(id) || '')) knownAt.set(id, at); };
  for (const { m, g, key } of grants) if (knownGrants?.has(key)) { later(m.id, g.at); later(g.by, g.at); }
  const state = new Map();
  const timeline = new Map();
  const accepted = new Set();
  const lastAt = new Map();
  const suspect = []; // validly signed grants that do not count: { id, by }
  for (const { m, g, key } of grants) {
    // A removal dated ahead counts at once (#440): it becomes known, so the removed member's later grants don't count.
    if (!FILE_ROLES.includes(g.role) || !['active', 'removed'].includes(g.status) || (g.at > limit && g.status !== 'removed')) continue;
    const bootstrap = g.by === m.id && m.sign === keyring.root && !timeline.size;
    const signerOk = bootstrap || (state.get(g.by)?.status === 'active' && state.get(g.by)?.role === 'admin');
    if (!signerOk || (knownGrants && !knownGrants.has(key) && !(g.at > (knownAt.get(g.by) || '')))) {
      if (knownGrants) suspect.push({ id: m.id, by: g.by });
      continue;
    }
    state.set(m.id, { role: g.role, status: g.status });
    timeline.set(m.id, [...(timeline.get(m.id) || []), { at: g.at, role: g.role, status: g.status, by: g.by }]);
    accepted.add(key);
    for (const id of [m.id, g.by]) if (g.at > (lastAt.get(id) || '')) lastAt.set(id, g.at);
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
  // Rejections and the sharing setting: the same time rules (the signature is checked by the caller). A floor from
  // before #440 has no `signed`: they are then taken as known.
  const knownSigned = known?.signed ? new Set(known.signed) : null;
  const counts = (x) => typeof x?.at === 'string' && x.at <= limit
    && (!known || !knownSigned || knownSigned.has(x.sig) || x.at > (knownAt.get(x.by) || ''));
  // Members with such a grant are shown to admins as invalid entry (#440) – only if its signer was an admin at some
  // point (#446): any writer could otherwise mark a real request with a grant signed by an account of their own. And
  // only those without access.
  const wasAdmin = (id) => (timeline.get(id) || []).some((x) => x.status === 'active' && x.role === 'admin');
  const invalid = new Set(suspect.filter((x) => wasAdmin(x.by) && state.get(x.id)?.status !== 'active').map((x) => x.id));
  return { members, roleAt, current: (id) => members.get(id) || null, accepted, counts, lastAt: (id) => lastAt.get(id) || '', tampered, invalid };
}

/** #440: the date a member signs with – never before their own last entry, so their next one counts everywhere. */
export function signedAt(roster, memberId, nowMs = Date.now()) {
  const last = Date.parse(roster?.lastAt?.(memberId) || '') || 0;
  return new Date(Math.max(nowMs, last + 1)).toISOString();
}

// ---------------------------------------------------------------- keyring operations

function credentialEntry(passkey, sealed, id, platform) {
  return {
    id, credentialId: passkey.credentialId, rpId: passkey.rpId, prfSalt: passkey.prfSalt, label: passkey.label || '',
    platform: !!platform, created: now(), sealed,
  };
}

async function addGrant(keyring, ctx, member, role, status) {
  const g = { role, status, at: ctx.at || now(), by: ctx.memberId };
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
export async function unlockSecure(keyring, credentialId, prfOutput, known = null) {
  const member = keyring.members.find((m) => (m.credentials || []).some((c) => c.credentialId === credentialId));
  const cred = member?.credentials.find((c) => c.credentialId === credentialId && !(member.removedCredentials || []).includes(c.id));
  if (!cred) throw new UnlockError(t('Dieser Passkey passt nicht zu diesem Tresor'));
  let identity;
  try {
    identity = await openIdentity(cred.sealed, prfOutput, identityAad(keyring.scope, member.id, cred.id));
  } catch {
    throw new UnlockError(t('Dieser Passkey passt nicht zu diesem Tresor'));
  }
  const roster = await verifyRoster(keyring, known);
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

const rejectionBody = (scope, r) => ({ file: scope, rejected: r.id, at: r.at, by: r.by });

/** Did this member sign a grant of someone else or a rejection? Then their key must stay readable in the file. */
const signedForOthers = (keyring, id) => keyring.members.some((m) => m.id !== id && (m.grants || []).some((g) => g.by === id))
  || (keyring.rejected || []).some((r) => r?.by === id);

/**
 * Only rejections signed by someone who was an admin at that time count (#433): those members are taken out, every
 * other entry (unsigned, forged, from before 0.9.29) is dropped and takes nobody out.
 */
export async function applyRejections(keyring, known = null) {
  if (!keyring?.members) return keyring;
  const roster = await verifyRoster(keyring, known);
  const valid = [];
  for (const r of keyring.rejected || []) {
    const signer = keyring.members.find((m) => m.id === r?.by);
    if (signer && roster.roleAt(r.by, r.at) === 'admin' && (await verifyObject(signer.sign, rejectionBody(keyring.scope, r), r.sig))
      && !valid.some((x) => x.id === r.id && x.sig === r.sig)) valid.push(r);
  }
  // #440: a rejection dated back (or far ahead) stays in the file but takes nobody out.
  const gone = new Set(valid.filter((r) => roster.counts(r)).map((r) => r.id).filter((id) => !signedForOthers(keyring, id)));
  return { ...keyring, members: keyring.members.filter((m) => !gone.has(m.id)), rejected: valid };
}

function activeAdmins(roster) {
  return [...roster.members.values()].filter((x) => x.status === 'active' && x.role === 'admin').map((x) => x.member.id);
}

/**
 * Member and sharing management. ctx: { ck, identity, memberId, known? } (known: the floor, see verifyRoster).
 * op: { type: 'approve', memberId, role } | { type: 'setRole', memberId, role } | { type: 'remove', memberId }
 *   | { type: 'reject', memberId } | { type: 'sharing', enabled } | { type: 'addCredential', passkey }
 *   | { type: 'removeCredential', credentialEntryId }
 * Returns { keyring, rotate? } – rotate: the caller has to re-encrypt with a new container key (rekeyMembers).
 */
export async function applySecureOp(keyring, ctx, op) {
  const roster = await verifyRoster(keyring, ctx.known);
  ctx = { ...ctx, at: signedAt(roster, ctx.memberId) }; // #440: after the own last entry, also with a clock behind
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
        // Someone whose signature others' grants or rejections rest on stays in the file, only hidden: deleting them
        // would make those signatures uncheckable (#433).
        // #446: plus a signed removal – a device without a floor may count a grant for them that does not count here (a
        // removed admin's account that signed something for another member), and would keep them active.
        if (signedForOthers(keyring, target.id)) {
          const m = await addGrant(keyring, ctx, target, state.role || 'reader', 'removed');
          return { keyring: replaceMember(keyring, { ...m, wrapped: null, hidden: true }), ...(target.wrapped ? { rotate: true } : {}) };
        }
        // Taken out for good: a rejection signed by this admin; an unsigned one never takes anybody out (#433).
        const r = { id: target.id, at: ctx.at, by: ctx.memberId };
        r.sig = await signObject(ctx.identity, rejectionBody(keyring.scope, r));
        return { keyring: { ...keyring, members: keyring.members.filter((m) => m.id !== target.id), rejected: [...(keyring.rejected || []), r], updated: now() } };
      }
      const m = await addGrant(keyring, ctx, target, state.role || 'reader', 'removed');
      return { keyring: replaceMember(keyring, { ...m, wrapped: null }), rotate: true };
    }
    case 'sharing': {
      requireAdmin(roster, ctx);
      const sharing = { enabled: !!op.enabled, at: ctx.at, by: ctx.memberId };
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
export async function rekeyMembers(keyring, newCk, known = null) {
  const roster = await verifyRoster(keyring, known);
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
  return roster.roleAt(s.by, s.at) === 'admin' && roster.counts(s)
    && (await verifyObject(signer?.sign, { file: keyring.scope, sharing: s.enabled, at: s.at, by: s.by }, s.sig)) && s.enabled;
}

/** View for the UI (no key material). */
export async function describeSecure(keyring, roster, myId, rpId) {
  const members = [];
  for (const [id, x] of roster.members) {
    const m = x.member;
    if (m.hidden && x.status !== 'active') continue; // deleted for good, kept only for the signatures (#433)
    members.push({
      id, email: m.email, role: x.role, status: x.status, me: id === myId, requested: m.requested,
      since: x.timeline.find((g) => g.status === 'active')?.at || null,
      safetyCode: x.status === 'pending' ? await safetyCode(m) : null,
      // #440: a signed grant for this account that does not count here (dated back, or by someone not admin then).
      // Devices without a floor may count it – an admin takes the account out with a signed rejection.
      invalid: roster.invalid?.has(id) || undefined,
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
      hidden: !!(other.hidden || m.hidden) || undefined,
    });
  }
  // Rejections are only collected here; applyRejections (async, checks the signatures) takes members out (#433).
  const rejected = [...new Map([...(a.rejected || []), ...(b.rejected || [])].map((r) => [JSON.stringify(r), r])).values()];
  const members = [...byId.values()];
  const sharing = [a.sharing, b.sharing].filter(Boolean).sort((x, y) => y.at.localeCompare(x.at))[0] || null;
  return { ...a, keyVersion: Math.max(a.keyVersion, b.keyVersion), members, sharing, rejected };
}
