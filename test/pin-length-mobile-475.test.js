// #475 (Lucas, 2026-11-08): the PIN has at least 6 characters everywhere, the mobile app too. New and changed PINs
// need 6; an older shorter PIN still unlocks and asks to be changed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MIN_PIN_LENGTH, isShortPin } from '../mobile/www/pin-rule.mjs';
import { MIN_PIN_LENGTH as DESKTOP_MIN } from '../desktop/pin.js';

const src = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('475 mobile: same minimum as the desktop, 6 characters', () => {
  assert.equal(MIN_PIN_LENGTH, 6);
  assert.equal(MIN_PIN_LENGTH, DESKTOP_MIN);
  assert.equal(isShortPin('12345'), true);
  assert.equal(isShortPin('1234'), true);
  assert.equal(isShortPin('123456'), false);
  assert.equal(isShortPin(''), true);
  assert.equal(isShortPin(null), true);
});

test('475 mobile: setting and changing the PIN use the rule, unlocking does not', async () => {
  const auth = await src('mobile/www/auth.js');
  const app = await src('mobile/www/app.js');
  assert.doesNotMatch(auth + app, /length < 4|n: 4 \}/, 'no 4-character rule left');
  // Auth.setPin refuses a short PIN; restore (unlocking) has no length check, so older PINs still work.
  const setPin = auth.slice(auth.indexOf('async setPin('), auth.indexOf('async save('));
  assert.match(setPin, /if \(isShortPin\(pin\)\) throw/);
  const restore = auth.slice(auth.indexOf('async restore('), auth.indexOf('lock()'));
  assert.doesNotMatch(restore, /isShortPin|length/);
  // Set-PIN screen and change dialog check before saving.
  assert.match(app, /if \(isShortPin\(input\.value\)\) return toast\(t\('Die PIN braucht mindestens \{n\} Zeichen', \{ n: MIN_PIN_LENGTH \}\)/);
  assert.match(app, /if \(isShortPin\(next\.value\)\) throw new Error\(t\('Die PIN braucht mindestens \{n\} Zeichen', \{ n: MIN_PIN_LENGTH \}\)\);/);
  // After unlocking with a short PIN: the request to change it.
  const pinScreen = app.slice(app.indexOf('function pinScreen('), app.indexOf('// ---------------------------------------------------------------- main'));
  assert.match(pinScreen, /const short = isShortPin\(input\.value\);[\s\S]*if \(short\) toast\(t\('Deine PIN ist kürzer als 6 Zeichen – bitte ändern'\)/);
});
