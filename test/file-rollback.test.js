import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileVault } from '../extension/core/filevault.js';
import { FileContainers } from '../desktop/files.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #432 (Konrad, high): an old copy of a secured file put back by a former member who can still write to the share must
// not count: their role and the old key would come back.

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });

/** Team file with Alice (admin) and Bob (editor); returns the text before and after Bob was removed. */
async function teamWithRemovedMember(io) {
  const alicePk = passkey('alice');
  const alice = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: alicePk });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const bobVault = new FileVault(io);
  await bobVault.load();
  const req = await bobVault.requestAccess({ email: 'bob@contoso.com', passkey: passkey('bob') });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'editor' });
  const withBob = await io.read();
  await alice.memberOp({ type: 'remove', memberId: req.memberId });
  return { alice, alicePk, withBob, without: await io.read(), bobId: req.memberId };
}

test('a removed member who drops their "removed" grant and lists themselves in rejected is refused (Konrad, #432)', async () => {
  const io = memoryIo();
  const { alice, without, bobId } = await teamWithRemovedMember(io);
  const doc = JSON.parse(without);
  const bob = doc.keyring.members.find((m) => m.id === bobId);
  bob.grants = bob.grants.filter((g) => g.status !== 'removed');
  doc.keyring.rejected = [...(doc.keyring.rejected || []), bobId];
  await io.write(JSON.stringify(doc));
  await assert.rejects(alice.load(), /älterer Stand|older state/);
  // Taken out by hand with an unsigned rejection: refused as well (#433, only signed rejections count).
  doc.keyring.members = doc.keyring.members.filter((m) => m.id !== bobId);
  await io.write(JSON.stringify(doc));
  await assert.rejects(alice.load(), /älterer Stand|older state/);
  // Deleted for good by an admin (signed rejection): their grants may go.
  await io.write(without);
  await alice.load();
  await alice.memberOp({ type: 'remove', memberId: bobId });
  await alice.load();
  assert.ok(!alice.doc.keyring.members.some((m) => m.id === bobId));
});

function memoryIo() {
  let text = null;
  return { read: async () => text, write: async (s) => { text = s; } };
}

test('load: a vault that saw the newer state refuses the old copy', async () => {
  const io = memoryIo();
  const { alice, withBob, without } = await teamWithRemovedMember(io);
  assert.ok(JSON.parse(without).keyring.keyVersion > JSON.parse(withBob).keyring.keyVersion, 'removing changed the key');
  await io.write(withBob);
  await assert.rejects(alice.load(), /älterer Stand|older state/);
  await io.write(without);
  await alice.load();
});

test('attach and the file watcher refuse the old copy, also after a restart of the app', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-432-'));
  const file = path.join(dir, 'Team.kvpws');
  const io = { read: () => fs.readFile(file, 'utf8').catch(() => null), write: (s) => fs.writeFile(file, s) };
  const state = { paths: [file], pins: {}, notes: {} };
  const make = () => new FileContainers({
    paths: () => state.paths, setPaths: (p) => { state.paths = p; }, onChange: () => {},
    pins: () => state.pins, setPins: (p) => { state.pins = p; }, pinNotes: () => state.notes, setPinNotes: (n) => { state.notes = n; },
  });
  let first = null;
  let later = null;
  try {
    const { alice, withBob, without } = await teamWithRemovedMember(io);
    first = make();
    await first.load();
    const entry = first.entries.get(alice.id);
    assert.ok(entry?.vault, 'opened');
    // The watcher: the old copy comes back while the app runs.
    await fs.writeFile(file, withBob);
    await first.watched(entry);
    assert.match((await first.containers()).find((c) => c.id === alice.id)?.warning || '', /älterer Stand|older state/);
    first.close();
    // A restart: the remembered floor refuses it at the start, too.
    later = make();
    await later.load();
    assert.ok([...later.entries.values()].every((e) => e.error), 'old copy taken after a restart');
    // The current state still opens.
    await fs.writeFile(file, without);
    later.close();
    later = make();
    await later.load();
    assert.ok(later.entries.get(alice.id)?.vault, 'current state refused');
  } finally {
    first?.close();
    later?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('an own save is remembered at once, without waiting for the file watcher (Konrad, #432)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-432b-'));
  const file = path.join(dir, 'Team.kvpws');
  const state = { paths: [], pins: {}, notes: {} };
  const files = new FileContainers({
    paths: () => state.paths, setPaths: (p) => { state.paths = p; }, onChange: () => {},
    pins: () => state.pins, setPins: (p) => { state.pins = p; }, pinNotes: () => state.notes, setPinNotes: (n) => { state.notes = n; },
  });
  try {
    const { id } = await files.createSecure(file, 'Team', { email: 'alice@contoso.com', passkey: passkey('alice') });
    const before = state.notes[file]?.floor?.grants?.length || 0;
    const v = files.get(id);
    await v.memberOp({ type: 'sharing', enabled: true });
    const bob = new FileVault({ read: () => fs.readFile(file, 'utf8'), write: (s) => fs.writeFile(file, s) });
    await bob.load();
    const req = await bob.requestAccess({ email: 'bob@contoso.com', passkey: passkey('bob') });
    await v.load();
    await v.memberOp({ type: 'approve', memberId: req.memberId, role: 'editor' });
    assert.ok((state.notes[file]?.floor?.grants?.length || 0) > before, 'the approval is not remembered');
  } finally {
    files.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
