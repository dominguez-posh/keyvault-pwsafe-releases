// #472, review findings: (1) Enter in a PIN field confirms only while exactly one request is open, and the keys typed
// before the dialogs shown changed lapse; (2) a settings patch can't write the app PIN, its counter or the personal
// device keys.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openRequests, pinTyping } from '../desktop/renderer/app/pin-typed.js';
import { PIN_ONLY_SETTINGS, pinOnlyKeys } from '../desktop/pin.js';

const key = (timeStamp, inputType = 'insertText') => ({ isTrusted: true, timeStamp, inputType });
const typeInto = (tracker, text, from = 10, start = '') => {
  let value = start;
  for (const [i, ch] of [...text].entries()) {
    tracker.before(value);
    value += ch;
    tracker.input(key(from + i), value);
  }
  return value;
};

test('472 review: Enter only while exactly one request is open', () => {
  let clock = 100;
  const reqs = openRequests(() => clock);
  const hints = {};
  reqs.add('q:A', pinTyping(5), (single) => { hints.A = single; });
  assert.equal(reqs.single('q:A'), true);
  assert.equal(hints.A, true);
  reqs.add('q:B', pinTyping(clock), (single) => { hints.B = single; });
  assert.equal(reqs.single('q:A'), false, 'A with B open');
  assert.equal(reqs.single('q:B'), false, 'B with A open');
  assert.deepEqual(hints, { A: false, B: false }, 'both dialogs show the click hint');
  // A Windows dialog without a PIN field counts as an open request too.
  reqs.remove('q:B');
  reqs.add('w:1', null, null);
  assert.equal(reqs.single('q:A'), false);
  reqs.remove('w:1');
  assert.equal(reqs.single('q:A'), true);
  assert.equal(hints.A, true);
  assert.equal(reqs.single('q:B'), false, 'a closed request is never single');
  reqs.remove('q:A');
  assert.equal(reqs.size, 0);
});

test('472 review: a change of the open requests lets the typed keys lapse', () => {
  let clock = 5;
  const reqs = openRequests(() => clock);
  const a = pinTyping(5);
  reqs.add('q:A', a);
  const typed = typeInto(a, '246813', 10);
  assert.equal(a.ready(typed), true);
  // B appears and goes again: A's PIN was typed before, it no longer counts for Enter.
  clock = 50;
  reqs.add('q:B', pinTyping(clock));
  clock = 60;
  reqs.remove('q:B');
  assert.equal(reqs.single('q:A'), true);
  assert.equal(a.ready(typed), false, 'keys typed before the change');
  // Topping up the old value does not help; clearing and typing again after the change does.
  assert.equal(a.ready(typeInto(a, '7', 70, typed)), false, 'old keys plus a new one');
  a.input(key(80, 'deleteContentBackward'), '');
  assert.equal(a.ready(typeInto(a, '246813', 81)), true, 'cleared and typed again');
  // Keys with a time stamp before the change (queued while B appeared) don't count.
  const b = pinTyping(5);
  b.expire(100);
  assert.equal(b.ready(typeInto(b, '246813', 90)), false, 'keys from before the change');
  // An empty field stays usable: nothing was typed that could lapse.
  const c = pinTyping(5);
  c.expire(100);
  assert.equal(c.ready(typeInto(c, '246813', 101)), true);
});

test('472 review: both PIN dialogs check the open requests before Enter confirms and show the hint', async () => {
  const src = await readFile(new URL('../desktop/renderer/app/requests.js', import.meta.url), 'utf8');
  assert.match(src, /if \(choice !== null && pinRequests\.single\(reqKey\) && typing\.ready\(pinInput\.value\)\) submitPin\(\);/);
  assert.match(src, /r\.candidates\.length === 1 && pinRequests\.single\(reqKey\) && typing\.ready\(pinInput\.value\)\) choose\(r\.candidates\[0\]\)/);
  assert.equal((src.match(/pinRequests\.add\(reqKey, typing,/g) || []).length, 2, 'agent question and Windows dialog register');
  assert.equal((src.match(/pinRequests\.remove\(reqKey\);/g) || []).length, 2, 'both deregister when closed');
  assert.match(src, /const reqKey = `q:\$\{q\.id\}`/);
  assert.match(src, /const reqKey = `w:\$\{r\.id\}`/);
  assert.match(src, /pinInput, pinMulti, pinError/);
});

test('472 review: settings patches with PIN-only keys are refused', async () => {
  assert.deepEqual([...PIN_ONLY_SETTINGS], ['appPin', 'pinGuard', 'personalDeviceKeys', 'windowHello']); // #512: windowHello
  assert.deepEqual(pinOnlyKeys({ appPin: null }), ['appPin'], 'clearing the PIN');
  assert.deepEqual(pinOnlyKeys({ appPin: { hash: 'x' } }), ['appPin']);
  assert.deepEqual(pinOnlyKeys({ pinGuard: null, zoom: 1 }), ['pinGuard']);
  assert.deepEqual(pinOnlyKeys({ personalDeviceKeys: {} }), ['personalDeviceKeys']);
  assert.deepEqual(pinOnlyKeys({ appPin: undefined }), ['appPin'], 'present with undefined counts too');
  assert.deepEqual(pinOnlyKeys({ zoom: 1, language: 'en' }), []);
  assert.deepEqual(pinOnlyKeys(null), []);
  assert.deepEqual(pinOnlyKeys(undefined), []);
  // Inherited keys are no part of the patch that reaches config.update.
  assert.deepEqual(pinOnlyKeys(Object.create({ appPin: null })), []);

  const api = await readFile(new URL('../desktop/main/api/app.js', import.meta.url), 'utf8');
  const body = api.slice(api.indexOf('updateSettings: async (patch) => {'));
  const guard = body.indexOf('if (pinOnlyKeys(patch).length) throw');
  assert.ok(guard > 0, 'updateSettings refuses PIN-only keys');
  assert.ok(guard < body.indexOf('config.update(patch)'), 'before the patch is written');
});

test('472 review: the window never sends PIN-only keys through updateSettings', async () => {
  const { readdir } = await import('node:fs/promises');
  const dir = new URL('../desktop/renderer/app/', import.meta.url);
  for (const name of await readdir(dir, { recursive: true })) {
    if (!name.endsWith('.js')) continue;
    const src = await readFile(new URL(name, dir), 'utf8');
    for (const m of src.matchAll(/call\('updateSettings',([^;]*)/g)) {
      for (const k of PIN_ONLY_SETTINGS) assert.ok(!new RegExp(`\\b${k}\\b`).test(m[1]), `${name} sends ${k}`);
    }
  }
});
