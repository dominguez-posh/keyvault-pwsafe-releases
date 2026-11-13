// #521 (Konrad): the wrapping of the container key for a member (ECDH-ES, members.js wrapKey) is not authenticated – anyone
// with write access to the share could wrap a key of their own for a member. A container key therefore counts only with
// a proof inside the file: an entry of the signed change log that opens with exactly this key, names its generation, and
// is signed by someone who was an admin at that time and is not removed today.
//
// Not removed today, instead of comparing dates: the signer writes the date themselves (#440), so a removed admin could
// date a forged key change back to their admin time – but every removal of a member with access changes the key again, so
// the proof of the current generation is never by a removed member. Clocks running apart do not matter for it.
//
// The signer is taken from the roster (the member object whose grants were checked), never from a lookup of their ID in
// the file: a second entry with the same ID and another signing key is refused as tampered (verifyRoster).
//
// Key check (Konrad 3): new proofs carry `keyCheck`, an HKDF value of the key, the file ID and the generation, inside the
// signed payload – the signature then binds the key itself, not only the generation. Proofs written before (no keyCheck)
// still count: replaying such an old body under another key needs the old key and a generation going back, which the
// floor refuses (rollback.js) and which an open device never follows; left is a device without a floor (as in #440).

import { verifyObject, signedAt, FUTURE_SLACK_MS } from './members.js';
import { hkdf } from './protect.js';
import { b64uEncode } from './util.js';
import { t } from './i18n.js';

/** Log actions that bring a new container key: removal and #520 (key-rotate), an older state taken on purpose (#435). */
export const KEY_CHANGE_ACTIONS = ['key-rotate', 'older-state-accept'];

export const keyUnsignedMessage = () => t('Der Tresor-Schlüssel in der Datei wurde nicht von einem Admin gesetzt – nicht übernommen, der bisherige Schlüssel bleibt. Bitte einen Admin der Datei informieren.');

/** One-way check value of a container key for this file and generation (no key material). */
export async function keyCheck(ck, fileId, kv) {
  return b64uEncode((await hkdf(ck.raw, `kvpwsafe/key-proof/${fileId}/${kv}`)).slice(0, 16));
}

/**
 * The date for the log entry of a key change: after the signer's own last entry (#440), but not further ahead than half of
 * what the others accept (FUTURE_SLACK_MS, Konrad 4) – unless that would date it before the signer became admin (an admin
 * with a clock ahead named them): then the own date stays, the proof must not fall before the admin grant (Konrad, p521b).
 */
export function keyChangeAt(roster, memberId, nowMs = Date.now()) {
  const own = signedAt(roster, memberId, nowMs);
  const capped = new Date(Math.min(Date.parse(own), nowMs + FUTURE_SLACK_MS / 2)).toISOString();
  return !roster.roleAt || roster.roleAt(memberId, capped) === 'admin' ? capped : own;
}

/**
 * Is `ck` the container key of generation `kv` put there by an admin? doc: the secured document, roster: verifyRoster of
 * its keyring. Generation 1 is the creator's key: its proof is the signed file-create entry.
 */
export async function keyChangeSigned(doc, ck, roster, kv, nowMs = Date.now()) {
  const limit = new Date(nowMs + FUTURE_SLACK_MS).toISOString();
  const check = await keyCheck(ck, doc.id, kv);
  // In file order: the proof is the first entry sealed with a new key (key change, older state taken, creation log it first).
  const entries = (doc.log || []).filter((e) => e?.kv === kv && typeof e.id === 'string' && typeof e.data === 'string');
  for (const e of entries) {
    let inner;
    try {
      inner = JSON.parse(await ck.decrypt(e.data, `${doc.id}/log/${e.id}`));
    } catch {
      continue; // sealed with another key
    }
    const { sig, ...body } = inner || {};
    const { meta, payload } = body;
    const proves = kv === 1 ? payload?.action === 'file-create' : KEY_CHANGE_ACTIONS.includes(payload?.action) && payload.keyVersion === kv;
    if (!proves || meta?.id !== e.id || typeof meta.at !== 'string' || meta.at > limit) continue;
    if (payload.keyCheck !== undefined && payload.keyCheck !== check) continue;
    const signer = roster.current(meta.by);
    if (signer?.status !== 'active' || roster.roleAt(meta.by, meta.at) !== 'admin') continue;
    if (await verifyObject(signer.member.sign, { file: doc.id, ...body }, sig)) return true;
  }
  return false;
}

/**
 * #523: would writing `merged` (the disk's document merged with the vault's) take the proof of the vault's key away? An
 * older generation on the disk can bring the removal of the admin who set our key (a write race: their removal by another
 * admin, written over a state it had not read). Merged, the current key would have no proof that counts and nobody could
 * unlock freshly. Only a proof the merge loses counts here – a vault whose key had none before is left as it was.
 */
export async function mergeLosesProof(vault, merged, mergedRoster) {
  const kv = vault.ck.kv ?? vault.doc.keyring.keyVersion;
  return !(await keyChangeSigned(merged, vault.ck, mergedRoster, kv)) && keyChangeSigned(vault.doc, vault.ck, vault.roster, kv);
}
