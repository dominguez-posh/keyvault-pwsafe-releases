import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sharedRead, forgetSharedReads } from '../desktop/shared-read.js';

// #526: the extension hint, the settings and the start read the device's policies (~50 reg.exe each). Callers that come
// while a read runs share it; afterwards and after a setup step the next caller reads anew.

const later = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

test('callers during a running read share it; the next caller after it reads anew', async () => {
  let reads = 0;
  const gate = later();
  const read = sharedRead(async () => { reads++; await gate.p; return reads; });
  const all = Promise.all([read(), read(), read(), read(), read(), read(), read()]);
  gate.resolve();
  assert.deepEqual(await all, [1, 1, 1, 1, 1, 1, 1]);
  assert.equal(reads, 1);
  assert.equal(await read(), 2);
});

test('after a setup step nobody joins a read from before it', async () => {
  let reads = 0;
  const gates = [later(), later()];
  const read = sharedRead(async () => { const n = reads++; await gates[n].p; return n === 0 ? 'before' : 'after'; });
  const old = read();
  forgetSharedReads();
  const fresh = read();
  gates[1].resolve();
  gates[0].resolve();
  assert.equal(await fresh, 'after');
  assert.equal(await old, 'before');
  assert.equal(reads, 2);
});

test('a failed read is not kept', async () => {
  let reads = 0;
  const read = sharedRead(async () => { reads++; if (reads === 1) throw new Error('reg.exe failed'); return 'ok'; });
  await assert.rejects(read(), /reg\.exe failed/);
  assert.equal(await read(), 'ok');
});

test('the hint, the reinstall state and the settings read the policies through the shared read', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(src('../desktop/main/extension-channel.js'), /sharedRead\(\(\) => readPolicies\(\)\)/);
  assert.match(src('../desktop/main/api/vaults.js'), /machineSetupStatus: \(\) => machineStatus\(\)/);
  // Every setup step drops the shared read afterwards.
  assert.match(src('../desktop/main/extension-channel.js'), /runSetup\([^)]*\)\.finally\(forgetSharedReads\)/);
  assert.match(src('../desktop/main/extension-reinstall.js'), /runReinstallSetup\([^)]*\)\.finally\(forgetSharedReads\)/);
  assert.match(src('../desktop/main/api/vaults.js'), /runMachineSetup\(\)\.finally\(forgetSharedReads\)/);
});
