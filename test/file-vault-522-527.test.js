import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileVault } from '../extension/core/filevault.js';
import { FileContainers } from '../desktop/files.js';
import { OlderStateAcceptance } from '../desktop/file-accept-older.js';
import { ContainerKey } from '../extension/core/protect.js';
import { wrapKey } from '../extension/core/members.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #522: a container key no admin signed (#521) is not offered for "repair" (#446) – that would keep the foreign key.
// #527: taking an older state (#435) offers only passkeys of admins of the known state (allowCredentials).

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });

async function place() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-522-'));
  const file = path.join(dir, 'Team.kvpws');
  const io = { read: () => fs.readFile(file, 'utf8').catch(() => null), write: (s) => fs.writeFile(file, s) };
  const state = { paths: [file], pins: {}, notes: {} };
  const make = () => new FileContainers({
    paths: () => state.paths, setPaths: (p) => { state.paths = p; }, onChange: () => {},
    pins: () => state.pins, setPins: (p) => { state.pins = p; }, pinNotes: () => state.notes, setPinNotes: (n) => { state.notes = n; },
  });
  return { dir, file, io, make };
}

/** Alice admin, Bob and Carol editors. */
async function team(io) {
  const pks = { alice: passkey('alice'), bob: passkey('bob'), carol: passkey('carol') };
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: pks.alice });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const ids = {};
  for (const name of ['bob', 'carol']) {
    const req = await new FileVault(io).requestAccess({ email: `${name}@contoso.com`, passkey: pks[name] });
    await alice.load();
    await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'editor' });
    ids[name] = req.memberId;
  }
  return { alice, pks, ids };
}

test('#522: a refused foreign key is not offered for repair; the repair refuses and writes nothing', async () => {
  const { dir, file, io, make } = await place();
  let files = null;
  try {
    const { alice, pks } = await team(io);
    files = make();
    await files.load();
    const entry = files.entries.get(alice.id);
    await entry.vault.unlockWithPasskey(pks.alice.credentialId, pks.alice.prfOutput);
    files.noteFloor(file, entry.vault);
    // Someone with write access to the share wraps a key of their own for Alice (#521).
    const doc = JSON.parse(await fs.readFile(file, 'utf8'));
    const kv = doc.keyring.keyVersion + 1;
    const evil = await ContainerKey.generate();
    doc.keyring.keyVersion = kv;
    doc.keyring.members = await Promise.all(doc.keyring.members.map(async (m) => (m.id === entry.vault.memberId
      ? { ...m, wrapped: { kv, ...(await wrapKey(evil.raw, m.ecdh, `kvpwsafe/member-key/${doc.id}/${m.id}/${kv}`)) } } : m)));
    const forged = JSON.stringify(doc);
    await fs.writeFile(file, forged);
    await files.watched(entry);
    const c = (await files.containers()).find((x) => x.id === alice.id);
    assert.equal(entry.refusal, 'key-unsigned');
    assert.ok(c.warning, 'refused');
    assert.equal(c.keyRefused, true, 'shown as a refused key');
    assert.equal(c.repairable, false, 'no repair offered');
    assert.equal(c.olderState, false);
    await assert.rejects(files.repair(alice.id), /reparieren|repaired/);
    assert.equal(await fs.readFile(file, 'utf8'), forged, 'nothing written');
    assert.ok(!entry.vault.locked && b64uEncode(entry.vault.ck.raw) !== b64uEncode(evil.raw), 'the open vault keeps its key');
  } finally {
    files?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('#527: only passkeys of admins in the known state are offered to take an older state', async () => {
  const { dir, file, io, make } = await place();
  let later = null;
  try {
    const { alice, pks, ids } = await team(io);
    await alice.saveItem({ type: 'login', title: 'Old', password: 'o' });
    const backup = await io.read();
    await alice.memberOp({ type: 'remove', memberId: ids.carol }); // Bob stays an active editor, Carol is removed
    const files = make();
    await files.load();
    files.close();
    await fs.writeFile(file, backup);
    later = make();
    await later.load();
    const entry = [...later.entries.values()][0];
    assert.equal(entry.refusal, 'older');
    const acc = new OlderStateAcceptance(later);
    const { token } = await acc.prepare(entry.id);
    const { passkeys } = await acc.passkeys(token, 'localhost');
    assert.deepEqual(passkeys.map((p) => p.credentialId), [pks.alice.credentialId], 'Alice only – not Bob (editor) nor Carol (removed)');
    // The admin's passkey still takes it.
    const r = await acc.unlock(token, { credentialId: pks.alice.credentialId, prfOutput: pks.alice.prfOutput });
    assert.equal(typeof r.dropped, 'number');
    // Another member's passkey is refused as before (acceptOlder checks the role itself).
    const t2 = (await acc.prepare(entry.id)).token;
    await assert.rejects(acc.unlock(t2, { credentialId: pks.bob.credentialId, prfOutput: pks.bob.prfOutput }), /Nur Admins|Only admins/);
  } finally {
    later?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
