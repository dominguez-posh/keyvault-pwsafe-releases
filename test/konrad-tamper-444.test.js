import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault } from '../extension/core/filevault.js';
import { newIdentity, signObject } from '../extension/core/members.js';
import { floorOf } from '../extension/core/rollback.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #444 (Konrad, high): Konrad's PoC as a counter-test – a removal grant kept with its signature but a changed field
// made the removed admin active again. Plus the #440 follow-ups: a removal dated ahead counts at once, and a validly
// signed grant that does not count is shown to admins as an invalid entry.

const passkey = (name) => ({ credentialId: 'cred-' + name + '-' + b64uEncode(randomBytes(4)), rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
const memoryIo = () => { let text = null; return { read: async () => text, write: async (s) => { text = s; } }; };
const tick = () => new Promise((r) => setTimeout(r, 5));

async function setup() {
  const io = memoryIo();
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: passkey('alice') });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const mPk = passkey('mallory');
  const req = await new FileVault(io).requestAccess({ email: 'mallory@contoso.com', passkey: mPk });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'admin' });
  const mallory = new FileVault(io);
  await mallory.unlockWithPasskey(mPk.credentialId, mPk.prfOutput);
  const bob = await new FileVault(io).requestAccess({ email: 'bob@contoso.com', passkey: passkey('bob') });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: bob.memberId, role: 'reader' });
  await tick();
  await alice.memberOp({ type: 'remove', memberId: req.memberId });
  return { io, alice, mid: req.memberId, identity: mallory.identity, bobId: bob.memberId };
}

async function addN(doc, mid, identity, at) {
  const n = await newIdentity();
  const member = { id: 'n-account', email: 'n@evil.example', ecdh: n.ecdh, sign: n.sign, requested: at, grants: [], credentials: [], removedCredentials: [] };
  const g = { role: 'admin', status: 'active', at, by: mid };
  g.sig = await signObject(identity, { file: doc.id, member: member.id, email: member.email, ecdh: member.ecdh, sign: member.sign, role: g.role, status: g.status, at: g.at, by: g.by });
  doc.keyring.members.push({ ...member, grants: [g] });
}

test('#444 tamper: a removal grant kept with its signature but a changed field – the file is refused, also after a restart', async () => {
  const { io, alice, mid, identity } = await setup();
  assert.equal(alice.roster.current(mid).status, 'removed');
  const floor = floorOf(alice.doc, alice.roster);
  await tick();
  const doc = JSON.parse(await io.read());
  const rm = doc.keyring.members.find((m) => m.id === mid).grants.find((g) => g.status === 'removed');
  rm.role = 'admin'; rm.status = 'active';
  await addN(doc, mid, identity, new Date().toISOString());
  await io.write(JSON.stringify(doc));
  await assert.rejects(alice.load(), /manipuliert|tampered/);
  assert.equal(alice.roster.current(mid).status, 'removed', 'the vault keeps its last good state');
  const restarted = new FileVault(io);
  restarted.floor = floor;
  await assert.rejects(restarted.load(), /manipuliert|tampered/);
  // A grant whose date was made unreadable counts as changed, too.
  const doc2 = JSON.parse(await io.read());
  doc2.keyring.members.find((m) => m.id === mid).grants.find((g) => g.status === 'active').at = 42;
  await io.write(JSON.stringify(doc2));
  await assert.rejects(restarted.load(), /manipuliert|tampered/);
});

test('#440: a validly signed grant that does not count is shown to admins as an invalid entry; a reject takes the account out', async () => {
  const { io, alice, mid, identity } = await setup();
  const grants = alice.doc.keyring.members.find((m) => m.id === mid).grants;
  const a = Date.parse(grants.find((g) => g.status === 'active').at), b = Date.parse(grants.find((g) => g.status === 'removed').at);
  const doc = JSON.parse(await io.read());
  await addN(doc, mid, identity, new Date((a + b) / 2).toISOString());
  await io.write(JSON.stringify(doc));
  await alice.load();
  const n = (await alice.describeMembers('localhost')).members.find((m) => m.id === 'n-account');
  assert.equal(n.status, 'pending');
  assert.equal(n.invalid, true, 'shown as invalid entry');
  assert.ok(!(await alice.describeMembers('localhost')).members.find((m) => m.id === mid).invalid, 'Mallory herself has no grant that failed');
  // Without a floor (new device) the backdated grant still counts – the admin's signed rejection takes N out there too.
  await alice.memberOp({ type: 'reject', memberId: 'n-account' });
  const fresh = new FileVault(io);
  await fresh.load();
  assert.ok(!fresh.doc.keyring.members.some((m) => m.id === 'n-account'), 'N is taken out on a device without a floor');
});

test('#440: a removal dated ahead counts at once – the removed admin\'s later grants never count', async () => {
  const io = memoryIo();
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: passkey('alice') });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const mPk = passkey('mallory');
  const req = await new FileVault(io).requestAccess({ email: 'mallory@contoso.com', passkey: mPk });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'admin' });
  const mallory = new FileVault(io);
  await mallory.unlockWithPasskey(mPk.credentialId, mPk.prfOutput);
  // Alice's clock runs an hour ahead: her removal of Mallory is dated an hour from now.
  const hour = 60 * 60_000;
  const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...x) { super(...(x.length ? x : [RealDate.now() + hour])); } static now() { return RealDate.now() + hour; } };
  try { await alice.memberOp({ type: 'remove', memberId: req.memberId }); } finally { globalThis.Date = RealDate; }
  const bob = new FileVault(io);
  await bob.load();
  assert.equal(bob.roster.current(req.memberId).status, 'removed', 'the removal counts at once');
  // Mallory signs a new admin with the right time (before Alice's date): not counted, also not on the next load.
  const doc = JSON.parse(await io.read());
  await addN(doc, req.memberId, mallory.identity, new Date().toISOString());
  await io.write(JSON.stringify(doc));
  await bob.load();
  assert.notEqual(bob.roster.current('n-account')?.status, 'active');
  await bob.load();
  assert.notEqual(bob.roster.current('n-account')?.status, 'active');
});
