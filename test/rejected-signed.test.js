import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault } from '../extension/core/filevault.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #433 (Konrad): keyring.rejected was unsigned, and merging threw out every member listed there – any writer, also a
// reader, could take an admin out of the file, and every grant that admin signed would no longer count.

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });

function memoryIo() {
  let text = null;
  return { read: async () => text, write: async (s) => { text = s; } };
}

async function join(io, admin, email, role) {
  const v = new FileVault(io);
  await v.load();
  const pk = passkey(email);
  const req = await v.requestAccess({ email, passkey: pk });
  await admin.load();
  await admin.memberOp({ type: 'approve', memberId: req.memberId, role });
  return { id: req.memberId, pk };
}

async function team() {
  const io = memoryIo();
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: passkey('alice') });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  return { io, alice };
}

const roleOf = async (io, memberId) => {
  const v = new FileVault(io);
  await v.load();
  const x = v.roster.current(memberId);
  return x ? `${x.status}/${x.role}` : 'gone';
};

test('a reader who lists the admin in rejected does not take the admin out', async () => {
  const { io, alice } = await team();
  await join(io, alice, 'rita@contoso.com', 'reader');
  const doc = JSON.parse(await io.read());
  const aliceId = alice.memberId;
  for (const forged of [aliceId, { id: aliceId, by: aliceId, at: new Date().toISOString(), sig: 'AAAA' }]) {
    await io.write(JSON.stringify({ ...doc, keyring: { ...doc.keyring, rejected: [forged] } }));
    assert.equal(await roleOf(io, aliceId), 'active/admin', `taken out by ${JSON.stringify(forged)}`);
    // Saving merges with that file: the admin stays there, too.
    await alice.load();
    await alice.rename(`Team ${Math.random()}`);
    assert.equal(await roleOf(io, aliceId), 'active/admin', 'taken out when saving');
  }
});

test('an admin deletes a removed member for good: the grants that member signed stay valid', async () => {
  const { io, alice } = await team();
  const bob = await join(io, alice, 'bob@contoso.com', 'admin');
  // Bob (admin) approves Carol: her grant is signed by Bob.
  const bobVault = new FileVault(io);
  await bobVault.load();
  await bobVault.unlockWithPasskey(bob.pk.credentialId, bob.pk.prfOutput);
  const carolVault = new FileVault(io);
  await carolVault.load();
  const carolReq = await carolVault.requestAccess({ email: 'carol@contoso.com', passkey: passkey('carol') });
  await bobVault.load();
  await bobVault.memberOp({ type: 'approve', memberId: carolReq.memberId, role: 'editor' });
  await alice.load();
  await alice.memberOp({ type: 'remove', memberId: bob.id });
  await alice.load();
  await alice.memberOp({ type: 'remove', memberId: bob.id }); // the second time: delete for good
  assert.equal(await roleOf(io, carolReq.memberId), 'active/editor');
  const view = await alice.describeMembers('localhost');
  assert.ok(!view.members.some((m) => m.email === 'bob@contoso.com'), 'deleted member still listed');
});

test('a rejected request stays rejected when an older copy still holds it', async () => {
  const { io, alice } = await team();
  const v = new FileVault(io);
  await v.load();
  const req = await v.requestAccess({ email: 'eve@contoso.com', passkey: passkey('eve') });
  const withRequest = await io.read();
  await alice.load();
  await alice.memberOp({ type: 'reject', memberId: req.memberId });
  assert.equal(await roleOf(io, req.memberId), 'gone');
  // Another device saves from the copy that still had the request: merged, it does not come back.
  const other = new FileVault({ read: io.read, write: io.write });
  const old = memoryIo();
  await old.write(withRequest);
  other.io = old;
  await other.load();
  other.io = io;
  other.doc.updated = Date.now();
  await other.persist().catch(() => {});
  assert.equal(await roleOf(io, req.memberId), 'gone');
});
