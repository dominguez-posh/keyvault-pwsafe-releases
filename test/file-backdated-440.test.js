import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault } from '../extension/core/filevault.js';
import { newIdentity, signObject } from '../extension/core/members.js';
import { floorOf } from '../extension/core/rollback.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #440 (Konrad, high): a removed admin who can still write to the share signs, dated back to their admin time, a new
// admin, a rejection or the sharing setting. Whether they could sign is checked at the date they write in themselves.

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
const memoryIo = () => { let text = null; return { read: async () => text, write: async (s) => { text = s; } }; };
const tick = () => new Promise((r) => setTimeout(r, 5));
const between = (a, b) => new Date((Date.parse(a) + Date.parse(b)) / 2).toISOString();

/** Alice (admin) makes Mallory admin, Bob asks for access (pending), Alice removes Mallory. */
async function removedAdmin(io) {
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
  await tick();
  await alice.memberOp({ type: 'remove', memberId: req.memberId });
  const grants = alice.doc.keyring.members.find((m) => m.id === req.memberId).grants;
  // A date in Mallory's admin time: after her admin grant, before her removal.
  const adminTime = between(grants.find((g) => g.status === 'active').at, grants.find((g) => g.status === 'removed').at);
  return { alice, malloryId: req.memberId, identity: mallory.identity, bobId: bob.memberId, adminTime };
}

/** Mallory's own second account N with an admin grant she signs, dated back. */
async function backdatedAdmin(doc, { malloryId, identity, adminTime }) {
  const n = await newIdentity();
  const member = { id: 'n-account', email: 'n@evil.example', ecdh: n.ecdh, sign: n.sign, requested: adminTime, grants: [], credentials: [], removedCredentials: [] };
  const g = { role: 'admin', status: 'active', at: adminTime, by: malloryId };
  g.sig = await signObject(identity, { file: doc.id, member: member.id, email: member.email, ecdh: member.ecdh, sign: member.sign, role: g.role, status: g.status, at: g.at, by: g.by });
  doc.keyring.members.push({ ...member, grants: [g] });
  return doc;
}

test('#440: a removed admin signs a new admin with an old date – refused, and the next key change does not wrap for it', async () => {
  const io = memoryIo();
  const setup = await removedAdmin(io);
  const { alice, bobId } = setup;
  await io.write(JSON.stringify(await backdatedAdmin(JSON.parse(await io.read()), setup)));
  await alice.load();
  assert.notEqual(alice.roster.current('n-account')?.status, 'active', 'N is no admin');
  await alice.load();
  assert.notEqual(alice.roster.current('n-account')?.status, 'active', 'N is no admin on the next load either (what did not count is not known)');
  assert.ok(!alice.roster.accepted.has(`n-account ${alice.doc.keyring.members.find((m) => m.id === 'n-account').grants[0].sig}`));
  // The next key change (an admin removes someone) wraps the new key only for active members.
  await alice.memberOp({ type: 'approve', memberId: bobId, role: 'reader' });
  await alice.memberOp({ type: 'remove', memberId: bobId });
  assert.ok(!alice.doc.keyring.members.find((m) => m.id === 'n-account')?.wrapped, 'no key for N');

  // Also after a restart of the app, with only the remembered floor (desktop: rollback floor).
  const io2 = memoryIo();
  const setup2 = await removedAdmin(io2);
  const restarted = new FileVault(io2);
  restarted.floor = floorOf(setup2.alice.doc, setup2.alice.roster);
  await io2.write(JSON.stringify(await backdatedAdmin(JSON.parse(await io2.read()), setup2)));
  await restarted.load();
  assert.notEqual(restarted.roster.current('n-account')?.status, 'active', 'N is no admin after a restart either');

  // An own save merges the file on the disk: the backdated grant does not come in that way either.
  const io3 = memoryIo();
  const setup3 = await removedAdmin(io3);
  await io3.write(JSON.stringify(await backdatedAdmin(JSON.parse(await io3.read()), setup3)));
  await setup3.alice.memberOp({ type: 'sharing', enabled: false });
  assert.notEqual(setup3.alice.roster.current('n-account')?.status, 'active', 'N is no admin after an own save');
  // What does not count stays in the file (Konrad): nothing a save deletes can be a real entry.
  assert.equal(JSON.parse(await io3.read()).keyring.members.find((m) => m.id === 'n-account')?.grants.length, 1);
});

test('#440: a backdated rejection takes nobody out, a backdated sharing setting does not count', async () => {
  const io = memoryIo();
  const setup = await removedAdmin(io);
  const { alice, malloryId, identity, bobId, adminTime } = setup;
  await alice.memberOp({ type: 'sharing', enabled: false });
  const doc = JSON.parse(await io.read());
  const r = { id: bobId, at: adminTime, by: malloryId };
  r.sig = await signObject(identity, { file: doc.id, rejected: r.id, at: r.at, by: r.by });
  doc.keyring.rejected = [...(doc.keyring.rejected || []), r];
  const sharing = { enabled: true, at: adminTime, by: malloryId };
  sharing.sig = await signObject(identity, { file: doc.id, sharing: true, at: sharing.at, by: sharing.by });
  doc.keyring.sharing = sharing;
  await io.write(JSON.stringify(doc));
  await alice.load();
  assert.ok(alice.doc.keyring.members.some((m) => m.id === bobId), 'the backdated rejection takes Bob not out');
  assert.equal((await alice.describeMembers('localhost')).sharing, false, 'sharing stays off');
});

test('#440: what an admin signs now still counts, and a known state is not touched', async () => {
  const io = memoryIo();
  const { alice, bobId } = await removedAdmin(io);
  const other = new FileVault(io);
  other.floor = floorOf(alice.doc, alice.roster);
  await other.load();
  await alice.memberOp({ type: 'approve', memberId: bobId, role: 'editor' });
  await other.load();
  assert.equal(other.roster.current(bobId)?.status, 'active', 'a grant dated now counts');
  assert.equal(other.roster.current(bobId)?.role, 'editor');
});
