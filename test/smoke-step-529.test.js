import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AreaCancelled, runArea, stopsWhenCancelled } from '../desktop/smoke-step.js';
import { lockHeldMessage, takeSmokeLock } from '../scripts/smoke-lock.mjs';

// #529: a smoke area that hits its limit is cancelled and waited for, so it cannot disturb the next areas; one smoke
// run at a time through %TEMP%\keevault-smoke.lock.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('an area in time returns its result, its own error stays its error', async () => {
  assert.equal(await runArea(async () => 7, { limitMs: 200 }), 7);
  await assert.rejects(runArea(async () => { throw new Error('own'); }, { limitMs: 200 }), /own/);
});

test('an area over its limit stops at its next sleep, and the run waits for its end', async () => {
  const sleep = stopsWhenCancelled(wait);
  let steps = 0;
  let ended = false;
  const area = async () => {
    try { for (;;) { await sleep(20); steps++; } } finally { ended = true; }
  };
  await assert.rejects(runArea(area, { limitMs: 100, graceMs: 1000 }), /^Error: timeout after 0\.1 s$/);
  assert.ok(ended, 'the area had ended before the next one may start');
  const after = steps;
  await wait(100);
  assert.equal(steps, after, 'nothing of the area runs any more');
});

test('without the cancel (the old race) the area would go on: the wrappers are the difference', async () => {
  let steps = 0;
  const area = async () => { for (let i = 0; i < 20; i++) { await wait(20); steps++; } };
  await assert.rejects(runArea(area, { limitMs: 60, graceMs: 30 }), /left behind/);
  const after = steps;
  await wait(120);
  assert.ok(steps > after, 'unwrapped waits are not stopped – smoke-features.js must use the wrapped js and sleep');
});

test('wrapped calls outside an area, and in the next area, are not affected', async () => {
  const sleep = stopsWhenCancelled(wait);
  await sleep(1);
  await assert.rejects(runArea(async () => { for (;;) await sleep(10); }, { limitMs: 50, graceMs: 500 }), /timeout/);
  assert.equal(await runArea(async () => { await sleep(10); return 'next'; }, { limitMs: 500 }), 'next');
  assert.ok(new AreaCancelled() instanceof Error);
});

test('smoke-features.js runs its areas through runArea with the wrapped js and sleep', () => {
  const src = readFileSync(new URL('../desktop/smoke-features.js', import.meta.url), 'utf8');
  assert.match(src, /js = stopsWhenCancelled\(ctx\.js\), sleep = stopsWhenCancelled\(ctx\.sleep\)/);
  assert.match(src, /await runArea\(fn, \{ limitMs: 45_000 \}\);/);
  assert.doesNotMatch(src, /Promise\.race\(\[fn\(\)/);
});

test('smoke lock: taken, refused while a live process holds it, taken over when its process is gone', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kv-lock-'));
  const file = path.join(dir, 'keevault-smoke.lock');
  const first = takeSmokeLock({ file, pid: 111, alive: () => true });
  assert.equal(first.ok, true);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 111);
  const second = takeSmokeLock({ file, pid: 222, alive: (pid) => pid === 111 });
  assert.equal(second.ok, false);
  assert.equal(second.holder.pid, 111);
  assert.match(lockHeldMessage(second.holder), /PID 111/);
  const stale = takeSmokeLock({ file, pid: 333, alive: () => false });
  assert.equal(stale.ok, true, 'a lock of a dead process is taken over');
  first.release(); // not its lock any more: stays
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, 333);
  stale.release();
  assert.equal(existsSync(file), false);
  writeFileSync(file, 'garbage');
  assert.equal(takeSmokeLock({ file, pid: 444, alive: () => true }).ok, true, 'an unreadable lock is taken over');
});

test('npm run smoke takes the lock before it starts anything', () => {
  const src = readFileSync(new URL('../scripts/smoke.mjs', import.meta.url), 'utf8');
  assert.ok(src.indexOf('takeSmokeLock(') < src.indexOf('spawnSync(process.execPath'));
  assert.match(src, /if \(!lock\.ok\) \{\s*console\.error\(lockHeldMessage\(lock\.holder\)\);\s*process\.exit\(2\);/);
});
