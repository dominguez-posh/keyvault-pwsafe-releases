import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileVault } from '../extension/core/filevault.js';
import { FileContainers } from '../desktop/files.js';
import { newIdentity, signObject } from '../extension/core/members.js';
import { floorOf, repairFromFloor } from '../extension/core/rollback.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #446: Konrad's remaining findings from the review of #444 (his PoCs p444.test.mjs as counter-tests).

const passkey = (name) => ({ credentialId: 'cred-' + name + '-' + b64uEncode(randomBytes(4)), rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
const memoryIo = () => { let text = null; return { read: async () => text, write: async (s) => { text = s; } }; };
const tick = () => new Promise((r) => setTimeout(r, 5));
const body = (scope, m, g) => ({ file: scope, member: m.id, email: m.email, ecdh: m.ecdh, sign: m.sign, role: g.role, status: g.status, at: g.at, by: g.by });

/** Alice admin, Mallory admin and then removed, Bob reader; midAt: a time while Mallory was admin. */
async function setup(io = memoryIo()) {
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
  const grants = alice.doc.keyring.members.find((m) => m.id === req.memberId).grants;
  const a = Date.parse(grants.find((g) => g.status === 'active').at), b = Date.parse(grants.find((g) => g.status === 'removed').at);
  return { io, alice, mid: req.memberId, identity: mallory.identity, bobId: bob.memberId, midAt: new Date((a + b) / 2).toISOString() };
}

async function newMember(id, email, at) {
  const identity = await newIdentity();
  return { identity, member: { id, email, ecdh: identity.ecdh, sign: identity.sign, requested: at, grants: [], credentials: [], removedCredentials: [] } };
}

test('#446/1: rejecting a hidden account (it signed for others) also writes a signed removal – a device without floor no longer counts it', async () => {
  const { io, alice, mid, identity, bobId, midAt } = await setup();
  const doc = JSON.parse(await io.read());
  const n = await newMember('n-account', 'n@evil.example', midAt);
  const g = { role: 'admin', status: 'active', at: midAt, by: mid };
  g.sig = await signObject(identity, body(doc.id, n.member, g));
  doc.keyring.members.push({ ...n.member, grants: [g] });
  const bob = doc.keyring.members.find((m) => m.id === bobId);
  const gb = { role: 'reader', status: 'active', at: new Date().toISOString(), by: 'n-account' };
  gb.sig = await signObject(n.identity, body(doc.id, bob, gb));
  bob.grants.push(gb);
  await io.write(JSON.stringify(doc));
  await alice.load();
  assert.equal((await alice.describeMembers('localhost')).members.find((m) => m.id === 'n-account')?.invalid, true);
  await alice.memberOp({ type: 'reject', memberId: 'n-account' });
  assert.ok(!(await alice.describeMembers('localhost')).members.find((m) => m.id === 'n-account'), 'hidden for the admin');
  const fresh = new FileVault(io);
  await fresh.load();
  assert.ok(fresh.doc.keyring.members.some((m) => m.id === 'n-account'), 'kept for the signature on Bob\'s grant');
  assert.equal(fresh.roster.current('n-account').status, 'removed', 'not an active admin on a device without floor');
  await alice.load();
  assert.notEqual(alice.roster.current('n-account').status, 'active');
});

test('#446/3: a backdated rejection that does not count excuses no deleted member', async () => {
  const { io, alice, mid, identity, bobId, midAt } = await setup();
  assert.equal(alice.roster.current(bobId).status, 'active');
  const doc = JSON.parse(await io.read());
  const r = { id: bobId, at: midAt, by: mid };
  r.sig = await signObject(identity, { file: doc.id, rejected: r.id, at: r.at, by: r.by });
  doc.keyring.rejected = [...(doc.keyring.rejected || []), r];
  doc.keyring.members = doc.keyring.members.filter((m) => m.id !== bobId);
  await io.write(JSON.stringify(doc));
  const floor = floorOf(alice.doc, alice.roster);
  await assert.rejects(alice.load(), /älterer Stand|older state/);
  assert.ok(alice.doc.keyring.members.some((m) => m.id === bobId), 'Bob stays');
  const restarted = new FileVault(io);
  restarted.floor = floor;
  await assert.rejects(restarted.load(), /älterer Stand|older state/);
  // Repaired from the known state: Bob is back with his grants.
  const fixed = await repairFromFloor(JSON.parse(await io.read()), floor);
  await io.write(JSON.stringify(fixed));
  await restarted.load();
  assert.equal(restarted.roster.current(bobId).status, 'active');
});

test('#446/4: a grant signed by an account that was never admin marks no real request as invalid entry', async () => {
  const { io, alice } = await setup();
  const l = await new FileVault(io).requestAccess({ email: 'lisa@contoso.com', passkey: passkey('lisa') });
  await alice.load();
  const doc = JSON.parse(await io.read());
  const x = await newMember('x-account', 'x@evil.example', new Date().toISOString());
  const lisa = doc.keyring.members.find((m) => m.id === l.memberId);
  const g = { role: 'reader', status: 'active', at: new Date().toISOString(), by: 'x-account' };
  g.sig = await signObject(x.identity, body(doc.id, lisa, g));
  lisa.grants.push(g);
  doc.keyring.members.push(x.member);
  await io.write(JSON.stringify(doc));
  await alice.load();
  const shown = (await alice.describeMembers('localhost')).members.find((m) => m.id === l.memberId);
  assert.equal(shown.status, 'pending');
  assert.ok(!shown.invalid, 'Lisa\'s request is not marked invalid');
});

test('#446/2: a changed known grant locks the file – the app repairs it from the known state', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-446-'));
  const file = path.join(dir, 'Team.kvpws');
  const io = { read: () => fs.readFile(file, 'utf8').catch(() => null), write: (s) => fs.writeFile(file, s) };
  const state = { paths: [file], pins: {}, notes: {} };
  const make = () => new FileContainers({
    paths: () => state.paths, setPaths: (p) => { state.paths = p; }, onChange: () => {},
    pins: () => state.pins, setPins: (p) => { state.pins = p; }, pinNotes: () => state.notes, setPinNotes: (n) => { state.notes = n; },
  });
  let files = null;
  let again = null;
  try {
    const { alice, mid } = await setup(io);
    files = make();
    await files.load();
    const entry = files.entries.get(alice.id);
    assert.ok(state.notes[file].floor.members.length >= 3, 'the floor keeps whole grants');
    const good = await fs.readFile(file, 'utf8');
    const doc = JSON.parse(good);
    const rm = doc.keyring.members.find((m) => m.id === mid).grants.find((g) => g.status === 'removed');
    rm.role = 'admin'; rm.status = 'active';
    await fs.writeFile(file, JSON.stringify(doc));
    // Open session: refused, offered for repair; repair writes the known grant back.
    await files.watched(entry);
    let c = (await files.containers()).find((x) => x.id === alice.id);
    assert.ok(c.warning && c.repairable, 'refused and repairable');
    await files.repair(alice.id);
    c = (await files.containers()).find((x) => x.id === alice.id);
    assert.ok(!c.warning, 'taken after the repair');
    assert.equal(files.entries.get(alice.id).vault.roster.current(mid).status, 'removed');
    // After a restart: listed with the error and repaired from there, too.
    await fs.writeFile(file, JSON.stringify(doc));
    files.close();
    again = make();
    await again.load();
    const broken = (await again.containers()).find((x) => x.path === file);
    assert.ok(broken.error && broken.repairable);
    const id = await again.repair(broken.id);
    assert.equal(id, alice.id);
    assert.equal(again.entries.get(id).vault.roster.current(mid).status, 'removed');
    // Without a floor the removal counts again, too (the repair wrote the original back).
    const fresh = new FileVault(io);
    await fresh.load();
    assert.equal(fresh.roster.current(mid).status, 'removed');
    // An older key version cannot be repaired from grants: refused, nothing written.
    const older = JSON.parse(good);
    older.keyring.keyVersion -= 1;
    await fs.writeFile(file, JSON.stringify(older));
    await again.watched(again.entries.get(id));
    await assert.rejects(again.repair(id), /reparieren|repaired/);
    assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).keyring.keyVersion, older.keyring.keyVersion);
  } finally {
    files?.close();
    again?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
