// Smoke check of the real key change (#402), part of the recovery key check (desktop/smoke-recovery-key.js). Test vault
// in a test folder only. Checked: the change returns a new recovery key and names what ends (a passkey), the old master
// password and the old recovery key open nothing afterwards, the new password opens it with all entries still there, and
// the file on disk after the change does not decrypt with the key from before.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function rekeyCheck({ api, fail }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-smoke-rekey-'));
  try {
    const created = await api.createFile({ path: path.join(dir, 'rekey.kvpws'), name: 'Schluesselwechsel', password: 'old-password-1', passkeyLabel: 'Smoke' });
    await api.save(created.id, { title: 'Wechsel-Eintrag', username: 'u', password: 'secret-before', urls: ['https://example.com'] });
    const before = fs.readFileSync(path.join(dir, 'rekey.kvpws'), 'utf8');
    const r = await api.updateProtection(created.id, { type: 'rekey', password: 'new-password-2' });
    if (!/^RK-/.test(r?.recoveryKey || '') || r.recoveryKey === created.recoveryKey) fail('the key change gave no new recovery key');
    if (r?.dropped?.passkeys !== 1) fail(`the key change did not report the passkey that ends (${JSON.stringify(r?.dropped)})`);
    await api.lockContainer(created.id);
    for (const [what, params] of [['old password', { password: 'old-password-1' }], ['old recovery key', { code: created.recoveryKey }]]) {
      if (await api.unlockContainer(created.id, params).then(() => true, () => false)) fail(`the ${what} still opens the vault after the key change`);
    }
    if (!(await api.unlockContainer(created.id, { password: 'new-password-2' }).then(() => true, () => false))) fail('the new password does not open the vault');
    else if (!(await api.items()).some((s) => s.title === 'Wechsel-Eintrag')) fail('the entry is gone after the key change');
    const after = fs.readFileSync(path.join(dir, 'rekey.kvpws'), 'utf8');
    if (after === before || JSON.parse(after).keyring.keyVersion !== 2) fail('the file does not carry the new key generation');
    if (JSON.stringify(JSON.parse(after).items) === JSON.stringify(JSON.parse(before).items)) fail('the entries in the file were not encrypted again');

    // Removing the master password retires passwords (pwRetired): no new one without a key change, and the next key
    // change brings one back.
    const methods = async () => (await api.protectionInfo(created.id))?.methods || {};
    const pw = (await methods()).passwordId;
    if (!pw) fail('no master password listed after the key change');
    else {
      await api.updateProtection(created.id, { type: 'removeEntry', entryId: pw });
      const m = await methods();
      if (!m.passwordRetired || m.password) fail(`removing the master password did not retire it (${JSON.stringify({ retired: m.passwordRetired, password: m.password })})`);
      if (!m.passwordNeedsRekey) fail('"Masterpasswort festlegen" would not go through the key change after removing the password');
      if (!m.keyChange) fail('the protection info does not report the key change as switched on');
      const refused = await api.updateProtection(created.id, { type: 'setPassword', password: 'plain-password-3' }).then(() => null, (e) => e.message);
      if (!refused || !/Schlüsselwechsel|key change/.test(refused)) fail(`a new master password was set without a key change after removing one (${refused})`);
      const again = await api.updateProtection(created.id, { type: 'rekey', password: 'rekeyed-password-4' }).catch((e) => fail(`the key change after removing the password failed: ${e.message}`));
      const back = await methods();
      if (again && (!back.password || back.passwordRetired)) fail('the key change did not bring the master password back');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
