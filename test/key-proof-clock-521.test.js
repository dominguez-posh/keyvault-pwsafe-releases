import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault } from '../extension/core/filevault.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #521 (Konrad, p521b): an admin whose clock runs ahead names a new admin; the new admin (right clock) changes the key.
// Capping the date of the proof (Konrad 4) put it before the new admin's own grant – no device took the key any more.
// A separate file: the test replaces the global Date.

const RealDate = Date;
let offset = 0;
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
  static now() { return RealDate.now() + offset; }
}

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
const memoryIo = () => { let text = null; return { read: async () => text, write: async (s) => { text = s; }, get text() { return text; }, set text(v) { text = v; } }; };
const sameKey = (a, b) => b64uEncode(a.raw) === b64uEncode(b.raw);

test('#521 (p521b): a new admin named by an admin with a clock 8 min ahead changes the key – every member follows', async () => {
  globalThis.Date = FakeDate;
  try {
    const io = memoryIo();
    offset = 8 * 60_000; // Alice's clock
    const alicePk = passkey('alice');
    const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: alicePk });
    await alice.persist();
    await alice.memberOp({ type: 'sharing', enabled: true });
    const ids = {};
    const pks = {};
    for (const [name, role] of [['bob', 'admin'], ['carol', 'reader'], ['dave', 'editor']]) {
      pks[name] = passkey(name);
      offset = 0;
      const req = await new FileVault(io).requestAccess({ email: `${name}@contoso.com`, passkey: pks[name] });
      offset = 8 * 60_000;
      await alice.load();
      await alice.memberOp({ type: 'approve', memberId: req.memberId, role });
      ids[name] = req.memberId;
    }
    offset = 0; // Bob's clock is right
    const bob = new FileVault(io);
    await bob.unlockWithPasskey(pks.bob.credentialId, pks.bob.prfOutput);
    await bob.memberOp({ type: 'remove', memberId: ids.carol });
    offset = 20 * 60_000; // later
    for (const name of ['bob', 'dave']) {
      const v = new FileVault(io);
      await v.unlockWithPasskey(pks[name].credentialId, pks[name].prfOutput);
      assert.ok(sameKey(v.ck, bob.ck), `${name}: fresh unlock takes the key`);
    }
    const a2 = new FileVault(io);
    await a2.unlockWithPasskey(alicePk.credentialId, alicePk.prfOutput);
    assert.ok(sameKey(a2.ck, bob.ck), 'alice: fresh unlock takes the key');
  } finally {
    globalThis.Date = RealDate;
    offset = 0;
  }
});

test('#521 (Konrad b): a key change whose own proof would not count is refused before anything is written', async () => {
  const io = memoryIo();
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: passkey('alice') });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const pk = passkey('bob');
  const req = await new FileVault(io).requestAccess({ email: 'bob@contoso.com', passkey: pk });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'reader' });
  const text = io.text;
  const [ck, kv] = [alice.ck, alice.doc.keyring.keyVersion];
  // The proof dated before the creator's first grant: it cannot count anywhere.
  const addLog = alice.addLog;
  alice.addLog = function (payload, at) { return addLog.call(this, payload, payload.action === 'key-rotate' ? new RealDate(0).toISOString() : at); };
  await assert.rejects(alice.memberOp({ type: 'remove', memberId: req.memberId }), /nichts gespeichert/);
  alice.addLog = addLog;
  assert.equal(io.text, text, 'nothing written');
  assert.ok(alice.ck === ck && alice.doc.keyring.keyVersion === kv, 'the open vault is as before');
  assert.equal(alice.roster.current(req.memberId).status, 'active');
  // And the same removal then works.
  await alice.memberOp({ type: 'remove', memberId: req.memberId });
  assert.equal(alice.doc.keyring.keyVersion, kv + 1);
});
