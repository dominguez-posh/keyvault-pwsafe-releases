import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault } from '../extension/core/filevault.js';
import { floorOf, mergeFloors } from '../extension/core/rollback.js';
import { acceptOlder, describeOlder } from '../extension/core/rollback-accept.js';
import { verifyRoster } from '../extension/core/members.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #435: an older state of a secured file taken on purpose by an admin – lifted above the floor, never past it.

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
const memoryIo = () => { let text = null; return { read: async () => text, write: async (s) => { text = s; } }; };
const tick = () => new Promise((r) => setTimeout(r, 5));
const pk = (p) => ({ credentialId: p.credentialId, prfOutput: p.prfOutput });
const floorOfVault = (v) => mergeFloors(v.floor, floorOf(v.doc, v.roster));

/**
 * Alice admin, Bob and Carol editors; Bob writes an entry; the backup is taken; Alice adds an entry and removes Bob
 * (new key). Returns the vaults, passkeys and the backup text.
 */
export async function team(io = memoryIo()) {
  const pks = { alice: passkey('alice'), bob: passkey('bob'), carol: passkey('carol') };
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: pks.alice });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const bobReq = await new FileVault(io).requestAccess({ email: 'bob@contoso.com', passkey: pks.bob });
  const carolReq = await new FileVault(io).requestAccess({ email: 'carol@contoso.com', passkey: pks.carol });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: bobReq.memberId, role: 'editor' });
  await alice.memberOp({ type: 'approve', memberId: carolReq.memberId, role: 'editor' });
  const bob = new FileVault(io);
  await bob.unlockWithPasskey(pks.bob.credentialId, pks.bob.prfOutput);
  const bobItem = await bob.saveItem({ type: 'login', title: 'Bob wrote this', password: 'b' });
  await alice.saveItem({ type: 'login', title: 'Shared', password: 's' });
  const backup = await io.read();
  await tick();
  const lostItem = await alice.saveItem({ type: 'login', title: 'Only in the newer state', password: 'n' });
  await alice.memberOp({ type: 'remove', memberId: bobReq.memberId });
  await alice.load();
  return { io, pks, alice, bob, backup, bobId: bobReq.memberId, carolId: carolReq.memberId, bobItem, lostItem };
}

test('#435: the backup is refused, and accepted on purpose it is lifted above the floor', async () => {
  const { io, pks, alice, backup, bobId, bobItem, lostItem } = await team();
  const floor = floorOfVault(alice);
  assert.ok(floor.sharings?.length === 1 && Array.isArray(floor.rejections), 'the floor keeps the counted rejections and sharing settings whole, apart');
  const current = await io.read();
  await io.write(backup);
  await assert.rejects(alice.load(), (e) => e.code === 'older');

  const info = await describeOlder(backup, floor);
  assert.ok(info.fileKeyVersion < info.knownKeyVersion);
  assert.deepEqual(info.members.map((m) => m.email).sort(), ['alice@contoso.com', 'carol@contoso.com']);
  assert.ok(info.restored.includes('bob@contoso.com'), 'Bob\'s removal goes back in');

  const r = await acceptOlder(backup, floor, pk(pks.alice));
  assert.equal(r.keyVersion, floor.keyVersion + 1);
  assert.equal(r.dropped, 1, 'Bob\'s version is dropped – he is removed in the known state');
  await io.write(r.text);

  // The admin's device takes it with its old floor and follows the key change.
  await alice.load();
  assert.ok(!alice.locked);
  const titles = alice.summaries().map((s) => s.title);
  assert.ok(titles.includes('Shared'));
  assert.ok(!titles.includes('Bob wrote this') && !titles.includes(lostItem.title));
  assert.ok(!alice.summaries().some((s) => s.id === bobItem.id));
  const log = await alice.changelog();
  assert.equal(log[0].action, 'older-state-accept');
  assert.equal(log[0].dropped, 1);

  // Bob stays out: no wrapping for him, his passkey opens nothing.
  const asBob = new FileVault(io);
  await assert.rejects(asBob.unlockWithPasskey(pks.bob.credentialId, pks.bob.prfOutput), /entfernt|removed/);
  // The old current state is now older than what Alice saw.
  await io.write(current);
  await assert.rejects(alice.load(), (e) => e.code === 'older');
});

test('#435: a version of a removed author that is in the newer state open here stays', async () => {
  const { io, pks, alice, backup, bobItem } = await team();
  const floor = floorOfVault(alice);
  const r = await acceptOlder(backup, floor, pk(pks.alice), { doc: alice.doc, ck: alice.ck, lost: ['Only in the newer state'] });
  assert.equal(r.dropped, 0);
  await io.write(r.text);
  await alice.load();
  assert.ok(alice.summaries().some((s) => s.id === bobItem.id));
  assert.deepEqual((await alice.changelog())[0].lost, ['Only in the newer state']);
});

test('#435 counter-tests: an editor, a removed member, another file and an incomplete floor are refused', async () => {
  const { pks, alice, backup } = await team();
  const floor = floorOfVault(alice);
  await assert.rejects(acceptOlder(backup, floor, pk(pks.carol)), /Nur Admins|Only admins/);
  await assert.rejects(acceptOlder(backup, floor, pk(pks.bob)), /entfernt|removed|Nur Admins|Only admins/);
  await assert.rejects(acceptOlder(backup, { ...floor, id: 'file-other' }, pk(pks.alice)), /passt nicht|does not match/);
  // A floor from before #435: signatures without their objects.
  const { rejections: _r, sharings: _s, ...old } = floor;
  await assert.rejects(acceptOlder(backup, old, pk(pks.alice)), /unvollständig|incomplete/);
  await assert.rejects(acceptOlder(backup, { ...floor, sharings: [] }, pk(pks.alice)), /unvollständig|incomplete/);
  // The current state is no older state.
  await assert.rejects(describeOlder(JSON.stringify(alice.doc), floor), /kein älterer Stand|not an older state/);
});

test('#435 (Konrad 1): a member list that differs from the known state is refused before anything is written', async () => {
  const { pks, alice, backup, carolId } = await team();
  const floor = floorOfVault(alice);
  // A known member dropped from the floor's own list would make Carol's grant missing in the result's roster check.
  const doc = JSON.parse(backup);
  const carol = doc.keyring.members.find((m) => m.id === carolId);
  carol.grants = carol.grants.map((g) => ({ ...g, role: 'admin' })); // signature no longer fits
  await assert.rejects(acceptOlder(JSON.stringify(doc), floor, pk(pks.alice)), /manipuliert|tampered|weicht|differs/);
});

test('#435 (Konrad 3, a): same generation with another wrapping is a key change – saveItem follows, memberOp reloads', async () => {
  const { io, pks, alice, backup } = await team();
  const floor = floorOfVault(alice);
  // Carol's device with the newer state open and an entry nobody saved elsewhere.
  const carol = new FileVault(io);
  carol.floor = floor;
  await carol.unlockWithPasskey(pks.carol.credentialId, pks.carol.prfOutput);
  // Two admins' devices accept the same backup: same generation, two different keys.
  const first = await acceptOlder(backup, floor, pk(pks.alice));
  const second = await acceptOlder(backup, floor, pk(pks.alice));
  assert.equal(first.keyVersion, second.keyVersion);
  await io.write(first.text);
  await carol.load();
  const stale = structuredClone(carol.doc);
  await io.write(second.text);
  // memberOp on the stale document: refused and reloaded, the file keeps the second state.
  carol.doc = stale;
  await assert.rejects(carol.memberOp({ type: 'addCredential', passkey: passkey('carol-2') }), /neu verschlüsselt|re-encrypted/);
  assert.equal(await io.read(), second.text);
  // saveItem reads first, follows the new key and writes readable for everyone.
  const saved = await carol.saveItem({ type: 'login', title: 'After the accept', password: 'x' });
  await alice.load();
  assert.equal(alice.getItem(saved.id).title, 'After the accept');
  assert.ok(!alice.summaries().some((s) => s.title === 'Only in the newer state'), 'nothing of the newer state comes back');
});

test('#435 (a): an entry only in memory of another device is dropped, not merged back', async () => {
  const { io, pks, alice, backup } = await team();
  const floor = floorOfVault(alice);
  const carol = new FileVault(io);
  carol.floor = floor;
  await carol.unlockWithPasskey(pks.carol.credentialId, pks.carol.prfOutput);
  const r = await acceptOlder(backup, floor, pk(pks.alice));
  await io.write(r.text);
  // Carol's device still holds the newer state (older generation): a change without reading first is refused.
  await assert.rejects(carol.memberOp({ type: 'sharing', enabled: false }), /neu verschlüsselt|re-encrypted|Admins/);
  await carol.saveItem({ type: 'login', title: 'Carol after', password: 'c' });
  const doc = JSON.parse(await io.read());
  assert.equal(doc.keyring.keyVersion, r.keyVersion);
  await alice.load();
  const titles = alice.summaries().map((s) => s.title);
  assert.ok(titles.includes('Carol after') && !titles.includes('Only in the newer state'));
});

test('#435 (Konrad 1): a rejection known here goes back in – a member taken out stays out of the accepted state', async () => {
  // Dave's request is open in the backup; later Dave is rejected and Carol removed (which makes the backup older).
  const real = await team();
  const dave = await new FileVault(real.io).requestAccess({ email: 'dave@contoso.com', passkey: passkey('dave') });
  const backup = await real.io.read();
  await real.alice.load();
  await real.alice.memberOp({ type: 'reject', memberId: dave.memberId });
  await real.alice.memberOp({ type: 'remove', memberId: real.carolId });
  await real.alice.load();
  const f2 = floorOfVault(real.alice);
  const accepted = await acceptOlder(backup, f2, pk(real.pks.alice));
  assert.ok(accepted.doc.keyring.rejected.some((x) => x.id === dave.memberId), 'the rejection is back');
  assert.ok(!accepted.doc.keyring.members.some((m) => m.id === dave.memberId), 'Dave is out');
});

test('#435 (Konrad B1): a removed member’s own version under a known revision is dropped – only the same signed version stays', async () => {
  const { pks, alice, bob, backup, bobId, bobItem } = await team();
  const floor = floorOfVault(alice);
  const doc = JSON.parse(backup);
  // Bob still holds the old key: he puts a backdated version of his own under the revision the newer state knows.
  const at = new Date(Date.now() - 3_600_000).toISOString();
  doc.items[bobItem.id].data = await bob.sealSigned({ meta: { id: bobItem.id, rev: bobItem.version, by: bobId, at }, item: { v: 1, type: 'login', title: 'Forged', password: 'evil' } }, bob.aad(bobItem.id));
  const forged = await acceptOlder(JSON.stringify(doc), floor, pk(pks.alice), { doc: alice.doc, ck: alice.ck, lost: [] });
  assert.equal(forged.dropped, 1, 'same rev, other content: dropped');
  assert.ok(!forged.doc.items[bobItem.id], 'nothing of it is left');
  // Without the newer state unlocked here nothing can be compared: dropped as well.
  assert.equal((await acceptOlder(backup, floor, pk(pks.alice), { doc: alice.doc, ck: null, lost: null })).dropped, 1);
});

test('#435 (Konrad B2): the floor takes the sharing setting only with a valid signature, and keeps it apart from rejections', async () => {
  const { alice } = await team();
  const roster = alice.roster;
  const good = floorOf(alice.doc, roster);
  assert.equal(good.sharings.length, 1);
  assert.ok(good.rejections.every((x) => !('enabled' in x)));
  const bad = { ...alice.doc, keyring: { ...alice.doc.keyring, sharing: { ...alice.doc.keyring.sharing, enabled: false } } };
  const badRoster = await verifyRoster(bad.keyring, good);
  assert.equal(badRoster.sharingSig, null, 'a changed sharing setting does not verify');
  assert.deepEqual(floorOf(bad, badRoster).sharings, []);
});
