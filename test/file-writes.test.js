import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
