// Real key change (#402): a new container key, old recovery key / password / file version no longer lead to the current data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../extension/core/protect.js';
import { FileVault, parseFile } from '../extension/core/filevault.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';
P.KEY_CHANGE.enabled = true; // switched off in the app (protect.js); these tests run with it on, one with it off

function memoryFile() {
  let text = null;
  const file = { fail: false, io: { read: async () => text, write: async (s) => { if (file.fail) throw new Error('disk full'); text = s; } } };
  Object.defineProperty(file, 'text', { get: () => text, set: (v) => { text = v; } });
  return file;
}

async function newFile() {
  const file = memoryFile();
  const { vault } = await FileVault.create(file.io, { name: 'Team', actor: 'alice' });
  const setup = await P.setupKeyring(vault.id, {
    password: 'old-password-1',
    passkey: { credentialId: 'cred-1', rpId: 'localhost', prfSalt: 's', prfOutput: b64uEncode(randomBytes(32)), label: 'Alice' },
  }, 'alice');
  vault.doc.keyring = setup.keyring;
  await vault.unlock(setup.ck);
  return { file, vault, oldRk: setup.recoveryKey };
}

test('keyring: a key change leaves only the new password and recovery key', async () => {
  const { keyring, ck, recoveryKey } = await P.setupKeyring('c1', { password: 'old-password-1', passkey: { credentialId: 'a', rpId: 'x', prfSalt: 's', prfOutput: b64uEncode(randomBytes(32)) } });
  const { keyring: invited } = await P.createInvite(keyring, ck, { label: 'Kim' });
  assert.deepEqual(P.rekeyLoss(invited), { passkeys: ['a'], invites: ['Kim'] });
  const r = await P.rekeyKeyring(invited, ck, { password: 'new-password-2' });
  assert.deepEqual(r.dropped, { passkeys: 1, invites: 1 });
  assert.equal(P.keyVersionOf(r.keyring), 2);
  assert.notDeepEqual(r.ck.raw, ck.raw, 'a different container key');
  assert.deepEqual(r.keyring.entries.map((e) => e.type).sort(), ['password', 'recovery']);
  assert.deepEqual((await P.unlockWithPassword(r.keyring, 'new-password-2')).ck.raw, r.ck.raw);
  assert.deepEqual((await P.unlockWithCode(r.keyring, r.recoveryKey)).ck.raw, r.ck.raw);
  await assert.rejects(P.unlockWithPassword(r.keyring, 'old-password-1'), P.UnlockError);
  await assert.rejects(P.unlockWithCode(r.keyring, recoveryKey), P.UnlockError);
  await assert.rejects(P.rekeyKeyring(keyring, ck, { password: 'short' }), /mindestens 8/);
});

test('keyring: old wrappers merged in from an old file version never open the new generation', async () => {
  const old = await P.setupKeyring('c1', { password: 'old-password-1' });
  const r = await P.rekeyKeyring(old.keyring, old.ck, { password: 'new-password-2' });
  for (const merged of [P.mergeKeyrings(r.keyring, old.keyring), P.mergeKeyrings(old.keyring, r.keyring)]) {
    assert.equal(P.keyVersionOf(merged), 2);
    assert.equal(merged.entries.length, 2, 'no old wrapper came back');
    await assert.rejects(P.unlockWithCode(merged, old.recoveryKey), P.UnlockError);
  }
  // An old wrapper put into the new keyring by hand: wrong generation, and the key does not match the check.
  const forged = { ...r.keyring, entries: [...r.keyring.entries, ...old.keyring.entries.map((e) => ({ ...e, kv: 2 }))] };
  await assert.rejects(P.unlockWithCode(forged, old.recoveryKey), P.UnlockError);
  await assert.rejects(P.unlockWithPassword(forged, 'old-password-1'), P.UnlockError);
  assert.equal(await P.keyMatches(r.keyring, old.ck), false);
  assert.equal(await P.keyMatches(r.keyring, r.ck), true);
});

test('file: old recovery key, old password and an old file version do not open the new state', async () => {
  const { file, vault, oldRk } = await newFile();
  await vault.saveItem({ title: 'GitHub', username: 'octo', password: 'pw-secret' }, { actor: 'alice' });
  const oldText = file.text;
  const r = await vault.rekey('new-password-2', 'alice');
  assert.equal(r.dropped.passkeys, 1);
  assert.equal(vault.summaries()[0].title, 'GitHub', 'the unlocked vault goes on with the new key');

  const fresh = new FileVault(file.io);
  await fresh.load();
  assert.equal(P.keyVersionOf(fresh.keyring), 2);
  await assert.rejects(P.unlockWithCode(fresh.keyring, oldRk), P.UnlockError);
  await assert.rejects(P.unlockWithPassword(fresh.keyring, 'old-password-1'), P.UnlockError);
  const viaNew = await P.unlockWithPassword(fresh.keyring, 'new-password-2');
  await fresh.unlock(viaNew.ck);
  assert.equal(fresh.getItem(fresh.summaries()[0].id).password, 'pw-secret');
  assert.equal((await P.unlockWithCode(fresh.keyring, r.recoveryKey)).entry.type, 'recovery');

  // The old file with the old recovery key gives the old key – and that opens nothing of the new file.
  const oldDoc = parseFile(oldText);
  const oldKey = (await P.unlockWithCode(oldDoc.keyring, oldRk)).ck;
  const stale = new FileVault({ read: async () => file.text, write: async () => {} });
  await stale.load();
  await assert.rejects(stale.unlock(oldKey), P.UnlockError);
  assert.equal(file.text.includes('pw-secret'), false);
  const newDoc = parseFile(file.text);
  for (const entry of Object.values(newDoc.items)) await assert.rejects(oldKey.decrypt(entry.data, `${newDoc.id}/${Object.keys(newDoc.items)[0]}`));
});

test('file: stopped before the write nothing changed; a second device with the old key locks and cannot overwrite', async () => {
  const { file, vault } = await newFile();
  await vault.saveItem({ title: 'GitHub', password: 'pw-1' }, { actor: 'alice' });
  const other = new FileVault(file.io);
  await other.load();
  await other.unlock((await P.unlockWithPassword(other.keyring, 'old-password-1')).ck);

  const before = file.text;
  file.fail = true;
  await assert.rejects(vault.rekey('new-password-2'), /disk full/);
  file.fail = false;
  assert.equal(file.text, before, 'the file is whole as before');
  assert.equal(P.keyVersionOf(vault.keyring), 1);
  assert.equal(vault.summaries()[0].title, 'GitHub', 'the vault still works with the old key');
  await P.unlockWithPassword(parseFile(file.text).keyring, 'old-password-1');

  await vault.rekey('new-password-2');
  await assert.rejects(other.saveItem({ title: 'Late', password: 'x' }, { actor: 'bob' }), /gewechselt|gesperrt/);
  assert.equal(other.locked, true, 'the old session is locked');
  assert.equal(parseFile(file.text).items && Object.keys(parseFile(file.text).items).length, 1, 'the late change did not land');
  await other.load();
  await assert.rejects(other.unlock((await P.unlockWithPassword(parseFile(before).keyring, 'old-password-1')).ck), P.UnlockError);
  await other.unlock((await P.unlockWithPassword(other.keyring, 'new-password-2')).ck);
  assert.equal(other.summaries()[0].title, 'GitHub');
});

test('file: a device binding with the old key (raw key from the PIN binding) is refused after the change', async () => {
  const { file, vault } = await newFile();
  await vault.saveItem({ title: 'A', password: 'x' }, { actor: 'alice' });
  const rawOld = vault.ck.raw.slice();
  await vault.rekey('new-password-2');
  const device = new FileVault(file.io);
  await device.load();
  await assert.rejects(device.unlock(rawOld), P.UnlockError);
  assert.equal(device.locked, true);
  await device.unlock(vault.ck.raw);
  assert.equal(device.locked, false);
});

test('file: the change keeps history, folders, logo and settings readable with the new key', async () => {
  const { file, vault } = await newFile();
  const a = await vault.saveItem({ title: 'A', password: 'one' }, { actor: 'alice' });
  await vault.saveItem({ ...a, password: 'two' }, { expectedVersion: a.version, actor: 'alice' });
  await vault.addFolder('Kunden/Contoso');
  await vault.setAppSettings({ lang: 'de' });
  await vault.rekey('new-password-2');
  const fresh = new FileVault(file.io);
  await fresh.load();
  await fresh.unlock((await P.unlockWithPassword(fresh.keyring, 'new-password-2')).ck);
  assert.equal(fresh.getItem(a.id).password, 'two');
  assert.equal(fresh.history(a.id).length, 2);
  assert.ok(fresh.folderList.some((f) => f.path === 'Kunden/Contoso'));
  assert.deepEqual((await fresh.appSettings()).value, { lang: 'de' });
});

test('the personal vault renews its recovery key through the real key change, with a new master password (#402)', async () => {
  const { readFileSync } = await import('node:fs');
  const personal = readFileSync(new URL('../desktop/main/personal.js', import.meta.url), 'utf8');
  const start = personal.indexOf('export async function renewPersonalRecovery(id, password)');
  assert.ok(start > 0, 'renewPersonalRecovery takes the new password');
  const body = personal.slice(start, personal.indexOf('\n}', start));
  assert.ok(body.includes("type: 'rekey', password"));
  assert.ok(body.includes('KEY_CHANGE.enabled ?'), 'the plain wrapping remains only while the key change is switched off');
  const ui = readFileSync(new URL('../desktop/renderer/app/personal.js', import.meta.url), 'utf8');
  const at = ui.indexOf('await askNewMasterPassword()');
  assert.ok(at > 0 && ui.slice(at, at + 200).includes('!password) return;'), 'cancelling the password dialog changes nothing');
  assert.ok(ui.includes("call('renewPersonalRecovery', c.id, password)"));
  assert.ok(ui.includes('KEY_CHANGE.enabled ? await askNewMasterPassword()'), 'no password dialog while switched off');
});

test('an invitation needs no key change when completed: the invited person is a member; the code stops opening the new copy', async () => {
  // The invitee unlocks with the code and holds the container key by design. A key change here would end every other
  // member's passkey and password, so completing stays a swap of the wrapper.
  const { keyring, ck } = await P.setupKeyring('c1', { password: 'old-password-1' }, 'alice');
  const { keyring: invited, inviteCode } = await P.createInvite(keyring, ck, { label: 'Kim' }, 'alice');
  const viaInvite = await P.unlockWithCode(invited, inviteCode);
  assert.deepEqual(viaInvite.ck.raw, ck.raw);
  const withOwn = await P.addPasskey(invited, viaInvite.ck, { credentialId: 'kim', rpId: 'x', prfSalt: 's', prfOutput: b64uEncode(randomBytes(32)) }, 'kim');
  const own = P.removeEntry(withOwn, viaInvite.entry.id);
  await assert.rejects(P.unlockWithCode(own, inviteCode), P.UnlockError);
  assert.deepEqual((await P.unlockWithPassword(own, 'old-password-1')).ck.raw, ck.raw, 'the other members keep their access');
});

test('switched off: a new master password or recovery key only wraps again, the key change is refused (flag in one place)', async () => {
  P.KEY_CHANGE.enabled = false;
  try {
    const { keyring, ck, recoveryKey } = await P.setupKeyring('c1', { password: 'old-password-1' }, 'alice');
    await assert.rejects(P.rekeyKeyring(keyring, ck, { password: 'new-password-2' }), /nicht eingeschaltet/);
    const renewed = await P.applyKeyringOp(keyring, ck, { type: 'newRecovery' }, 'alice');
    assert.deepEqual((await P.unlockWithCode(renewed.keyring, renewed.recoveryKey)).ck.raw, ck.raw, 'the same key, wrapped again');
    await assert.rejects(P.unlockWithCode(renewed.keyring, recoveryKey), P.UnlockError);
    assert.equal(P.keyVersionOf(renewed.keyring), 1);
    const { vault } = await newFile();
    await assert.rejects(vault.rekey('new-password-2'), /nicht eingeschaltet/);
    // Recognition stays on: a keyring of a later generation is understood and an old key is turned away.
    P.KEY_CHANGE.enabled = true;
    const r = await P.rekeyKeyring(keyring, ck, { password: 'new-password-2' });
    P.KEY_CHANGE.enabled = false;
    assert.equal(await P.keyMatches(r.keyring, ck), false);
    assert.deepEqual((await P.unlockWithPassword(r.keyring, 'new-password-2')).ck.raw, r.ck.raw);
    assert.equal(P.mergeKeyrings(keyring, r.keyring), r.keyring);
  } finally {
    P.KEY_CHANGE.enabled = true;
  }
});

test('#402 finding 2: a keyring reset by an app from before the key change is still understood (highest generation of the entries)', async () => {
  const oldMerge = (a, b) => {
    const removed = new Set([...(a.removed || []), ...(b.removed || [])]);
    const byId = new Map();
    for (const e of [...b.entries, ...a.entries]) if (!removed.has(e.id)) byId.set(e.id, e);
    return { ...a, entries: [...byId.values()], removed: [...removed] };
  };
  const s = await P.setupKeyring('c1', { password: 'old-password-1' });
  const nk = await P.rekeyKeyring(s.keyring, s.ck, { password: 'new-password-2' });
  const merged = oldMerge(s.keyring, nk.keyring); // keyVersion 1 and the old check again, entries of generation 2
  assert.equal(merged.keyVersion, 1);
  assert.equal(P.keyVersionOf(merged), 2);
  assert.deepEqual((await P.unlockWithPassword(merged, 'new-password-2')).ck.raw, nk.ck.raw);
  assert.deepEqual((await P.unlockWithCode(merged, nk.recoveryKey)).ck.raw, nk.ck.raw);
  assert.equal(await P.keyMatches(merged, s.ck), false, 'the old key is turned away');
  assert.equal(await P.keyMatches(merged, nk.ck), true);
});

test('file: after a key change the file is format 3 (older apps refuse it), a retired master password needs the key change', async () => {
  const { file, vault } = await newFile();
  await vault.saveItem({ title: 'A', password: 'x' }, { actor: 'alice' });
  assert.equal(parseFile(file.text).version, 1);
  await vault.rekey('new-password-2');
  assert.equal(parseFile(file.text).version, 3);
  const { keyring, ck } = await P.setupKeyring('c1', { password: 'old-password-1', passkey: { credentialId: 'a', rpId: 'x', prfSalt: 's', prfOutput: b64uEncode(randomBytes(32)) } });
  const noPassword = P.removeEntry(keyring, keyring.entries.find((e) => e.type === 'password').id);
  assert.equal(P.describeKeyring(noPassword, 'x').passwordRetired, true);
  await assert.rejects(P.setPassword(noPassword, ck, 'brand-new-pw-1'), /Schlüsselwechsel/);
  await assert.rejects(P.applyKeyringOp(keyring, ck, { type: 'newRecovery' }), /Schlüsselwechsel/);
  const r = await P.rekeyKeyring(noPassword, ck, { password: 'brand-new-pw-1' });
  assert.equal(r.keyring.pwRetired, undefined);
});

test('file: a change of another device between reading and writing is not thrown away; two key changes cannot both win', async () => {
  const { file, vault } = await newFile();
  await vault.saveItem({ title: 'First', password: 'x' }, { actor: 'alice' });
  const other = new FileVault(file.io);
  await other.load();
  await other.unlock((await P.unlockWithPassword(other.keyring, 'old-password-1')).ck);
  const rival = new FileVault(file.io);
  await rival.load();
  await rival.unlock((await P.unlockWithPassword(rival.keyring, 'old-password-1')).ck);

  const load = vault.load.bind(vault);
  let first = true;
  vault.load = async () => {
    const r = await load();
    if (first) {
      first = false;
      await other.saveItem({ title: 'Parallel', password: 'y' }, { actor: 'bob' }); // lands after our read
    }
    return r;
  };
  await vault.rekey('new-password-2');
  const fresh = new FileVault(file.io);
  await fresh.load();
  await fresh.unlock((await P.unlockWithPassword(fresh.keyring, 'new-password-2')).ck);
  assert.deepEqual(fresh.summaries().map((x) => x.title).sort(), ['First', 'Parallel'], 'the parallel change survived the key change');
  // The second key change on a device that still holds the old key finds the new generation and stops.
  await assert.rejects(rival.rekey('rival-password-3'), /gesperrt|gewechselt/);
  assert.equal(P.keyVersionOf(parseFile(file.text).keyring), 2, 'only one change took effect');
});
