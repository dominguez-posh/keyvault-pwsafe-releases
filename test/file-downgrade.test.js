import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileVault } from '../extension/core/filevault.js';
import { FileContainers } from '../desktop/files.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

// #430 (Konrad, high): a secured file (v2, signed roles) must not fall back to the old format (v1, no roles) under the
// same ID – any member, also a reader, holds the container key and could write such a file and become a writer.

const passkey = () => ({ credentialId: `cred-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: 'pk' });
const asV1 = (text) => JSON.stringify({ ...JSON.parse(text), version: 1 });

function memoryFile() {
  let text = null;
  return { io: { read: async () => text, write: async (s) => { text = s; } }, get text() { return text; }, set text(v) { text = v; } };
}

test('an old-format file with the ID of a secured one is refused, also in a vault that had the secured one', async () => {
  const file = memoryFile();
  const v2 = await FileVault.createSecure(file.io, { name: 'Team', email: 'alice@contoso.com', passkey: passkey() });
  await v2.persist();
  const secured = file.text;
  file.text = asV1(secured);
  await assert.rejects(new FileVault(file.io).load(), /manipuliert|tampered/);
  // The open vault reads the changed file again (file watcher): refused, it stays secured.
  const open = new FileVault(file.io);
  file.text = secured;
  await open.load();
  file.text = asV1(secured);
  await assert.rejects(open.load());
  assert.equal(open.secure, true);
});

test('saving never takes the format or ID from the disk: an old-format file or another ID there is refused (#430 rest)', async () => {
  const file = memoryFile();
  const pk = passkey();
  const v2 = await FileVault.createSecure(file.io, { name: 'Team', email: 'alice@contoso.com', passkey: pk });
  await v2.persist();
  const open = new FileVault(file.io);
  await open.load();
  await open.unlockWithPasskey(pk.credentialId, pk.prfOutput);
  const secured = file.text;
  // A member drops an old-format file with the same ID; the next change (e.g. a rename) saves without loading first.
  file.text = asV1(secured);
  await assert.rejects(open.rename('Neu'), /manipuliert|tampered/);
  assert.equal(JSON.parse(file.text).version, 1, 'nothing written: the planted file stays as it is');
  assert.equal(open.doc.version, 2);
  // Another ID on disk: refused as well.
  file.text = JSON.stringify({ ...JSON.parse(secured), id: 'file-AAAAAAAAAAAAAAAAAAAAAA' });
  await assert.rejects(open.rename('Neu'));
  // The real file: saving works.
  file.text = secured;
  await open.rename('Neu');
  assert.equal(JSON.parse(file.text).name, 'Neu');
});

test('the file watcher reports a refused reload instead of dropping it (#430 rest)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-430b-'));
  const file = path.join(dir, 'Team.kvpws');
  let reported = null;
  const files = new FileContainers({ paths: () => [file], setPaths: () => {}, onChange: () => {}, onReloadError: (p, e) => { reported = { p, e } } });
  const io = { read: () => fs.readFile(file, 'utf8').catch(() => null), write: (s) => fs.writeFile(file, s) };
  try {
    const v2 = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: passkey() });
    await v2.persist();
    await files.load();
    const entry = files.entries.get(v2.id);
    await fs.writeFile(file, asV1(await fs.readFile(file, 'utf8')));
    await files.watched(entry);
    assert.equal(reported?.p, file);
    assert.match(String(reported?.e), /manipuliert|tampered/);
    assert.match((await files.containers()).find((c) => c.id === v2.id)?.warning || '', /manipuliert|tampered/);
  } finally {
    files.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the desktop refuses the fall-back at the start and in the file watcher', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-430-'));
  const file = path.join(dir, 'Team.kvpws');
  const state = { paths: [file], pins: {}, notes: {} };
  const make = () => new FileContainers({
    paths: () => state.paths, setPaths: (p) => { state.paths = p; }, onChange: () => {},
    pins: () => state.pins, setPins: (p) => { state.pins = p; }, pinNotes: () => state.notes, setPinNotes: (n) => { state.notes = n; },
  });
  const io = { read: () => fs.readFile(file, 'utf8').catch(() => null), write: (s) => fs.writeFile(file, s) };
  let first = null;
  let later = null;
  try {
    const v2 = await FileVault.createSecure(io, { name: 'Team', email: 'alice@contoso.com', passkey: passkey() });
    await v2.persist();
    first = make();
    await first.load();
    const entry = first.entries.get(v2.id);
    assert.ok(entry?.vault?.secure, 'opened as secured');
    const secured = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, asV1(secured));
    await assert.rejects(first.reload(entry));
    assert.equal(first.entries.get(v2.id)?.vault?.secure, true, 'the open vault fell back');
    later = make();
    await later.load();
    assert.ok([...later.entries.values()].every((e) => e.error), 'refused at the start');
  } finally {
    first?.close();
    later?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
