import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault } from '../extension/core/filevault.js';
import { ContainerKey } from '../extension/core/protect.js';
import { wrapKey, signObject, loadIdentity, newIdentity } from '../extension/core/members.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #521 (Konrad): the wrapping of the container key (ECDH-ES to the member's public key) is not authenticated. Anyone
// with write access to the share could wrap a key of their own for a member (generation + 1, or the same one); the
// device took it and every later write was readable for them. A new key now counts only with a signed log entry of a
// then admin that opens with it and names its generation (key-rotate, older-state-accept; file-create for the first).

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
const memoryIo = () => { let text = null; return { read: async () => text, write: async (s) => { text = s; }, get text() { return text; }, set text(v) { text = v; } }; };
const sameKey = (a, b) => b64uEncode(a.raw) === b64uEncode(b.raw);

async function team() {
  const io = memoryIo();
  const alicePk = passkey('alice');
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: alicePk });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const members = {};
  for (const [name, role] of [['bob', 'editor'], ['carol', 'reader']]) {
    const pk = passkey(name);
    const req = await new FileVault(io).requestAccess({ email: `${name}@contoso.com`, passkey: pk });
    await alice.load();
    await alice.memberOp({ type: 'approve', memberId: req.memberId, role });
    members[name] = { pk, id: req.memberId };
  }
  const bob = new FileVault(io);
  await bob.unlockWithPasskey(members.bob.pk.credentialId, members.bob.pk.prfOutput);
  return { io, alice, bob, members, alicePk };
}

/** What someone with write access to the share can do without any key: wrap a key of their own for one member. */
async function forgeWrap(io, memberId, { sameGeneration = false, log = null } = {}) {
  const doc = JSON.parse(io.text);
  const kv = doc.keyring.keyVersion + (sameGeneration ? 0 : 1);
  const evil = await ContainerKey.generate();
  evil.kv = kv;
  doc.keyring.keyVersion = kv;
  doc.keyring.members = await Promise.all(doc.keyring.members.map(async (m) => (m.id === memberId
    ? { ...m, wrapped: { kv, ...(await wrapKey(evil.raw, m.ecdh, `kvpwsafe/member-key/${doc.id}/${m.id}/${kv}`)) } } : m)));
  if (log) doc.log = [...doc.log, await log(doc, evil, kv)];
  io.text = JSON.stringify(doc);
  return evil;
}

/** A key-rotate log entry for the forged key, encrypted with it and signed by `identity` as member `by`. */
const signedRotate = (identity, by, at = new Date().toISOString()) => async (doc, ck, kv) => {
  const id = b64uEncode(randomBytes(8));
  const body = { meta: { id, at, by }, payload: { action: 'key-rotate', keyVersion: kv } };
  const sig = await signObject(identity, { file: doc.id, ...body });
  return { id, at, by, kv, data: await ck.encrypt(JSON.stringify({ ...body, sig }), `${doc.id}/log/${id}`) };
};

test('#521: a foreign wrapping of the next generation is refused on load, the old key stays', async () => {
  const { io, bob, members } = await team();
  const before = bob.ck;
  const evil = await forgeWrap(io, members.bob.id);
  await assert.rejects(bob.load(), (e) => e.code === 'key-unsigned' && /nicht von einem Admin/.test(e.message));
  assert.ok(!sameKey(bob.ck, evil), 'the foreign key is not taken');
  assert.ok(sameKey(bob.ck, before), 'the old key stays');
  await assert.rejects(bob.saveItem({ title: 'nach Angriff', password: 'Geheim-521' }), (e) => e.code === 'key-unsigned');
  assert.ok(!io.text.includes('nach Angriff'));
});

test('#521: a foreign wrapping is refused on a fresh unlock (next and same generation)', async () => {
  for (const sameGeneration of [false, true]) {
    const { io, members } = await team();
    await forgeWrap(io, members.bob.id, { sameGeneration });
    await assert.rejects(new FileVault(io).unlockWithPasskey(members.bob.pk.credentialId, members.bob.pk.prfOutput),
      (e) => e.name === 'UnlockError' && /nicht von einem Admin/.test(e.message), `sameGeneration ${sameGeneration}`);
  }
});

test('#521: a key-rotate entry signed by a member who is not admin does not count', async () => {
  const { io, bob, members } = await team();
  // Bob (editor, write access to the share) plants a key for Carol and signs the rotation himself.
  await forgeWrap(io, members.carol.id, { log: signedRotate(bob.identity, bob.memberId) });
  await assert.rejects(new FileVault(io).unlockWithPasskey(members.carol.pk.credentialId, members.carol.pk.prfOutput), /nicht von einem Admin/);
  // Nor one signed by a key that is no member at all.
  const { io: io2, members: m2 } = await team();
  const stranger = await loadIdentity((await newIdentity()).secret);
  await forgeWrap(io2, m2.carol.id, { log: signedRotate(stranger, m2.carol.id) });
  await assert.rejects(new FileVault(io2).unlockWithPasskey(m2.carol.pk.credentialId, m2.carol.pk.prfOutput), /nicht von einem Admin/);
});

test('#521: legitimate key changes are still followed (removal, #520 reject of an active member)', async () => {
  for (const type of ['remove', 'reject']) {
    const { io, alice, bob, members } = await team();
    const kv = alice.doc.keyring.keyVersion;
    await alice.memberOp({ type, memberId: members.carol.id });
    assert.equal(alice.doc.keyring.keyVersion, kv + 1);
    await bob.load();
    assert.ok(sameKey(bob.ck, alice.ck), `${type}: the open device follows the admin's key change`);
    await bob.saveItem({ title: `nach ${type}`, password: 'x' });
    const fresh = new FileVault(io);
    await fresh.unlockWithPasskey(members.bob.pk.credentialId, members.bob.pk.prfOutput);
    assert.ok(sameKey(fresh.ck, alice.ck), `${type}: a fresh unlock takes the new key`);
    assert.equal(fresh.summaries().length, 1);
    await alice.load();
    assert.ok(sameKey(alice.ck, fresh.ck));
  }
});

test('#521: a removed admin cannot date a key change back to their admin time (with and without a floor)', async () => {
  const { io, alice, bob, members } = await team();
  await alice.memberOp({ type: 'setRole', memberId: members.bob.id, role: 'admin' });
  await bob.load();
  const adminAt = new Date().toISOString();
  await alice.memberOp({ type: 'remove', memberId: members.bob.id });
  // Carol's device knows Bob's removal (her floor); Bob plants a key for her, dated to when he was admin.
  const carol = new FileVault(io);
  await carol.unlockWithPasskey(members.carol.pk.credentialId, members.carol.pk.prfOutput);
  const { floorOf } = await import('../extension/core/rollback.js');
  const floor = floorOf(carol.doc, carol.roster);
  await forgeWrap(io, members.carol.id, { log: signedRotate(bob.identity, bob.memberId ?? members.bob.id, adminAt) });
  const again = new FileVault(io);
  again.floor = floor;
  await assert.rejects(again.unlockWithPasskey(members.carol.pk.credentialId, members.carol.pk.prfOutput), /nicht von einem Admin/);
  await assert.rejects(new FileVault(io).unlockWithPasskey(members.carol.pk.credentialId, members.carol.pk.prfOutput), /nicht von einem Admin/);
  await assert.rejects(carol.load(), (e) => e.code === 'key-unsigned');
});

async function join(io, admin, name, role) {
  const pk = passkey(name);
  const req = await new FileVault(io).requestAccess({ email: `${name}@contoso.com`, passkey: pk });
  await admin.load();
  await admin.memberOp({ type: 'approve', memberId: req.memberId, role });
  return { pk, id: req.memberId };
}

test('#521 (Konrad 2): an admin with a clock ahead removed someone – a later key change of another admin still counts', async () => {
  const { io, alice, bob, members } = await team();
  const dave = await join(io, alice, 'dave', 'editor');
  const erin = await join(io, alice, 'erin', 'editor');
  await alice.memberOp({ type: 'setRole', memberId: members.bob.id, role: 'admin' });
  await bob.load();
  // Bob's clock is 5 minutes ahead: his removal of Dave (and his key change) are dated ahead.
  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60_000;
  try {
    await bob.memberOp({ type: 'remove', memberId: dave.id });
  } finally {
    Date.now = realNow;
  }
  await alice.load();
  assert.ok(sameKey(alice.ck, bob.ck), 'Alice follows Bob\'s key change');
  // Alice (right clock) removes Erin: her key change is dated before Bob's removal of Dave – and counts.
  await alice.memberOp({ type: 'remove', memberId: erin.id });
  await bob.load();
  assert.ok(sameKey(bob.ck, alice.ck), 'Bob follows');
  const fresh = new FileVault(io);
  await fresh.unlockWithPasskey(members.carol.pk.credentialId, members.carol.pk.prfOutput);
  assert.ok(sameKey(fresh.ck, alice.ck), 'a fresh unlock takes it');
});

test('#521 (Konrad 4): the date of a key change stays within what other devices accept', async () => {
  const { keyChangeAt } = await import('../extension/core/key-proof.js');
  const { FUTURE_SLACK_MS } = await import('../extension/core/members.js');
  const now = Date.now();
  const roster = { lastAt: () => new Date(now + 60 * 60_000).toISOString() }; // own last entry an hour ahead
  assert.ok(Date.parse(keyChangeAt(roster, 'x', now)) < now + FUTURE_SLACK_MS);
  assert.equal(keyChangeAt({ lastAt: () => '' }, 'x', now), new Date(now).toISOString());
});

/** Duplicate of the admin's member ID with the attacker's signing key, placed first (Konrad's PoC). */
async function duplicateAdmin(io, victimId, adminId, sameGeneration) {
  const evilId = await newIdentity();
  const evil = await forgeWrap(io, victimId, { sameGeneration });
  const doc = JSON.parse(io.text);
  const kv = doc.keyring.keyVersion;
  const real = doc.keyring.members.find((m) => m.id === adminId);
  doc.keyring.members = [{ ...real, sign: evilId.sign, grants: [], credentials: [], wrapped: null }, ...doc.keyring.members];
  const id = b64uEncode(randomBytes(8));
  const at = new Date().toISOString();
  const body = { meta: { id, at, by: adminId }, payload: kv === 1 ? { action: 'file-create', name: 'Team' } : { action: 'key-rotate', keyVersion: kv } };
  const sig = await signObject(evilId, { file: doc.id, ...body });
  doc.log = [...doc.log, { id, at, by: adminId, kv, data: await evil.encrypt(JSON.stringify({ ...body, sig }), `${doc.id}/log/${id}`) }];
  io.text = JSON.stringify(doc);
  return { evil, evilId };
}

test('#521 (Konrad PoC 1): a second entry with the admin\'s ID and another signing key is refused – load and fresh unlock', async () => {
  const { io, alice, bob, members } = await team();
  const before = bob.ck;
  const { evil } = await duplicateAdmin(io, members.bob.id, alice.memberId, false);
  await assert.rejects(bob.load(), (e) => e.code === 'tampered');
  assert.ok(sameKey(bob.ck, before) && !sameKey(bob.ck, evil));
  for (const same of [false, true]) {
    const t2 = await team();
    await duplicateAdmin(t2.io, t2.members.bob.id, t2.alice.memberId, same);
    const v = new FileVault(t2.io);
    await assert.rejects(v.unlockWithPasskey(t2.members.bob.pk.credentialId, t2.members.bob.pk.prfOutput), `sameGeneration ${same}`);
    assert.equal(v.ck, null);
  }
});

test('#521 (Konrad PoC 1): every signature check takes the key of the member whose grants were checked', async () => {
  const { verifyRoster, applyRejections, sharingEnabled } = await import('../extension/core/members.js');
  const { keyChangeSigned } = await import('../extension/core/key-proof.js');
  const { io, alice, members } = await team();
  const { evil, evilId } = await duplicateAdmin(io, members.bob.id, alice.memberId, false);
  const doc = JSON.parse(io.text);
  const roster = await verifyRoster(doc.keyring);
  assert.equal(roster.tampered, true, 'duplicate member IDs are tampered');
  assert.equal(roster.current(alice.memberId).member.sign, alice.identity.sign, 'the roster keeps the member with the checked grants');
  // Key proof signed with the duplicate's key.
  assert.equal(await keyChangeSigned(doc, evil, roster, doc.keyring.keyVersion), false);
  // Rejection of Carol signed with the duplicate's key: takes nobody out.
  const r = { id: members.carol.id, at: new Date().toISOString(), by: alice.memberId };
  r.sig = await signObject(evilId, { file: doc.keyring.scope, rejected: r.id, at: r.at, by: r.by });
  const after = await applyRejections({ ...doc.keyring, rejected: [r] });
  assert.ok(after.members.some((m) => m.id === members.carol.id), 'a rejection signed by the duplicate takes nobody out');
  // Sharing setting signed with the duplicate's key.
  const sh = { enabled: true, at: new Date().toISOString(), by: alice.memberId };
  sh.sig = await signObject(evilId, { file: doc.keyring.scope, sharing: true, at: sh.at, by: sh.by });
  assert.equal(await sharingEnabled({ ...doc.keyring, sharing: sh }, roster), false);
  // Item versions and deletions (openSigned, verifyOp) on a vault holding that keyring.
  const v = new FileVault(io);
  Object.assign(v, { doc, ck: evil, roster, memberId: alice.memberId });
  const body = { meta: { id: 'x', rev: 'r', by: alice.memberId, at: new Date().toISOString() }, item: { title: 'forged' } };
  const sealed = await evil.encrypt(JSON.stringify({ ...body, sig: await signObject(evilId, { file: doc.id, ...body }) }), `${doc.id}/x`);
  assert.equal(await v.openSigned(sealed, `${doc.id}/x`, () => true), null);
  const op = { id: 'x', op: 'delete', at: new Date().toISOString(), by: alice.memberId };
  assert.equal(await v.verifyOp({ ...op, sig: await signObject(evilId, { file: doc.id, ...op }) }), false);
});

test('#521 (Konrad 3): an admin\'s signed key change replayed under another key does not count (key check)', async () => {
  const { io, alice, members } = await team();
  await alice.memberOp({ type: 'remove', memberId: members.carol.id });
  const doc = JSON.parse(io.text);
  const kv = doc.keyring.keyVersion;
  const proof = doc.log.find((e) => e.kv === kv);
  const inner = await alice.ck.decrypt(proof.data, `${doc.id}/log/${proof.id}`);
  assert.ok(JSON.parse(inner).payload.keyCheck, 'new proofs carry the key check');
  // Someone who knows this generation's key wraps another one for Bob and puts the admin's signed body under it.
  const evil = await forgeWrap(io, members.bob.id, { sameGeneration: true });
  const forged = JSON.parse(io.text);
  forged.log = forged.log.map((e) => e);
  forged.log.unshift({ ...proof, id: proof.id, data: await evil.encrypt(inner, `${doc.id}/log/${proof.id}`) });
  io.text = JSON.stringify(forged);
  await assert.rejects(new FileVault(io).unlockWithPasskey(members.bob.pk.credentialId, members.bob.pk.prfOutput), /nicht von einem Admin/);
});

test('#521: an older state taken on purpose (#435) is followed – open device and fresh unlock', async () => {
  const { acceptOlder } = await import('../extension/core/rollback-accept.js');
  const { floorOf, mergeFloors } = await import('../extension/core/rollback.js');
  const { io, alice, bob, members, alicePk } = await team();
  const backup = io.text;
  await new Promise((r) => setTimeout(r, 5));
  await alice.memberOp({ type: 'remove', memberId: members.carol.id });
  await bob.load();
  const floor = mergeFloors(alice.floor, floorOf(alice.doc, alice.roster));
  const r = await acceptOlder(backup, floor, { credentialId: alicePk.credentialId, prfOutput: alicePk.prfOutput });
  io.text = r.text;
  await bob.load();
  assert.equal(bob.ck.kv, r.keyVersion, 'the open device follows the accepted state');
  const fresh = new FileVault(io);
  await fresh.unlockWithPasskey(members.bob.pk.credentialId, members.bob.pk.prfOutput);
  assert.ok(sameKey(fresh.ck, bob.ck));
});

test('#521: a foreign wrapping of the same generation is refused on load too (#435 follows those)', async () => {
  const { io, bob, members } = await team();
  const before = bob.ck;
  await forgeWrap(io, members.bob.id, { sameGeneration: true });
  await assert.rejects(bob.load(), (e) => e.code === 'key-unsigned');
  assert.ok(sameKey(bob.ck, before));
  await assert.rejects(bob.load(), (e) => e.code === 'key-unsigned', 'refused again on the next reload, not remembered as seen');
});

test('Konrad N1 (#521): a forged sharing setting is not taken into the floor as known', async () => {
  const { floorOf } = await import('../extension/core/rollback.js');
  const { verifyRoster } = await import('../extension/core/members.js');
  const { alice } = await team();
  const good = floorOf(alice.doc, alice.roster);
  const bad = { ...alice.doc, keyring: { ...alice.doc.keyring, sharing: { ...alice.doc.keyring.sharing, enabled: false } } };
  const f = floorOf(bad, await verifyRoster(bad.keyring, good));
  assert.ok(!f.signed.includes(bad.keyring.sharing.sig), 'the forged setting is not known');
  const whole = new Set([...f.rejections, ...f.sharings].map((x) => x.sig));
  assert.ok(f.signed.every((sig) => whole.has(sig)), 'every known signature has its object (acceptOlder does not stop as incomplete)');
});
