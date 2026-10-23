import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../extension/core/protect.js';
import { FileVault, mergeDocs, parseFile } from '../extension/core/filevault.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

const prf = () => b64uEncode(randomBytes(32));

test('keyring: master password, passkeys of two users, recovery key, invitation', async () => {
  const alicePrf = prf();
  const { keyring, ck, recoveryKey } = await P.setupKeyring('c1', {
    password: 'correct horse battery',
    passkey: { credentialId: 'cred-alice', rpId: 'localhost', prfSalt: 'salt', prfOutput: alicePrf, label: 'Alice' },
  }, 'alice');
  assert.match(recoveryKey, /^RK-[A-Z2-7]{4}(-[A-Z2-7]{4})+$/);

  const viaPassword = await P.unlockWithPassword(keyring, 'correct horse battery');
  assert.deepEqual(viaPassword.ck.raw, ck.raw);
  await assert.rejects(P.unlockWithPassword(keyring, 'wrong password'), P.UnlockError);
  assert.deepEqual((await P.unlockWithPasskey(keyring, 'cred-alice', alicePrf)).ck.raw, ck.raw);
  await assert.rejects(P.unlockWithPasskey(keyring, 'cred-alice', prf()), P.UnlockError);
  assert.equal((await P.unlockWithCode(keyring, recoveryKey.toLowerCase().replace(/-/g, ' '))).entry.type, 'recovery');

  // Bob joins with an invitation and registers his own passkey.
  const { keyring: invited, inviteCode } = await P.createInvite(keyring, ck, { label: 'Bob' }, 'alice');
  const viaInvite = await P.unlockWithCode(invited, inviteCode);
  assert.equal(viaInvite.entry.type, 'invite');
  const bobPrf = prf();
  let next = await P.addPasskey(invited, viaInvite.ck, { credentialId: 'cred-bob', rpId: 'pbkj', prfSalt: 's2', prfOutput: bobPrf, label: 'Bob' }, 'bob');
  next = P.removeEntry(next, viaInvite.entry.id);
  assert.deepEqual((await P.unlockWithPasskey(next, 'cred-bob', bobPrf)).ck.raw, ck.raw);
  await assert.rejects(P.unlockWithCode(next, inviteCode), P.UnlockError);
  const info = P.describeKeyring(next, 'localhost');
  assert.equal(info.passkeys.length, 2);
  assert.deepEqual(info.passkeys.map((p) => p.usable), [true, false]);
  assert.deepEqual(P.passkeyEntries(next, 'pbkj'), [{ credentialId: 'cred-bob', prfSalt: 's2' }]);
  assert.equal(JSON.stringify(next).includes(alicePrf), false, 'no secrets in the keyring');

  // Entries of a keyring copied to another container do not open (AAD binds the scope).
  await assert.rejects(P.unlockWithPassword({ ...keyring, scope: 'other' }, 'correct horse battery'), P.UnlockError);
  const minimal = await P.setupKeyring('c3', { password: 'password-123' });
  const onlyPassword = P.removeEntry(minimal.keyring, minimal.keyring.entries.find((e) => e.type === 'recovery').id);
  assert.throws(() => P.removeEntry(onlyPassword, onlyPassword.entries[0].id), /Mindestens/);
});

test('keyring merge keeps concurrent additions and removals', async () => {
  const { keyring, ck } = await P.setupKeyring('c2', { password: 'password-123' });
  const a = await P.addPasskey(keyring, ck, { credentialId: 'a', rpId: 'x', prfSalt: 's', prfOutput: prf() });
  const b = await P.addPasskey(keyring, ck, { credentialId: 'b', rpId: 'x', prfSalt: 's', prfOutput: prf() });
  const aWithout = P.removeEntry(a, a.entries.find((e) => e.type === 'recovery').id);
  const merged = P.mergeKeyrings(aWithout, b);
  const ids = merged.entries.map((e) => e.credentialId).filter(Boolean).sort();
  assert.deepEqual(ids, ['a', 'b']);
  assert.equal(merged.entries.some((e) => e.type === 'recovery'), false);
});

function memoryFile() {
  let text = null;
  return { io: { read: async () => text, write: async (s) => { text = s; } }, get text() { return text; } };
}

test('file container: create, reopen with a second user, merge concurrent edits, history, trash', async () => {
  const file = memoryFile();
  const { vault, ck } = await FileVault.create(file.io, { name: 'Team', actor: 'alice' });
  const setup = await P.setupKeyring(vault.id, { password: 'team-password-1' }, 'alice');
  vault.doc.keyring = setup.keyring;
  await vault.unlock(setup.ck);
  void ck;
  const github = await vault.saveItem({ title: 'GitHub', username: 'octo-benutzer', password: 'pw1', urls: ['github.com'] }, { actor: 'alice' });
  assert.equal(file.text.includes('octo-benutzer'), false, 'entries are encrypted in the file');
  assert.equal(parseFile(file.text).name, 'Team');

  // A second instance (other user) opens the same file.
  const other = new FileVault(file.io);
  await other.load();
  const { ck: ck2 } = await P.unlockWithPassword(other.keyring, 'team-password-1');
  await other.unlock(ck2);
  assert.equal(other.summaries()[0].title, 'GitHub');

  // Concurrent edits: both save different entries, nothing gets lost.
  await other.saveItem({ title: 'Jira', password: 'pw2' }, { actor: 'bob' });
  await vault.saveItem({ ...github, password: 'pw1-new' }, { expectedVersion: github.version, actor: 'alice' });
  await other.load();
  assert.deepEqual(other.summaries().map((s) => s.title).sort(), ['GitHub', 'Jira']);
  assert.equal(other.getItem(github.id).password, 'pw1-new');
  await assert.rejects(other.saveItem({ ...github, password: 'stale' }, { expectedVersion: github.version }), { name: 'ConflictError' });

  const history = other.history(github.id);
  assert.equal(history.length, 2);
  assert.equal((await other.getVersion(github.id, history[1].version)).password, 'pw1');

  await other.deleteItem(github.id, 'bob');
  await vault.load();
  assert.deepEqual(vault.summaries().map((s) => s.title), ['Jira']);
  assert.equal(vault.trash()[0].title, 'GitHub');
  await vault.restore(github.id, 'alice');
  assert.equal(vault.summaries().length, 2);

  // mergeDocs: newer entry wins.
  const merged = mergeDocs({ items: { x: { updated: 2, data: 'new' } }, keyring: setup.keyring }, { items: { x: { updated: 1, data: 'old' } }, keyring: setup.keyring });
  assert.equal(merged.items.x.data, 'new');
});
