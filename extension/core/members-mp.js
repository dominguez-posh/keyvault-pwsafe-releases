// #539 Etappe 8: the master-password side of secured files (format 2) – the setting "passkeys only" and the
// replacement of an identity whose master password was compromised.
//
// "Passkeys only" (Lucas, risk 2): a signed file setting like the sharing setting (members.js) – an admin at that time
// signs { file, passkeyOnly, at, by }; the time rules of #440 apply (roster.counts). On: no app credential opens the
// file or is added; switching it on takes every app credential out of the file and needs a passkey for every active
// member. Its newest valid state also goes into the floor (rollback.js), so a file put back without it stays "on".
// Limit: an app rule – whoever holds a member's MK and an older copy with that member's app credential opens their
// identity until the member gets a new one (replacement).
//
// Replacement: after "master password compromised" the person gets a new member key and, per file, a new identity as
// a request that names the old member, signed with the old identity (no other writer can claim to replace someone).
// An admin compares the code and approves: the new identity gets the old role, the old one is removed (key change).

import { t } from './i18n.js';
import {
  verifyRoster, signObject, verifyObject, signedAt, applySecureOp, requestAccess, FILE_ROLES, safetyCode,
} from './members.js';
import { isAppCredential, hasPasskey, ownAppCredentials } from './member-app.js';

/**
 * #539 Etappe 10 (Konrad): an admin approves a request only by typing the code the person reads out from their own app
 * (derived from the request's public keys and e-mail) – no bare "OK", the name is only a hint. Digits only, all 16.
 */
export async function codeMatches(member, typed) {
  const digits = (x) => String(x ?? '').replace(/\D/g, '');
  return !!member && digits(typed).length === 16 && digits(typed) === digits(await safetyCode(member));
}

const now = () => new Date().toISOString();
const pkoBody = (scope, s) => ({ file: scope, passkeyOnly: !!s.enabled, at: s.at, by: s.by });
const replBody = (scope, r, m) => ({ file: scope, replaces: r.id, member: m.id, email: m.email, ecdh: m.ecdh, sign: m.sign, at: r.at });

function requireAdmin(roster, memberId) {
  const s = roster.current(memberId);
  if (s?.role !== 'admin' || s?.status !== 'active') throw new Error(t('Nur Admins der Datei können Benutzer verwalten'));
}

/** The file's "passkeys only" setting if it counts: signed by someone who was admin then, dated by the #440 rules. */
export function validPasskeyOnly(keyring, roster) {
  const s = keyring?.passkeyOnly;
  return s && roster?.passkeyOnlySig && s.sig === roster.passkeyOnlySig ? { enabled: !!s.enabled, at: s.at, by: s.by, sig: s.sig } : null;
}

/** Effective state: the newer of the valid file setting and the one remembered in the floor (checked when it got there). */
export function passkeyOnlyEnabled(keyring, roster, floor = null) {
  const own = validPasskeyOnly(keyring, roster);
  const known = floor?.passkeyOnly && typeof floor.passkeyOnly.at === 'string' ? floor.passkeyOnly : null;
  return !![own, known].filter(Boolean).sort((a, b) => b.at.localeCompare(a.at))[0]?.enabled;
}

/** Admin: switch "passkeys only". ctx: { identity, memberId, known }. → { keyring } */
export async function setPasskeyOnly(keyring, ctx, enabled) {
  const roster = await verifyRoster(keyring, ctx.known);
  requireAdmin(roster, ctx.memberId);
  let members = keyring.members;
  if (enabled) {
    const missing = [...roster.members.values()].filter((x) => x.status === 'active' && !hasPasskey(x.member)).map((x) => x.member.email);
    if (missing.length) {
      throw Object.assign(new Error(t('Erst einen Passkey für alle Mitglieder einrichten – ohne Passkey: {list}', { list: missing.join(', ') })), { code: 'no-passkey', missing });
    }
    // Every app credential goes (also of pending requests): from now on only passkeys open identities here.
    members = members.map((m) => {
      const apps = (m.credentials || []).filter(isAppCredential).map((c) => c.id);
      return apps.length ? {
        ...m, credentials: m.credentials.filter((c) => !isAppCredential(c)), removedCredentials: [...new Set([...(m.removedCredentials || []), ...apps])],
      } : m;
    });
  }
  const s = { enabled: !!enabled, at: signedAt(roster, ctx.memberId), by: ctx.memberId };
  s.sig = await signObject(ctx.identity, pkoBody(keyring.scope, s));
  return { keyring: { ...keyring, members, passkeyOnly: s, updated: now() } };
}

/**
 * The person's new identity for this file, replacing the old one (master password compromised). old: { memberId,
 * identity } (the identity opened right now), mk: the new member key. The old identity's app credentials go – its MK is
 * the compromised one; its passkeys stay until the replacement is approved. → { keyring, memberId, identity, safetyCode }
 */
export async function requestReplacement(keyring, { oldMemberId, oldIdentity, mk, email }) {
  const old = keyring.members.find((m) => m.id === oldMemberId);
  if (!old || old.sign !== oldIdentity?.sign) throw new Error(t('Nicht gefunden'));
  const r = await requestAccess(keyring, { email: email || old.email, mk, sharingOff: true });
  const rep = { id: old.id, at: now() };
  const fresh = r.keyring.members.find((m) => m.id === r.memberId);
  rep.sig = await signObject(oldIdentity, replBody(keyring.scope, rep, fresh));
  const apps = (old.credentials || []).filter(isAppCredential).map((c) => c.id);
  const members = r.keyring.members.map((m) => {
    if (m.id === fresh.id) return { ...m, replaces: rep };
    if (m.id === old.id) return { ...m, credentials: m.credentials.filter((c) => !isAppCredential(c)), removedCredentials: [...new Set([...(m.removedCredentials || []), ...apps])] };
    return m;
  });
  return { keyring: { ...r.keyring, members }, memberId: r.memberId, identity: r.identity, safetyCode: r.safetyCode };
}

/** The member this request replaces, if its signature by that member's identity holds – else null. */
export async function replacedBy(keyring, member) {
  const rep = member?.replaces;
  if (!rep || typeof rep.id !== 'string' || typeof rep.at !== 'string') return null;
  const old = keyring.members.find((m) => m.id === rep.id);
  return old && old.id !== member.id && (await verifyObject(old.sign, replBody(keyring.scope, rep, member), rep.sig)) ? old : null;
}

/**
 * Admin: approve a replacement – the new identity gets the old one's role, the old one is removed (the caller changes
 * the key: rotate). Approving first keeps an admin in the file when an admin replaces themselves. ctx as applySecureOp;
 * ctxAfter (optional): the context for the removal (the admin's own new identity when replacing themselves).
 */
export async function approveReplacement(keyring, ctx, newMemberId, ctxAfter = null) {
  const roster = await verifyRoster(keyring, ctx.known);
  requireAdmin(roster, ctx.memberId);
  const fresh = keyring.members.find((m) => m.id === newMemberId);
  const old = fresh && (await replacedBy(keyring, fresh));
  if (!old || roster.current(fresh.id)?.status !== 'pending') throw new Error(t('Diese Anfrage ersetzt kein Mitglied'));
  const prev = roster.current(old.id);
  // Konrad (low): only an active member is replaced – a removed or pending one gets no new identity through this path.
  if (prev?.status !== 'active' || !FILE_ROLES.includes(prev.role)) throw new Error(t('Diese Anfrage ersetzt kein Mitglied'));
  const a = await applySecureOp(keyring, ctx, { type: 'approve', memberId: fresh.id, role: prev.role });
  await guardBreakGlass(a.keyring, ctxAfter || ctx, { type: 'remove', memberId: old.id }); // Konrad N2c
  const b = await applySecureOp(a.keyring, ctxAfter || ctx, { type: 'remove', memberId: old.id });
  return { keyring: b.keyring, rotate: true };
}

/** For the members view: which request replaces whom (verified), and whether "passkeys only" holds. */
export async function describeMp(keyring, roster, floor, mk = null) {
  const replaces = {};
  for (const m of keyring.members) {
    const old = await replacedBy(keyring, m);
    if (old) replaces[m.id] = { id: old.id, email: old.email };
  }
  const mine = mk ? (await ownAppCredentials(keyring, mk)).map((x) => x.member.id) : [];
  return { passkeyOnly: passkeyOnlyEnabled(keyring, roster, floor), replaces, appMembers: mine };
}

/** The operations of this module for FileVault.memberOp; null for every other type (members.js applySecureOp). */
export async function applyMpOp(keyring, ctx, op) {
  await guardBreakGlass(keyring, ctx, op); // #539 Etappe 10
  // Konrad N2d: the typed code is checked here, in the file's queue, against exactly the member being approved.
  if (op?.requireCode === true && (op.type === 'approve' || op.type === 'replace')
    && !(await codeMatches(keyring.members.find((m) => m.id === op.memberId), op.code))) {
    throw Object.assign(new Error(t('Der Sicherheitscode stimmt nicht. Lass ihn dir von der Person vorlesen, die den Zugriff angefragt hat.')), { code: 'WrongSafetyCode' });
  }
  if (op?.type === 'breakGlass') return addBreakGlass(keyring, ctx, op.stick);
  if (op?.type === 'passkeyOnly') return setPasskeyOnly(keyring, ctx, !!op.enabled);
  if (op?.type === 'replace') return approveReplacement(keyring, ctx, op.memberId);
  return null;
}

/**
 * Konrad (low): after merging two versions, the newest "passkeys only" setting with a valid signature stays – a forged one
 * dated later must not push a valid one out of the file (mergeSecureKeyrings only compares the dates).
 */
export async function settlePasskeyOnly(keyring, candidates, known = null) {
  const list = [...new Map(candidates.filter((c) => typeof c?.at === 'string' && typeof c.sig === 'string').map((c) => [c.sig, c])).values()]
    .sort((a, b) => b.at.localeCompare(a.at));
  for (const c of list) {
    if ((await verifyRoster({ ...keyring, passkeyOnly: c }, known)).passkeyOnlySig === c.sig) return { ...keyring, passkeyOnly: c };
  }
  return keyring;
}

// ---------------------------------------------------------------- break-glass (#539 Etappe 10)

// Lucas/Konrad: every secured file gets an emergency FIDO stick (kept in a safe) as a member of its own – admin, marked
// `breakGlass`, its identity sealed with the stick's PRF like any passkey member (ECDH for the container key). With it the
// data opens even when every admin is gone. The last one cannot be removed or lose its admin role. The mark itself is
// signed with its grants (members.js grantBody); only addBreakGlass approves a member carrying it.
export const isBreakGlass = (m) => m?.breakGlass === true;

/** Active break-glass members of the roster. */
const activeBreakGlass = (roster) => [...roster.members.values()].filter((x) => x.status === 'active' && isBreakGlass(x.member)).map((x) => x.member.id);

/**
 * Admin: adds the stick as break-glass member. stick: { credentialId, rpId, prfSalt, prfOutput, label } (the caller has
 * test-opened it in a second ceremony). Its credential may not belong to any member already. → { keyring, memberId }
 */
export async function addBreakGlass(keyring, ctx, stick) {
  const roster = await verifyRoster(keyring, ctx.known);
  requireAdmin(roster, ctx.memberId);
  if (!stick?.credentialId || !stick.prfOutput) throw new Error(t('Der Notfall-Stick liefert keine Schlüsselableitung (PRF)'));
  if (keyring.members.some((m) => (m.credentials || []).some((c) => c.credentialId === stick.credentialId))) {
    throw new Error(t('Dieser Sicherheitsschlüssel ist schon bei einem Mitglied eingetragen – für den Notfall-Zugang einen eigenen Stick verwenden'));
  }
  const label = String(stick.label || t('Notfall-Stick (Break-Glass)')).slice(0, 80);
  const r = await requestAccess(keyring, { email: label, passkey: stick, sharingOff: true });
  const marked = { ...r.keyring, members: r.keyring.members.map((m) => (m.id === r.memberId ? { ...m, breakGlass: true } : m)) };
  const a = await applySecureOp(marked, ctx, { type: 'approve', memberId: r.memberId, role: 'admin', breakGlassStick: true });
  return { keyring: a.keyring, memberId: r.memberId };
}

/** The last active break-glass member stays: no removal, no rejection, no other role. Throws, or returns nothing. */
async function guardBreakGlass(keyring, ctx, op) {
  if (!['remove', 'reject', 'setRole'].includes(op?.type) || (op.type === 'setRole' && op.role === 'admin')) return;
  const target = keyring.members.find((m) => m.id === op.memberId);
  if (!isBreakGlass(target)) return;
  const roster = await verifyRoster(keyring, ctx.known);
  const active = activeBreakGlass(roster);
  if (active.includes(target.id) && active.length <= 1) throw new Error(t('Der letzte Notfall-Zugang (Break-Glass) lässt sich nicht entfernen – erst einen weiteren Notfall-Stick hinzufügen'));
}
