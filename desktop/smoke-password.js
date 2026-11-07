// Smoke check of #441: completing an invitation (setPassword with add) adds a password, every password entry is listed,
// "change master password" (setPassword) replaces all of them. Test vault only.

import { describeKeyring } from '../extension/core/protect.js';

export async function passwordCheck({ api, files, errors, id }) {
  const passwords = () => files.get(id).keyring.entries.filter((e) => e.type === 'password').length;
  await api.updateProtection(id, { type: 'setPassword', password: 'invite-passwort-1', add: true });
  if (passwords() !== 2) errors.push(`file: setPassword with add left ${passwords()} master passwords instead of two`);
  const listed = describeKeyring(files.get(id).keyring, 'localhost').passwords?.length;
  if (listed !== 2) errors.push(`file: describeKeyring lists ${listed} master passwords instead of two`);
  await api.updateProtection(id, { type: 'setPassword', password: 'demo-passwort-2' });
  if (passwords() !== 1) errors.push(`file: changing the master password left ${passwords()} master passwords instead of one`);
}
