import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../extension/core/protect.js';
import { b64uEncode } from '../extension/core/util.js';

// #537 (Konrad): recovery and break-glass sticks as asymmetric keyring entries – the private part sealed with the stick's
// PRF, the public part open, so a key change wraps the new key for them without the stick.

const prf = (n) => b64uEncode(new Uint8Array(32).fill(n));
const stick = (n, role = 'breakglass') => ({ credentialId: `cred-${n}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: prf(n), label: `Stick ${n}`, device: 'key', role });

async function vaultWith(...sticks) {
  const r = await P.setupKeyring('scope-1', { password: 'correct horse battery' });
  let keyring = r.keyring;
  for (const s of sticks) keyring = await P.addEscrow(keyring, r.ck, s);
  return { keyring, ck: r.ck };
}

test('#537: a stick entry opens the vault with its PRF output, keeps no secret and no private key in clear', async () => {
  const { keyring, ck } = await vaultWith(stick(1));
  const e = keyring.entries.find((x) => x.type === 'escrow');
  assert.equal(e.role, 'breakglass');
  assert.ok(e.pub && e.sealedPriv && e.epk && e.wrapped);
  assert.ok(!JSON.stringify(e).includes(prf(1)), 'the PRF output is never stored');
  const r = await P.unlockWithEscrow(keyring, 'cred-1', prf(1));
  assert.equal(b64uEncode(r.ck.raw), b64uEncode(ck.raw));
  await assert.rejects(P.unlockWithEscrow(keyring, 'cred-1', prf(2)), { name: 'UnlockError' }, 'another PRF output opens nothing');
  await assert.rejects(P.unlockWithPasskey(keyring, 'cred-1', prf(1)), { name: 'UnlockError' }, 'purpose-bound: not usable as a normal passkey entry');
  await assert.rejects(P.unlockWithEscrow(keyring, 'cred-1', prf(1), { role: 'recovery' }), { name: 'UnlockError' }, 'role narrows the use');
  assert.deepEqual(P.escrowEntries(keyring, 'localhost'), [{ credentialId: 'cred-1', prfSalt: 'salt', role: 'breakglass' }]);
  assert.equal(P.describeKeyring(keyring, 'localhost').escrows[0].role, 'breakglass');
});

test('#537: a key change carries the sticks over without them – old key gone, the stick opens the new one', async () => {
  const { keyring, ck } = await vaultWith(stick(1), stick(2, 'recovery'));
  const r = await P.rekeyKeyring(keyring, ck, { password: 'a brand new password' });
  assert.notEqual(b64uEncode(r.ck.raw), b64uEncode(ck.raw));
  const sticks = r.keyring.entries.filter((e) => e.type === 'escrow');
  assert.equal(sticks.length, 2);
  for (const s of sticks) assert.equal(s.kv, P.keyVersionOf(r.keyring));
  const opened = await P.unlockWithEscrow(r.keyring, 'cred-1', prf(1));
  assert.equal(b64uEncode(opened.ck.raw), b64uEncode(r.ck.raw));
  // The entries of the old generation are removed by id; a merge with the old keyring keeps the new generation only.
  const merged = P.mergeKeyrings(keyring, r.keyring);
  assert.equal(P.keyVersionOf(merged), P.keyVersionOf(r.keyring));
  // dropEscrow ends a named stick (lost stick).
  const old2 = keyring.entries.find((e) => e.credentialId === 'cred-2').id;
  const r2 = await P.rekeyKeyring(keyring, ck, { password: 'a brand new password', dropEscrow: [old2] });
  await assert.rejects(P.unlockWithEscrow(r2.keyring, 'cred-2', prf(2)), { name: 'UnlockError' });
});

test('#537: an entry of an older generation (merged in from an old file) never opens the current key', async () => {
  const { keyring, ck } = await vaultWith(stick(1));
  const r = await P.rekeyKeyring(keyring, ck, { password: 'a brand new password', dropEscrow: keyring.entries.filter((e) => e.type === 'escrow').map((e) => e.id) });
  const stale = keyring.entries.find((e) => e.type === 'escrow');
  const tampered = { ...r.keyring, entries: [...r.keyring.entries, stale] };
  await assert.rejects(P.unlockWithEscrow(tampered, 'cred-1', prf(1)), { name: 'UnlockError' });
});

test('#537: the same stick twice, or a daily passkey as break-glass stick, is refused', async () => {
  const { keyring, ck } = await vaultWith(stick(1));
  await assert.rejects(P.addEscrow(keyring, ck, stick(1, 'recovery')), /schon eingetragen/);
  const withPasskey = await P.addPasskey(keyring, ck, { credentialId: 'cred-9', rpId: 'localhost', prfSalt: 's', prfOutput: prf(9) });
  await assert.rejects(P.addEscrow(withPasskey, ck, stick(9)), /schon eingetragen/);
  await assert.rejects(P.addEscrow(keyring, ck, { ...stick(3), role: 'admin' }), /Rolle/);
});

test('#537: a sealed private part moved to another entry or vault opens nothing; a swapped public key neither', async () => {
  const a = await vaultWith(stick(1));
  const b = await vaultWith(stick(1));
  const ea = a.keyring.entries.find((e) => e.type === 'escrow');
  const eb = b.keyring.entries.find((e) => e.type === 'escrow');
  const moved = { ...b.keyring, scope: 'scope-2', entries: b.keyring.entries.map((e) => (e === eb ? { ...e, sealedPriv: ea.sealedPriv } : e)) };
  await assert.rejects(P.unlockWithEscrow(moved, 'cred-1', prf(1)), { name: 'UnlockError' });
  const swapped = { ...a.keyring, entries: a.keyring.entries.map((e) => (e === ea ? { ...e, pub: eb.pub } : e)) };
  await assert.rejects(P.unlockWithEscrow(swapped, 'cred-1', prf(1)), { name: 'UnlockError' });
});

test('#537: a stick alone keeps the vault openable; removing the password then is allowed', async () => {
  const { keyring } = await vaultWith(stick(1));
  const noRecovery = P.removeEntry(keyring, keyring.entries.find((e) => e.type === 'recovery').id);
  const onlyStick = P.removeEntry(noRecovery, noRecovery.entries.find((e) => e.type === 'password').id);
  assert.deepEqual(onlyStick.entries.map((e) => e.type), ['escrow']);
  assert.throws(() => P.removeEntry(onlyStick, onlyStick.entries[0].id), /Mindestens/);
});

test('#537: applyKeyringOp and unlockKeyring know the stick entry', async () => {
  const r = await P.setupKeyring('scope-1', { password: 'correct horse battery' });
  const { keyring } = await P.applyKeyringOp(r.keyring, r.ck, { type: 'addEscrow', stick: stick(4, 'recovery') });
  const opened = await P.unlockKeyring(keyring, { credentialId: 'cred-4', prfOutput: prf(4), escrow: true, role: 'recovery' });
  assert.equal(opened.entry.type, 'escrow');
});

test('#537 H1: a stick entry slipped into the keyring without the container key is not carried into a key change', async () => {
  const { keyring, ck } = await vaultWith(stick(1));
  // Someone who may only write the keyring: a copy of a real entry with their own public key, or an entry of their own.
  const other = await vaultWith(stick(7));
  const theirs = other.keyring.entries.find((e) => e.type === 'escrow');
  const mine = keyring.entries.find((e) => e.type === 'escrow');
  const swapped = { ...mine, id: 'swapped', credentialId: 'cred-8', pub: theirs.pub, sealedPriv: theirs.sealedPriv };
  const planted = { ...theirs, id: 'planted', createdBy: 'Admin' };
  const tampered = { ...keyring, entries: [...keyring.entries, swapped, planted] };
  const checked = await P.checkEscrows(tampered, ck);
  assert.deepEqual(checked.map((e) => [e.id, e.valid]), [[mine.id, true], ['swapped', false], ['planted', false]]);
  const r = await P.rekeyKeyring(tampered, ck, { password: 'a brand new password' });
  assert.equal(r.dropped.escrows.length, 2, 'both reported');
  const carried = r.keyring.entries.filter((e) => e.type === 'escrow');
  assert.deepEqual(carried.map((e) => e.credentialId), ['cred-1']);
  await assert.rejects(P.unlockWithEscrow(r.keyring, 'cred-7', prf(7)), { name: 'UnlockError' }, 'the planted stick gets no new key');
  assert.deepEqual((await P.checkEscrows(r.keyring, r.ck)).map((e) => e.valid), [true], 'the carried one is vouched for by the new key');
  // A second change carries it on.
  const r2 = await P.rekeyKeyring(r.keyring, r.ck, { password: 'another new password' });
  assert.ok(await P.unlockWithEscrow(r2.keyring, 'cred-1', prf(1)));
});

test('#537 H2: the lineage – each key change seals the fingerprints of the keys before it', async () => {
  const { keyring, ck } = await vaultWith();
  const fp = await P.ckFingerprint(ck);
  const r1 = await P.rekeyKeyring(keyring, ck, { password: 'second password!' });
  const r2 = await P.rekeyKeyring(r1.keyring, r1.ck, { password: 'third password!!' });
  assert.equal(await P.descendsFrom(r2.keyring, r2.ck, fp), true);
  assert.equal(await P.descendsFrom(r2.keyring, r2.ck, await P.ckFingerprint(r1.ck)), true);
  const foreign = await P.setupKeyring('scope-1', { password: 'correct horse battery' });
  assert.equal(await P.descendsFrom(foreign.keyring, foreign.ck, fp), false, 'a vault made by someone else');
  const moved = { ...foreign.keyring, lineage: r2.keyring.lineage };
  assert.equal(await P.descendsFrom(moved, foreign.ck, fp), false, 'a lineage copied from the real vault opens with its key only');
});

test('#537 (Konrad, check of 11001ce): the key change dialog gets the validity – planted sticks never count as staying', async () => {
  const { keyring, ck } = await vaultWith(stick(1));
  const other = await vaultWith(stick(7));
  const planted = { ...other.keyring.entries.find((e) => e.type === 'escrow'), id: 'planted', label: 'Stick 1', createdBy: 'Admin' };
  const tampered = { ...keyring, entries: [...keyring.entries, planted] };
  const m = await P.withEscrowValidity(P.describeKeyring(tampered, 'localhost'), tampered, ck);
  assert.deepEqual(m.escrows.map((e) => [e.id === 'planted', e.valid]), [[false, true], [true, false]], 'same label, only the vouched one is valid');
  const locked = await P.withEscrowValidity(P.describeKeyring(tampered, 'localhost'), tampered, null);
  assert.ok(locked.escrows.every((e) => e.valid === false), 'without the key none counts as valid');
});
