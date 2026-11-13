// #523: a write race puts "admin A removed" (written by admin B with B's key change) under a later key generation that A
// set. persist() merged the two: A removed, the current key proven only by A – no proof counts (#521), nobody unlocks
// freshly any more. persist() now refuses a merge that takes the proof of the current key away; nothing is written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault } from '../extension/core/filevault.js';
import { keyChangeSigned } from '../extension/core/key-proof.js';
import { verifyRoster } from '../extension/core/members.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
const memoryIo = () => { let text = null; return { read: async () => text, write: async (s) => { text = s; }, get text() { return text; }, set text(v) { text = v; } }; };
/** The same file, but the next read sees `stale` (this device read the file before the other one wrote it). */
const racingIo = (io, stale) => { let first = true; return { read: async () => (first ? ((first = false), stale) : io.read()), write: (s) => io.write(s) }; };

async function team(roles) {
  const io = memoryIo();
  const pks = { alice: passkey('alice') };
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: pks.alice });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const ids = { alice: alice.memberId };
  for (const [name, role] of Object.entries(roles)) {
    pks[name] = passkey(name);
    ids[name] = (await new FileVault(io).requestAccess({ email: `${name}@contoso.com`, passkey: pks[name] })).memberId;
    await alice.load();
    await alice.memberOp({ type: 'approve', memberId: ids[name], role });
  }
  const open = async (name, on = io) => {
    const v = new FileVault(on);
    await v.unlockWithPasskey(pks[name].credentialId, pks[name].prfOutput);
    return v;
  };
  return { io, alice, ids, open };
}

/** Does the key of the file's current generation still have a proof that counts (what a fresh unlock asks, #521)? */
async function proofCounts(io, vault) {
  const doc = JSON.parse(io.text);
  return keyChangeSigned(doc, vault.ck, await verifyRoster(doc.keyring), doc.keyring.keyVersion);
}

test('#523: the removed admin\'s next key change is not merged over their removal – fresh unlock keeps working', async () => {
  const { io, alice, ids, open } = await team({ bob: 'admin', carol: 'reader', dave: 'editor', erin: 'reader' });
  const s1 = io.text;
  await alice.memberOp({ type: 'remove', memberId: ids.carol }); // generation 2, Alice's key
  // Bob read the file before that write and writes after it: Alice removed, generation 2 with Bob's key.
  const bob = await open('bob', racingIo(io, s1));
  bob.io = racingIo(io, s1);
  await bob.memberOp({ type: 'remove', memberId: ids.alice });
  const bobsFile = io.text;
  assert.equal(JSON.parse(bobsFile).keyring.keyVersion, 2);
  // Alice's device has not seen it and removes Erin: generation 3 over Bob's generation 2 on the disk.
  await assert.rejects(alice.memberOp({ type: 'remove', memberId: ids.erin }));
  assert.equal(io.text, bobsFile, 'nothing written over the removal');
  assert.equal(await proofCounts(io, bob), true);
  for (const name of ['bob', 'dave', 'erin']) {
    const v = await open(name);
    assert.equal(b64uEncode(v.ck.raw), b64uEncode(bob.ck.raw), `${name}: fresh unlock with the key Bob set`);
  }
  await assert.rejects(open('alice'), /entfernt/);
});

test('#523: a member still on the removed admin\'s later generation does not merge it over the removal either', async () => {
  const { io, alice, ids, open } = await team({ bob: 'admin', carol: 'reader', dave: 'editor', erin: 'reader' });
  const s1 = io.text;
  await alice.memberOp({ type: 'remove', memberId: ids.carol }); // generation 2
  await alice.memberOp({ type: 'remove', memberId: ids.erin }); // generation 3
  const dave = await open('dave');
  const bob = await open('bob', racingIo(io, s1)); // unlocked on the state before both
  bob.io = racingIo(io, s1);
  await bob.memberOp({ type: 'remove', memberId: ids.alice }); // generation 2 with Bob's key, over Alice's generation 3
  const bobsFile = io.text;
  await assert.rejects(dave.saveItem({ type: 'login', title: 'Neu', username: 'u', password: 'p' }));
  assert.equal(io.text, bobsFile, 'nothing written');
  assert.equal(await proofCounts(io, bob), true);
  assert.ok(await open('bob'), 'bob unlocks freshly');
  assert.ok(await open('dave'), 'dave unlocks freshly');
});

test('#523: an ordinary merge with a change on the disk is written as before, also after a key change', async () => {
  const { io, alice, ids, open } = await team({ bob: 'admin', carol: 'reader', dave: 'editor' });
  const dave = await open('dave');
  await alice.rename('Team 2'); // on the disk, Dave has not read it
  await dave.saveItem({ type: 'login', title: 'Von Dave', username: 'u', password: 'p' });
  assert.equal(JSON.parse(io.text).name, 'Team 2');
  await alice.load();
  await alice.memberOp({ type: 'remove', memberId: ids.carol });
  const bob = await open('bob');
  assert.equal(bob.summaries().some((s) => s.title === 'Von Dave'), true);
  await bob.memberOp({ type: 'remove', memberId: ids.alice });
  assert.ok(await open('dave'));
});
