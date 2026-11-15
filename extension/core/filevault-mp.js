// #539 Etappe 8: FileVault steps of the member identity at the app's master password (filevault.js is at its size
// limit). The member key in the personal vault, and replacing one's own identity in a secured file.

import { t } from './i18n.js';
import { verifyRoster, applySecureOp } from './members.js';
import { openMemberKeys, sealMemberKey } from './member-app.js';
import { requestReplacement, passkeyOnlyEnabled } from './members-mp.js';
import { keyChangeSigned } from './key-proof.js';

/** The member keys kept in this (personal) vault that open with its key: [{ gen, fp, mk, compromised }] (current first). */
export function readMemberKeys(vault) {
  vault.requireUnlocked();
  return openMemberKeys(vault.ck, vault.doc.memberKeys, (x) => vault.aad(x));
}

/** Entries in the file, readable or not (H1: never create a first key over one that is there but unreadable). */
export const memberKeyCount = (vault) => (Array.isArray(vault.doc?.memberKeys) ? vault.doc.memberKeys.length : 0);

/** Writes keys ([{ mk, gen, compromised }]) under the vault's current key; an entry of the same key is replaced. */
export async function writeMemberKeys(vault, keys) {
  vault.requireWrite();
  if (vault.secure) throw new Error('member key belongs to the personal vault');
  const sealed = [];
  for (const k of keys) sealed.push(await sealMemberKey(vault.ck, k, (x) => vault.aad(x)));
  const fps = new Set(sealed.map((e) => e.fp));
  vault.doc.memberKeys = [...(vault.doc.memberKeys || []).filter((e) => !fps.has(e?.fp)), ...sealed];
  vault.doc.updated = Date.now();
  await vault.persist();
}

/**
 * "Master password compromised": a new identity for this secured file with the new member key mk, replacing the one
 * open right now. An active admin approves it at once (approve with the old identity, then the old one is removed with
 * the new one, key change signed by the new one); everyone else leaves a request for the admins.
 * → { replaced: boolean, memberId, safetyCode }
 */
export async function replaceOwnIdentity(vault, mk) {
  vault.requireUnlocked();
  if (!vault.secure) throw new Error(t('Nur abgesicherte Dateien haben Benutzer'));
  // Konrad (low): only an active member, and never where "passkeys only" holds (the new identity has only the app credential).
  if (passkeyOnlyEnabled(vault.doc.keyring, vault.roster, vault.known)) throw new Error(t('Dieser Tresor lässt sich nur mit Passkey öffnen'));
  if (vault.roster?.current(vault.memberId)?.status !== 'active') throw new Error(t('Dein Zugriff auf diese Datei wurde entfernt'));
  const [oldId, oldIdentity] = [vault.memberId, vault.identity];
  const undo = [structuredClone(vault.doc), vault.ck, vault.roster, vault.wrapSeen, vault.identity, vault.memberId];
  const restore = () => { [vault.doc, vault.ck, vault.roster, vault.wrapSeen, vault.identity, vault.memberId] = undo; };
  const r = await requestReplacement(vault.doc.keyring, { oldMemberId: oldId, oldIdentity, mk });
  vault.doc.keyring = r.keyring;
  vault.roster = await verifyRoster(vault.doc.keyring, vault.known);
  const me = vault.roster.current(oldId);
  const admin = me?.status === 'active' && me.role === 'admin';
  try {
    if (admin) {
      const ctx = { ck: vault.ck, identity: oldIdentity, memberId: oldId, known: vault.known };
      vault.doc.keyring = (await applySecureOp(vault.doc.keyring, ctx, { type: 'approve', memberId: r.memberId, role: 'admin' })).keyring;
      vault.roster = await verifyRoster(vault.doc.keyring, vault.known);
      Object.assign(vault, { identity: r.identity, memberId: r.memberId });
      vault.doc.keyring = (await applySecureOp(vault.doc.keyring, { ...ctx, identity: r.identity, memberId: r.memberId }, { type: 'remove', memberId: oldId })).keyring;
      vault.roster = await verifyRoster(vault.doc.keyring, vault.known);
      await vault.addLog({ action: 'member-replace', target: vault.memberEmail(r.memberId) });
      await vault.rotateKey();
      if (!(await keyChangeSigned(vault.doc, vault.ck, vault.roster, vault.ck.kv))) {
        throw new Error(t('Der Schlüsselwechsel ließ sich nicht gültig nachweisen (Uhrzeit dieses Geräts prüfen) – nichts gespeichert.'));
      }
    }
    vault.doc.updated = Date.now();
    await vault.persist();
  } catch (e) {
    restore();
    throw e;
  }
  return { replaced: admin, memberId: r.memberId, safetyCode: r.safetyCode };
}
