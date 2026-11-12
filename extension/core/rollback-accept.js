// #435: an older state of a secured file taken on purpose by an admin (a backup put back, an update lost when two
// devices saved at once). The floor (rollback.js) is never lowered or skipped: the older state is lifted above it. Every
// grant, rejection and sharing setting known here goes back in, the container key is changed (generation above the
// floor and the file) and wrapped for the members active in the known state, and an entry in the signed change log says
// who did it. Other devices then see a newer generation with every grant they know and follow the key change; their
// floor stays as strict as it was. What a device never saw, this one cannot put back (residual risk, see the dialog).

import { verifyRoster, applyRejections, rekeyMembers, unlockSecure, fileIdFor } from './members.js';
import { ContainerKey } from './protect.js';
import { recryptDoc } from './filevault-rekey.js';
import { belowFloor } from './rollback.js';
import { keyChangeAt, keyCheck } from './key-proof.js';
import { FileVault, parseFile } from './filevault.js';
import { t } from './i18n.js';

export const ACCEPT_ACTION = 'older-state-accept';

const fail = (message) => {
  throw Object.assign(new Error(message), { name: 'AcceptOlderError' });
};
const incomplete = () => fail(t('Der hier bekannte Stand ist unvollständig gespeichert. Öffne den aktuellen Stand einmal mit dieser Version, bevor du einen älteren annimmst.'));

/** "memberId role" of every active member, sorted – compared between the result and the known state. */
export function activeOf(roster) {
  return [...roster.members].filter(([, x]) => x.status === 'active').map(([id, x]) => `${id} ${x.role}`).sort();
}

/** Rejections and sharing settings of the floor, whole. Every signature the floor counted needs its object. */
function signedParts(floor) {
  if (!floor?.members?.length || !Array.isArray(floor.signed) || !Array.isArray(floor.rejections) || !Array.isArray(floor.sharings)) incomplete();
  // Kept apart by the floor (Konrad B2), with the signed fields only: nothing is sorted by the shape of an object.
  const rejections = floor.rejections.map((x) => ({ id: x.id, at: x.at, by: x.by, sig: x.sig }));
  const sharings = floor.sharings.map((x) => ({ enabled: !!x.enabled, at: x.at, by: x.by, sig: x.sig }));
  const sigs = new Set([...rejections, ...sharings].map((o) => o.sig));
  if (floor.signed.some((sig) => !sigs.has(sig))) incomplete();
  return { rejections, sharings };
}

/** The roster of the known state alone: its members with the grants that counted, its rejections. */
export async function floorRoster(floor, keyring) {
  const { rejections } = signedParts(floor);
  const k = {
    v: 2, scope: keyring.scope, root: keyring.root, keyVersion: floor.keyVersion, sharing: null, rejected: rejections,
    members: floor.members.map((m) => ({ ...m, credentials: [], removedCredentials: [] })),
  };
  return verifyRoster(k, floor);
}

/**
 * The older document with everything known here put back (no key needed): members and their grants exactly as signed,
 * rejections, the sharing setting. Passkeys of a member come from the file, and from the newer state still open here
 * (newerDoc) if there is one. Throws unless the result has exactly the active members and roles of the known state.
 * → { keyring, roster, known: floor roster, restored: [email], noPasskey: [email] }
 */
export async function repairOlder(doc, floor, newerDoc = null) {
  if (doc?.version !== 2 || !doc.keyring || floor?.id !== doc.id) fail(t('Die Datei passt nicht zum hier bekannten Tresor.'));
  if (doc.id !== (await fileIdFor(doc.keyring.root))) fail(t('Die Datei wurde manipuliert: Ihre Kennung passt nicht zum Schlüssel des Erstellers'));
  const { rejections, sharings } = signedParts(floor);
  const newer = new Map((newerDoc?.id === doc.id ? newerDoc.keyring?.members || [] : []).map((m) => [m.id, m]));
  const members = [...doc.keyring.members];
  const restored = [];
  for (const f of floor.members) {
    const i = members.findIndex((m) => m.id === f.id);
    const cur = i >= 0 ? members[i] : { id: f.id, requested: f.grants[0]?.at, credentials: [], removedCredentials: [], wrapped: null };
    const sigs = new Set(f.grants.map((g) => g.sig));
    if (i < 0 || f.grants.some((g) => !(cur.grants || []).some((x) => x?.sig === g.sig))) restored.push(f.email);
    const next = { ...cur, email: f.email, ecdh: f.ecdh, sign: f.sign, grants: [...f.grants, ...(cur.grants || []).filter((g) => !sigs.has(g?.sig))] };
    const n = newer.get(f.id);
    if (n?.sign === f.sign) {
      const removedCredentials = [...new Set([...(next.removedCredentials || []), ...(n.removedCredentials || [])])];
      const creds = new Map([...(next.credentials || []), ...(n.credentials || [])].map((c) => [c.id, c]));
      Object.assign(next, { credentials: [...creds.values()].filter((c) => !removedCredentials.includes(c.id)), removedCredentials });
    }
    if (i >= 0) members[i] = next;
    else members.push(next);
  }
  const rejected = [...new Map([...(doc.keyring.rejected || []), ...rejections].map((r) => [r.sig, r])).values()];
  const sharing = [...sharings].sort((a, b) => b.at.localeCompare(a.at))[0] || doc.keyring.sharing || null;
  const keyring = await applyRejections({ ...doc.keyring, members, rejected, sharing }, floor);
  const roster = await verifyRoster(keyring, floor);
  const known = await floorRoster(floor, keyring);
  if (roster.tampered || activeOf(roster).join() !== activeOf(known).join()) {
    fail(t('Der ältere Stand lässt sich nicht sicher annehmen: seine Benutzerliste weicht vom hier bekannten Stand ab.'));
  }
  const noPasskey = keyring.members.filter((m) => roster.current(m.id)?.status === 'active'
    && !(m.credentials || []).some((c) => !(m.removedCredentials || []).includes(c.id))).map((m) => m.email);
  return { keyring, roster, known, restored, noPasskey };
}

/**
 * What the dialog shows before anything is unlocked. Throws if the text is not an older state of this file or cannot be
 * taken safely. → { name, updated, fileKeyVersion, knownKeyVersion, members: [{ email, role }], restored, noPasskey }
 */
export async function describeOlder(text, floor, newerDoc = null) {
  const doc = parseFile(text);
  if (doc.version !== 2) fail(t('Nur abgesicherte Datei-Tresore haben einen Schutz vor älteren Ständen.'));
  if (floor?.id !== doc.id) fail(t('Die Datei passt nicht zum hier bekannten Tresor.'));
  const keyring = await applyRejections(doc.keyring, floor);
  const roster = await verifyRoster(keyring, floor);
  if (roster.tampered) fail(t('Die Datei wurde manipuliert: ein bekannter Eintrag der Benutzerliste wurde verändert – nicht übernommen.'));
  if (!belowFloor({ ...doc, keyring }, floor, roster)) fail(t('Die Datei ist kein älterer Stand – hier gibt es nichts anzunehmen.'));
  const r = await repairOlder(doc, floor, newerDoc);
  const members = [...r.roster.members.values()].filter((x) => x.status === 'active').map((x) => ({ email: x.member.email, role: x.role }));
  return {
    name: doc.name, updated: doc.updated || null, fileKeyVersion: doc.keyring.keyVersion || 0, knownKeyVersion: floor.keyVersion || 0,
    members, restored: r.restored, noPasskey: r.noPasskey,
  };
}

/**
 * Versions written by someone who is not active in the known state (removed, rejected, never counted here) are dropped
 * (Konrad, #435) – unless the newer state is unlocked here (newer: { doc, ck }) and holds the very same version: the
 * same revision with the same signed content, signature included (Konrad B1: id and rev alone are not encrypted, a removed
 * member could put their own backdated version under a known revision). Their deletions and restores go as well.
 * Changes doc in place. → number of versions dropped
 */
async function dropForeign(doc, ck, known, newer) {
  const active = (id) => known.current(id)?.status === 'active';
  const open = async (key, data, aad) => {
    try {
      return await key.decrypt(data, aad);
    } catch {
      return null;
    }
  };
  const plain = (id, v) => open(ck, v.data, `${doc.id}/${id}`);
  const author = (text) => {
    try {
      return JSON.parse(text).meta?.by ?? null;
    } catch {
      return null;
    }
  };
  const seen = async (id, v, text) => {
    const e = newer?.ck && newer.doc?.id === doc.id ? newer.doc.items?.[id] : null;
    const same = e && [e, ...(e.history || [])].find((x) => x?.rev === v.rev && x.data);
    return !!same && (await open(newer.ck, same.data, `${doc.id}/${id}`)) === text;
  };
  let dropped = 0;
  for (const [id, entry] of Object.entries(doc.items)) {
    if (!entry.data) continue;
    const keep = [];
    for (const v of [entry, ...(entry.history || [])]) {
      const text = await plain(id, v);
      const by = text === null ? null : author(text); // unreadable: ignored by every app anyway
      if (by === null || active(by) || (await seen(id, v, text))) keep.push(v);
      else dropped++;
    }
    const op = entry.op && !active(entry.op.by) ? null : entry.op;
    if (!keep.length) {
      delete doc.items[id];
      continue;
    }
    const [top, ...history] = keep;
    doc.items[id] = {
      ...(op ? { op, deleted: entry.deleted, deletedAt: entry.deletedAt } : {}),
      rev: top.rev, updated: top.updated, updatedBy: top.updatedBy, data: top.data,
      history: history.map((h) => ({ rev: h.rev, updated: h.updated, updatedBy: h.updatedBy, data: h.data })),
    };
  }
  return dropped;
}

/**
 * Builds the accepted state. passkey: { credentialId, prfOutput } of an admin of the known state who can open the older
 * one. newer: { doc, ck?, lost } of the newer state open here (or null; ck only if it is unlocked). Nothing is written: the caller writes
 * `text` after checking the file did not change. → { text, doc, keyVersion, dropped, lost, memberId }
 */
export async function acceptOlder(text, floor, passkey, newer = null) {
  await describeOlder(text, floor, newer?.doc);
  const doc = parseFile(text);
  const fromKeyVersion = doc.keyring.keyVersion || 0;
  const stateUpdated = doc.updated || null;
  // The admin opens the older state as it is (their wrapping of its key is there), checked against the known state.
  const u = await unlockSecure(doc.keyring, passkey.credentialId, passkey.prfOutput, floor);
  if (u.pending) fail(t('Dein Passkey öffnet diesen älteren Stand nicht (dort hattest du noch keinen Zugriff).'));
  const r = await repairOlder(doc, floor, newer?.doc);
  const me = r.known.current(u.memberId);
  if (me?.status !== 'active' || me.role !== 'admin') fail(t('Nur Admins der Datei können einen älteren Stand annehmen.'));
  const dropped = await dropForeign(doc, u.ck, r.known, newer);
  // A real key change, the generation above everything seen here and in the file.
  const next = await ContainerKey.generate();
  await recryptDoc(doc, u.ck, next, (id) => `${doc.id}/${id}`);
  doc.keyring = await rekeyMembers({ ...r.keyring, keyVersion: Math.max(floor.keyVersion || 0, fromKeyVersion) }, next, floor);
  next.kv = doc.keyring.keyVersion;
  doc.updated = Date.now();
  const v = new FileVault({ read: async () => null, write: async () => {} });
  Object.assign(v, { doc, ck: next, identity: u.identity, memberId: u.memberId });
  await v.addLog({
    action: ACCEPT_ACTION, stateUpdated, fromKeyVersion, keyVersion: next.kv, keyCheck: await keyCheck(next, doc.id, next.kv),
    dropped, lost: newer?.lost ?? null,
  }, keyChangeAt(r.roster, u.memberId)); // #521: the proof of the new key
  const out = JSON.stringify(doc, null, 1);
  // Loaded like any device would with the known state; the admin opens it, and it has exactly the known members.
  const probe = new FileVault({ read: async () => out, write: async () => {} });
  probe.floor = floor;
  await probe.unlockWithPasskey(passkey.credentialId, passkey.prfOutput);
  if (probe.role !== 'admin' || activeOf(probe.roster).join() !== activeOf(r.known).join()) {
    fail(t('Der ältere Stand lässt sich nicht sicher annehmen: seine Benutzerliste weicht vom hier bekannten Stand ab.'));
  }
  return { text: out, doc, keyVersion: next.kv, dropped, lost: newer?.lost ?? null, memberId: u.memberId };
}
