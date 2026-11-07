// What a person compares before accepting a file vault that replaced the one seen at a path before (#404): the creator
// and a safety code. Secured files: the creator is the member whose signing key is the file's root, the code is that
// member's safety code (the one shown for access requests). Files with a master password have no creator: the code is
// derived from the file ID. Both are compared with the creator outside the app (phone, in person).

import crypto from 'node:crypto';
import { safetyCode } from '../extension/core/members.js';

const idCode = (id) => {
  const hash = crypto.createHash('sha256').update(`kvpwsafe-file|${id}`).digest();
  return [...hash.subarray(0, 8)].map((b) => String(b % 100).padStart(2, '0')).join('').match(/.{4}/g).join(' ');
};

/** vault: a loaded FileVault (locked is fine) → { id, name, creator (e-mail or ''), code }. */
export async function vaultIdentity(vault) {
  const keyring = vault.keyring;
  const creator = vault.secure ? (keyring?.members || []).find((m) => m.sign && m.sign === keyring.root) : null;
  return {
    id: vault.id,
    name: vault.name || '',
    secure: !!vault.secure, // remembered with the ID: a secured file never comes back in the old format (#430)
    creator: creator?.email || '',
    code: creator ? await safetyCode(creator) : idCode(vault.id),
  };
}
