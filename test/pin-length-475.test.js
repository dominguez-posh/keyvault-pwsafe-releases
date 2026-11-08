// #475: a new app PIN needs at least 6 characters. PINs set earlier with 4 or 5 keep unlocking and are marked `short`
// once entered, so settings and the lock screen ask to change them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hashPin, verifyPin, isShortPin, markShort, MIN_PIN_LENGTH } from '../desktop/pin.js';
import { MIN_PIN_LENGTH as WINDOW_MIN, pinTyping } from '../desktop/renderer/app/pin-typed.js';
import EN from '../extension/core/i18n-en.js';

const src = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');

test('475: 6 characters is the minimum, in the main process and the window', () => {
  assert.equal(MIN_PIN_LENGTH, 6);
  assert.equal(WINDOW_MIN, 6);
  assert.equal(isShortPin('25801'), true, '5 characters refused');
  assert.equal(isShortPin('258013'), false, '6 characters accepted');
  assert.equal(isShortPin(''), true);
});

test('475: setPin refuses a short PIN before anything changes (offline mirror, stored hash)', async () => {
  const s = await src('desktop/main/api/app.js');
  const body = s.slice(s.indexOf('async setPin('), s.indexOf('async unlock('));
  const check = body.indexOf("if (next != null && isShortPin(next)) throw new Error(t('Die PIN braucht mindestens {n} Zeichen'");
  assert.ok(check > 0, 'length check in setPin');
  assert.ok(check < body.indexOf('rekey('), 'checked before the offline mirror is re-keyed');
  assert.ok(check < body.indexOf('hashPin(next)'), 'checked before the hash is stored');
  assert.equal(EN['Die PIN braucht mindestens {n} Zeichen'], 'The PIN needs at least {n} characters');
});

test('475: an existing 4-character PIN still unlocks and is marked short; a 6-character one is not', async () => {
  const old = await hashPin('2580');
  assert.equal(await verifyPin('2580', old), true, 'old short PIN unlocks');
  const marked = markShort(old, '2580');
  assert.equal(marked.short, true);
  assert.equal(await verifyPin('2580', marked), true, 'still unlocks after marking');
  assert.equal(markShort(marked, '2580'), null, 'nothing to write again');

  const fresh = await hashPin('258013');
  assert.equal(markShort(fresh, '258013'), null, 'a 6-character PIN is not marked');
  assert.equal('short' in markShort({ ...fresh, short: true }, '258013'), false, 'mark removed');

  const s = await src('desktop/main/api/app.js');
  assert.match(s, /pinShort: !!settings\.appPin\?\.short/);
  assert.match(s, /const marked = markShort\(record, pin\);\s*if \(marked\) config\.update\(\{ appPin: marked \}\);/);
});

test('475: settings and the lock screen show the notice, in German and English; texts say 6', async () => {
  const notice = 'Deine PIN ist kürzer als 6 Zeichen – bitte ändern';
  assert.equal(EN[notice], 'Your PIN is shorter than 6 characters – please change it');
  assert.match(await src('desktop/renderer/app/settings.js'), /st\.pinShort \? h\('div', \{ class: 'notice warn pin-short' \}, t\('Deine PIN ist kürzer als 6 Zeichen/);
  const start = await src('desktop/renderer/app/start.js');
  assert.match(start, /pin && st\.pinShort \? h\('div', \{ class: 'notice warn pin-short' \}/);
  assert.match(start, /if \(r\.pinShort\) toast\(t\('Deine PIN ist kürzer als 6 Zeichen/);
  const dialog = await src('desktop/renderer/app/admin-mode.js');
  assert.doesNotMatch(dialog, /[Mm]indestens 4 Zeichen/);
  assert.equal((dialog.match(/[Mm]indestens 6 Zeichen/g) || []).length, 2);
  for (const [de, en] of Object.entries(EN)) {
    if (/PIN/.test(de)) assert.doesNotMatch(`${de} ${en}`, /(mindestens|at least) 4 (Zeichen|characters)/i, de);
  }
});

test('475/472: Enter confirms from 6 typed characters, not from 5', () => {
  const key = (timeStamp) => ({ isTrusted: true, timeStamp, inputType: 'insertText' });
  const type = (text) => {
    const tr = pinTyping(5);
    let v = '';
    for (const [i, ch] of [...text].entries()) { tr.before(v); v += ch; tr.input(key(10 + i), v); }
    return tr.ready(v);
  };
  assert.equal(type('25801'), false);
  assert.equal(type('258013'), true);
});
