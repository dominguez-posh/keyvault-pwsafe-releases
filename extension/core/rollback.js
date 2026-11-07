// No going back to an older state of a secured file (#432). A former member who can still write to the share could put
// back an old copy: their role and signed entries would count again, and new entries of the others would be encrypted
// with the old key they know. Whoever saw a state remembers its floor – the highest key version and every grant
// signature – and refuses a file below it. Grants only ever get added; a member taken out entirely is listed in
// `rejected`, so their grants may go.

import { applyRejections } from './members.js';

/**
 * Floor of a secured document: { id, keyVersion, grants: ["memberId sig", …], signed?: [sig, …], members?: […] }; null
 * for other formats. With the document's roster (#440) it holds only what counted: the accepted grants, and in `signed`
 * the rejections and the sharing setting that count. What did not count stays in the file but never becomes "known".
 * `members` (#446): those grants whole, with the signed member data ({ id, email, ecdh, sign, grants }) – a known grant
 * changed in the file can be put back from it (repairFromFloor).
 */
export function floorOf(doc, roster = null) {
  if (doc?.version !== 2 || !doc.keyring) return null;
  const all = (doc.keyring.members || []).flatMap((m) => (m.grants || []).map((g) => `${m.id} ${g.sig}`));
  const counted = roster?.accepted ? all.filter((k) => roster.accepted.has(k)) : all;
  const signed = roster?.counts ? [...(doc.keyring.rejected || []), doc.keyring.sharing].filter((x) => x?.sig && roster.counts(x)).map((x) => x.sig) : null;
  const members = roster?.accepted ? (doc.keyring.members || []).map((m) => ({
    id: m.id, email: m.email, ecdh: m.ecdh, sign: m.sign, grants: (m.grants || []).filter((g) => roster.accepted.has(`${m.id} ${g.sig}`)),
  })).filter((m) => m.grants.length) : null;
  return { id: doc.id, keyVersion: doc.keyring.keyVersion || 0, grants: counted, ...(signed ? { signed } : {}), ...(members ? { members } : {}) };
}

function mergeMembers(a = [], b = []) {
  const byId = new Map();
  for (const m of [...a, ...b]) {
    const x = byId.get(m.id);
    if (!x) byId.set(m.id, { ...m, grants: [...m.grants] });
    else for (const g of m.grants) if (!x.grants.some((y) => y.sig === g.sig)) x.grants.push(g);
  }
  return [...byId.values()];
}

/** The higher of two floors of the same file (another file's floor is dropped). */
export function mergeFloors(a, b) {
  if (!a || !b || a.id !== b.id) return b || a || null;
  const signed = a.signed || b.signed ? { signed: [...new Set([...(a.signed || []), ...(b.signed || [])])] } : {};
  const members = a.members || b.members ? { members: mergeMembers(a.members, b.members) } : {};
  return { id: a.id, keyVersion: Math.max(a.keyVersion || 0, b.keyVersion || 0), grants: [...new Set([...(a.grants || []), ...(b.grants || [])])], ...signed, ...members };
}

/**
 * #446: a file refused because a known grant was changed or taken out is put back to the known state – every grant of
 * the floor exactly as it was signed, with the member data it was signed for; everything else in the file stays. A
 * member restored that a counting rejection took out goes again (applyRejections). Returns the repaired document, or
 * null if the floor cannot repair it (other file, older key version, a floor from before #446). The caller loads the
 * result with the floor before writing it: only what passes there is written.
 */
export async function repairFromFloor(doc, floor) {
  if (doc?.version !== 2 || !doc.keyring || !floor?.members?.length || floor.id !== doc.id) return null;
  if ((doc.keyring.keyVersion || 0) < (floor.keyVersion || 0)) return null;
  const members = [...(doc.keyring.members || [])];
  for (const f of floor.members) {
    const i = members.findIndex((m) => m.id === f.id);
    const cur = i >= 0 ? members[i] : { id: f.id, requested: f.grants[0]?.at, credentials: [], removedCredentials: [], wrapped: null };
    const sigs = new Set(f.grants.map((g) => g.sig));
    const next = { ...cur, email: f.email, ecdh: f.ecdh, sign: f.sign, grants: [...f.grants, ...(cur.grants || []).filter((g) => !sigs.has(g?.sig))] };
    if (i >= 0) members[i] = next;
    else members.push(next);
  }
  const keyring = await applyRejections({ ...doc.keyring, members }, floor);
  return { ...doc, keyring };
}

/**
 * Is this document an older state than the floor seen for its ID? roster: the document's (verifyRoster with the floor);
 * without it every listed rejection excuses.
 */
export function belowFloor(doc, floor, roster = null) {
  const now = floorOf(doc);
  if (!now || !floor || floor.id !== now.id) return false;
  if (now.keyVersion < (floor.keyVersion || 0)) return true;
  const have = new Set(now.grants);
  // A missing grant is excused only for a member taken out entirely: listed in rejected AND no longer among the
  // members. Listed but still there would let a removed member drop their "removed" grant (Konrad, #432). And only by a
  // rejection that counts (#446): one dated back by a removed admin would delete a member quietly.
  const present = new Set((doc.keyring.members || []).map((m) => m.id));
  const rejections = (doc.keyring.rejected || []).filter((x) => !roster?.counts || roster.counts(x));
  const gone = new Set(rejections.map((x) => x?.id ?? x).filter((id) => !present.has(id)));
  return (floor.grants || []).some((g) => !have.has(g) && !gone.has(g.split(' ')[0]));
}
