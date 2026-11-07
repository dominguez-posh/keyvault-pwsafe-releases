import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileContainers, retryBusy } from '../desktop/files.js';
import { FileVault } from '../extension/core/filevault.js';

test('file vault: parallel saves (import) all land in the file, no temporary files left', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-writes-'));
  try {
    const file = path.join(dir, 'Import.kvpws');
    let paths = [];
    const containers = new FileContainers({ paths: () => paths, setPaths: (p) => { paths = p; }, onChange: () => {} });
    const { id } = await containers.create(file, 'Import', { password: 'Smoke-Pass-1234' }, 'me');
    await Promise.all(Array.from({ length: 20 }, (_, i) => containers.saveItem(id, { type: 'login', title: `Entry ${i}`, username: `u${i}`, password: `p${i}` })));
    assert.equal((await containers.summaries(id)).length, 20);
    // A fresh reader sees all of them: nothing was written over by a parallel save.
    const fresh = new FileContainers({ paths: () => [file], setPaths: () => {}, onChange: () => {} });
    await fresh.load();
    await fresh.unlock(id, { password: 'Smoke-Pass-1234' });
    assert.equal((await fresh.summaries(id)).length, 20);
    assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp')), []);
    containers.close();
    fresh.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('file vault: a new file where an old one was removed and deleted opens; a file swapped under an open path is still refused (#399)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-pins-'));
  let paths = [];
  let pins = {};
  const containers = new FileContainers({ paths: () => paths, setPaths: (p) => { paths = p; }, pins: () => pins, setPins: (p) => { pins = p; }, onChange: () => {} });
  try {
    const file = path.join(dir, 'Persoenlich.kvpws');
    const first = await containers.create(file, 'Eins', { password: 'Smoke-Pass-1234' }, 'me');
    containers.remove(first.id);
    await fs.rm(file);
    const second = await containers.create(file, 'Zwei', { password: 'Smoke-Pass-1234' }, 'me');
    assert.notEqual(second.id, first.id);
    assert.match(second.recoveryKey, /^RK-/);
    assert.equal(containers.get(second.id).locked, false);
    assert.equal(pins[file], second.id);
    // The check of the pin itself stays: the same path with another vault's file.
    const other = path.join(dir, 'Andere.kvpws');
    const third = await containers.create(other, 'Drei', { password: 'Smoke-Pass-1234' }, 'me');
    const swapped = new FileContainers({ paths: () => [file], setPaths: () => {}, pins: () => ({ [file]: third.id }), setPins: () => {}, onChange: () => {} });
    await swapped.load();
    assert.ok([...swapped.entries.values()].every((e) => e.error), 'refused');
    swapped.close();
  } finally {
    containers.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('file vault: a failed write of a new file leaves the pin of the old one (#399, Konrad F13)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-pins-'));
  const file = path.join(dir, 'Persoenlich.kvpws');
  let pins = { [file]: 'file-old' };
  const containers = new FileContainers({ paths: () => [], setPaths: () => {}, pins: () => pins, setPins: (p) => { pins = p; }, onChange: () => {} });
  const { persist } = FileVault.prototype;
  FileVault.prototype.persist = async () => { throw new Error('disk full'); };
  try {
    await assert.rejects(containers.create(file, 'Neu', { password: 'Smoke-Pass-1234' }, 'me'), /disk full/);
    assert.equal(pins[file], 'file-old');
  } finally {
    FileVault.prototype.persist = persist;
    containers.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('file vault: parallel new recovery keys leave one working key, the last (#399)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-keyring-'));
  let paths = [];
  const containers = new FileContainers({ paths: () => paths, setPaths: (p) => { paths = p; }, onChange: () => {} });
  try {
    const file = path.join(dir, 'Keyring.kvpws');
    const { id } = await containers.create(file, 'Keyring', { password: 'Smoke-Pass-1234' }, 'me');
    // Read, change and write of the keyring don't overlap: each change starts from the one before.
    const vault = containers.get(id);
    const write = vault.setKeyring.bind(vault);
    let writing = 0;
    let most = 0;
    vault.setKeyring = async (keyring) => {
      most = Math.max(most, ++writing);
      await new Promise((r) => setTimeout(r, 50));
      await write(keyring);
      writing--;
    };
    const [first, second] = await Promise.all([
      containers.updateKeyring(id, { type: 'newRecovery' }, 'me'),
      containers.updateKeyring(id, { type: 'newRecovery' }, 'me'),
    ]);
    assert.equal(most, 1, 'keyring changes overlapped');
    assert.equal(containers.get(id).keyring.entries.filter((e) => e.type === 'recovery').length, 1);
    const fresh = new FileContainers({ paths: () => [file], setPaths: () => {}, onChange: () => {} });
    await fresh.load();
    await assert.rejects(fresh.unlock(id, { code: first.recoveryKey }));
    await fresh.unlock(id, { code: second.recoveryKey });
    fresh.close();
  } finally {
    containers.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('file vault: parallel keyring changes both stay (#399)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-keyring-'));
  try {
    const file = path.join(dir, 'Keyring.kvpws');
    let paths = [];
    const containers = new FileContainers({ paths: () => paths, setPaths: (p) => { paths = p; }, onChange: () => {} });
    const { id } = await containers.create(file, 'Keyring', { password: 'Smoke-Pass-1234' }, 'me');
    const [, renewed] = await Promise.all([
      containers.updateKeyring(id, { type: 'setPassword', password: 'Neues-Passwort-5678' }, 'me'),
      containers.updateKeyring(id, { type: 'newRecovery' }, 'me'),
    ]);
    const fresh = new FileContainers({ paths: () => [file], setPaths: () => {}, onChange: () => {} });
    await fresh.load();
    await fresh.unlock(id, { password: 'Neues-Passwort-5678' }); // the password change was not written over
    fresh.get(id).lock();
    await fresh.unlock(id, { code: renewed.recoveryKey }); // nor the new recovery key
    assert.equal(fresh.get(id).keyring.entries.filter((e) => e.type === 'recovery').length, 1);
    containers.close();
    fresh.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('file vault damaged by the 0.9.13/0.9.14 import (whole vault + rest of another write) opens again and is repaired', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kv-repair-'));
  try {
    const file = path.join(dir, 'Persoenlich.kvpws');
    let paths = [];
    const containers = new FileContainers({ paths: () => paths, setPaths: (p) => { paths = p; }, onChange: () => {} });
    const { id } = await containers.create(file, 'Persönlich', { password: 'Smoke-Pass-1234' }, 'me');
    for (let i = 0; i < 3; i++) await containers.saveItem(id, { type: 'login', title: `Entry ${i}`, username: `u${i}`, password: `p${i}` });
    containers.close();
    const good = await fs.readFile(file, 'utf8');
    // What the race left: the complete vault, then the tail of a longer write.
    await fs.writeFile(file, `${good}${good.slice(Math.floor(good.length / 3))}`);
    assert.throws(() => JSON.parse(readFileSync(file, 'utf8')));
    const again = new FileContainers({ paths: () => [file], setPaths: () => {}, onChange: () => {} });
    await again.load();
    await again.unlock(id, { password: 'Smoke-Pass-1234' });
    const items = await again.summaries(id);
    assert.equal(items.length, 3);
    assert.equal((await again.getItem(id, items.find((x) => x.title === 'Entry 1').id)).password, 'p1');
    // The next save writes a clean file.
    await again.saveItem(id, { type: 'login', title: 'After repair', username: 'r', password: 'r' });
    assert.equal(Object.keys(JSON.parse(await fs.readFile(file, 'utf8')).items).length, 4);
    again.close();
    // Not a vault at all stays an error.
    await fs.writeFile(file, 'garbage {"format": 1');
    const broken = new FileContainers({ paths: () => [file], setPaths: () => {}, onChange: () => {} });
    await broken.load();
    assert.match((await broken.containers()).find((c) => c.path === file)?.error?.message || '', /kein Keevault-Tresor|not a Keevault vault/);
    broken.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('file vault: a file held by OneDrive/virus scanner (EPERM, EBUSY) is tried again, other errors are not', async () => {
  let calls = 0;
  const busy = (code) => Object.assign(new Error(code), { code });
  assert.equal(await retryBusy(async () => { if (++calls < 3) throw busy(calls === 1 ? 'EPERM' : 'EBUSY'); return 'ok'; }), 'ok');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryBusy(async () => { calls++; throw busy('ENOSPC'); }), /ENOSPC/);
  assert.equal(calls, 1);
  await assert.rejects(retryBusy(async () => { throw busy('EPERM'); }, 200), /EPERM/);
});
