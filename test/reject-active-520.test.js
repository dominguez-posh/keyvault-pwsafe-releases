import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault } from '../extension/core/filevault.js';
import { applySecureOp } from '../extension/core/members.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #520: `reject` on an active member who signed nothing for others took them out of the file without a new container
// key – they still held the old key and could read every later write. Reject is for pending requests; on an active
// member it has to take the removal path with a key change.

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
const memoryIo = () => { let text = null; return { read: async () => text, write: async (s) => { text = s; } }; };

async function teamWithBob() {
  const io = memoryIo();
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: passkey('alice') });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const bobPk = passkey('bob');
  const req = await new FileVault(io).requestAccess({ email: 'bob@contoso.com', passkey: bobPk });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'reader' });
  const bob = new FileVault(io);
  await bob.unlockWithPasskey(bobPk.credentialId, bobPk.prfOutput);
  return { io, alice, bob, bobId: req.memberId, bobPk };
}

test('#520: reject on an active member asks for a key change in the core', async () => {
  const { alice, bobId } = await teamWithBob();
  assert.equal(alice.roster.current(bobId).status, 'active');
  const ctx = { ck: alice.ck, identity: alice.identity, memberId: alice.memberId, known: alice.known };
  const r = await applySecureOp(alice.doc.keyring, ctx, { type: 'reject', memberId: bobId });
  assert.equal(r.rotate, true, 'an active member taken out needs a new container key');
});

test('#520: after rejecting an active member, the old container key no longer opens the file', async () => {
  const { io, alice, bob, bobId, bobPk } = await teamWithBob();
  const oldKv = alice.doc.keyring.keyVersion;
  const oldCk = bob.ck;
  await alice.memberOp({ type: 'reject', memberId: bobId });
  assert.ok(alice.doc.keyring.keyVersion > oldKv, 'key version goes up');
  assert.notEqual(alice.ck, oldCk);
  await alice.saveItem({ title: 'after reject', password: 'Geheim-520' });
  await assert.rejects(new FileVault(io).unlockWithPasskey(bobPk.credentialId, bobPk.prfOutput));
  const check = new FileVault(io);
  await check.load();
  assert.notEqual(check.roster.current(bobId)?.status, 'active', 'Bob is not active any more');
});

test('#520: rejecting a pending request stays a plain rejection without a key change', async () => {
  const io = memoryIo();
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: passkey('alice') });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const req = await new FileVault(io).requestAccess({ email: 'carol@contoso.com', passkey: passkey('carol') });
  await alice.load();
  const kv = alice.doc.keyring.keyVersion;
  await alice.memberOp({ type: 'reject', memberId: req.memberId });
  assert.equal(alice.doc.keyring.keyVersion, kv, 'no key change for a request');
  assert.ok(!alice.doc.keyring.members.some((m) => m.id === req.memberId), 'request is gone');
  assert.ok(alice.doc.keyring.rejected.some((r) => r.id === req.memberId), 'signed rejection kept');
});
