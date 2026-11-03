import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileContainers, retryBusy } from '../desktop/files.js';

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
