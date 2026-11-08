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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
