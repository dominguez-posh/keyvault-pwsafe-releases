// #374: what can be checked without Electron or a browser. The rest is in the smoke checks (agentlock, devices, extension).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyInTime } from '../desktop/copy-in-time.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('copy in time: on time counts, no second step', async () => {
  let late = 0;
  assert.equal(await copyInTime(async () => {}, 200, () => { late++; }), true);
  await wait(250);
  assert.equal(late, 0);
});

test('copy in time: too late is refused, and the late copy gets cleaned up', async () => {
  let late = 0;
  assert.equal(await copyInTime(() => wait(60), 10, () => { late++; }), false);
  assert.equal(late, 0, 'not there yet');
  await wait(100);
  assert.equal(late, 1);
});

test('copy in time: a copy that fails is no success, early or late', async () => {
  let late = 0;
  const failing = () => Promise.reject(new Error('blocked'));
  assert.equal(await copyInTime(failing, 50, () => { late++; }), false);
  assert.equal(await copyInTime(async () => { await wait(30); throw new Error('blocked'); }, 5, () => { late++; }), false);
  await wait(60);
  assert.equal(late, 0);
});

test('the TeamViewer password stays off the command line', () => {
  assert.doesNotMatch(source('../desktop/main/devices.js'), /--Password/);
});

test('cs:msRemember checks the host like the other Microsoft commands', () => {
  const handler = /'cs:msRemember': async \(\{ key \}, sender\) => \{[\s\S]*?\n {2}\},/.exec(source('../extension/background.js'))?.[0] || '';
  assert.match(handler, /signInHost\(sender\)/);
  assert.match(handler, /MS_LOGIN_HOSTS\.test\(host\)/);
});
