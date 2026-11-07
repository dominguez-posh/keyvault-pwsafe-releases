import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault } from '../extension/core/filevault.js';
import { signedAt } from '../extension/core/members.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #440, second review (Konrad): his PoC as a counter-test – a future-dated junk grant must not make a later removal
// count as backdated, and a save must not erase it. Plus clocks that differ between devices.

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
const memoryIo = () => { let text = null; return { read: async () => text, write: async (s) => { text = s; } }; };
const tick = () => new Promise((r) => setTimeout(r, 5));

async function join(io, alice, name, role) {
  const pk = passkey(name);
  const req = await new FileVault(io).requestAccess({ email: `${name}@contoso.com`, passkey: pk });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role });
  const v = new FileVault(io);
  await v.unlockWithPasskey(pk.credentialId, pk.prfOutput);
  return { v, id: req.memberId, pk };
}

async function team(io) {
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: passkey('alice') });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  return alice;
}

/** Runs fn with this process's clock `ms` ahead (Date.now and new Date()). */
async function clockAhead(ms, fn) {
  const RealDate = Date;
  class AheadDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [RealDate.now() + ms])); }
    static now() { return RealDate.now() + ms; }
  }
  globalThis.Date = AheadDate;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}

test('PoC: future-dated junk grant poisons nothing – Mallory stays removed on Bob, the removal stays in the file', async () => {
  const io = memoryIo();
  const alice = await team(io);
  const bob = await join(io, alice, 'bob', 'admin');
  const mal = await join(io, alice, 'mallory', 'admin');
  const carol = await join(io, alice, 'carol', 'reader');
  // Mallory, with write access, adds a junk grant (no valid signature) dated far in the future.
  const doc = JSON.parse(await io.read());
  doc.keyring.members.find((m) => m.id === mal.id).grants.push({ role: 'admin', status: 'active', at: '9999-01-01T00:00:00.000Z', by: mal.id, sig: 'junk' });
  await io.write(JSON.stringify(doc));
  await alice.load();
  await bob.v.load();
  await bob.v.load(); // the junk would now be part of Bob's known state
  await tick();
  await alice.memberOp({ type: 'remove', memberId: mal.id });
  assert.equal(alice.roster.current(mal.id).status, 'removed');
  await bob.v.load();
  assert.equal(bob.v.roster.current(mal.id).status, 'removed', 'Bob sees Mallory removed');
  await tick();
  await bob.v.memberOp({ type: 'remove', memberId: carol.id });
  const file = JSON.parse(await io.read());
  const mg = file.keyring.members.find((m) => m.id === mal.id);
  assert.ok(mg.grants.some((g) => g.status === 'removed'), 'the removal stays in the file');
  assert.notEqual(mg.wrapped?.kv, file.keyring.keyVersion, 'no current key for Mallory (an old wrap of a key she knew may stay)');
  await assert.rejects(new FileVault(io).unlockWithPasskey(mal.pk.credentialId, mal.pk.prfOutput), /entfernt|removed/);
  await alice.load();
});

test('#440: a device whose clock is 1 hour ahead drops no real grants of others', async () => {
  const io = memoryIo();
  const alice = await team(io);
  const fastPk = passkey('fast');
  const req = await new FileVault(io).requestAccess({ email: 'fast@contoso.com', passkey: fastPk });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'admin' });
  const fast = new FileVault(io);
  const hour = 60 * 60_000;
  await clockAhead(hour, () => fast.unlockWithPasskey(fastPk.credentialId, fastPk.prfOutput));
  // The fast device approves someone (its grant is dated an hour ahead) …
  const carol = await new FileVault(io).requestAccess({ email: 'carol@contoso.com', passkey: passkey('carol') });
  await clockAhead(hour, async () => { await fast.load(); await fast.memberOp({ type: 'approve', memberId: carol.memberId, role: 'reader' }); });
  // … then Alice, with the right time, approves Bob and removes Dave.
  const bob = await new FileVault(io).requestAccess({ email: 'bob@contoso.com', passkey: passkey('bob') });
  const dave = await new FileVault(io).requestAccess({ email: 'dave@contoso.com', passkey: passkey('dave') });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: bob.memberId, role: 'editor' });
  await alice.memberOp({ type: 'approve', memberId: dave.memberId, role: 'reader' });
  await tick();
  await alice.memberOp({ type: 'remove', memberId: dave.memberId });
  await clockAhead(hour, async () => {
    await fast.load();
    assert.equal(fast.roster.current(bob.memberId)?.status, 'active', 'the fast device takes Alice\'s grant');
    assert.equal(fast.roster.current(dave.memberId)?.status, 'removed', 'and her removal');
    await fast.memberOp({ type: 'sharing', enabled: true }); // a save there keeps both
  });
  await alice.load();
  assert.equal(alice.roster.current(bob.memberId)?.status, 'active');
  assert.equal(alice.roster.current(dave.memberId)?.status, 'removed');
  // Far ahead of Alice's clock, the fast device's grant does not count for her yet – but it stays in the file.
  assert.notEqual(alice.roster.current(carol.memberId)?.status, 'active');
  assert.equal(alice.doc.keyring.members.find((m) => m.id === carol.memberId).grants.length, 1);
});

test('#440: an admin signs after their own last entry, also with a clock behind it', () => {
  const roster = { lastAt: (id) => (id === 'a' ? '2026-11-07T12:00:00.000Z' : '') };
  assert.equal(signedAt(roster, 'a', Date.parse('2026-11-07T11:00:00.000Z')), '2026-11-07T12:00:00.001Z');
  assert.equal(signedAt(roster, 'a', Date.parse('2026-11-07T13:00:00.000Z')), '2026-11-07T13:00:00.000Z');
  assert.equal(signedAt(roster, 'b', Date.parse('2026-11-07T13:00:00.000Z')), '2026-11-07T13:00:00.000Z');
});
