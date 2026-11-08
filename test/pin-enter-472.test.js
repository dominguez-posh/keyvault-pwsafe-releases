// #472: Enter in the PIN field of an agent request and of the Windows passkey confirmation confirms only a PIN typed in
// full after the dialog appeared; empty, pasted, prefilled or too short does not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MIN_PIN_LENGTH, pinTyping } from '../desktop/renderer/app/pin-typed.js';
import { MIN_PIN_LENGTH as MAIN_MIN } from '../desktop/pin.js';

const key = (timeStamp, inputType = 'insertText') => ({ isTrusted: true, timeStamp, inputType });
// Keys as the field sees them: beforeinput with the old value, input with the new one.
const typeInto = (tracker, text, from = 10, start = '') => {
  let value = start;
  for (const [i, ch] of [...text].entries()) {
    tracker.before(value);
    value += ch;
    tracker.input(key(from + i), value);
  }
  return value;
};

test('472: typed PIN after the dialog appeared confirms with Enter', () => {
  const tr = pinTyping(5);
  assert.equal(tr.ready(typeInto(tr, '246813')), true);
  // Typing, a backspace and typing again is still typed by hand.
  const tr2 = pinTyping(5);
  typeInto(tr2, '24x');
  tr2.before('24x');
  tr2.input(key(20, 'deleteContentBackward'), '24');
  assert.equal(tr2.ready(typeInto(tr2, '6813', 21, '24')), true);
});

test('472: empty, too short, pasted, dropped, prefilled or scripted does not confirm', () => {
  assert.equal(pinTyping(5).ready(''), false, 'empty');
  const short = pinTyping(5);
  assert.equal(short.ready(typeInto(short, '24681')), false, 'shorter than the minimum');

  const pasted = pinTyping(5);
  pasted.input(key(10, 'insertFromPaste'), '246813');
  assert.equal(pasted.ready('246813'), false, 'pasted');
  // A paste followed by typing still does not count; clearing the field does.
  pasted.input(key(11), '2468139');
  assert.equal(pasted.ready('2468139'), false, 'pasted then typed');
  pasted.input(key(12, 'deleteContentBackward'), '');
  assert.equal(pasted.ready(typeInto(pasted, '246813', 13)), true, 'cleared and typed again');

  const dropped = pinTyping(5);
  dropped.input(key(10, 'insertFromDrop'), '246813');
  assert.equal(dropped.ready('246813'), false, 'dropped');

  const autofill = pinTyping(5);
  autofill.input(key(10, 'insertReplacementText'), '246813');
  assert.equal(autofill.ready('246813'), false, 'filled in by the browser');

  // Prefilled or set by a script: the value changed without an input event.
  assert.equal(pinTyping(5).ready('246813'), false, 'prefilled');
  const later = pinTyping(5);
  typeInto(later, '24');
  assert.equal(later.ready('246813'), false, 'value set by a script after typing');
  // Prefilled and then completed by typing: the prefilled part was not typed.
  const topped = pinTyping(5);
  assert.equal(topped.ready(typeInto(topped, '3', 10, '24681')), false, 'prefilled, last key typed');

  const synthetic = pinTyping(5);
  synthetic.input({ isTrusted: false, timeStamp: 10, inputType: 'insertText' }, '246813');
  assert.equal(synthetic.ready('246813'), false, 'untrusted event');

  const early = pinTyping(50);
  assert.equal(early.ready(typeInto(early, '246813', 10)), false, 'keys before the dialog appeared');
});

test('472: after a wrong PIN the cleared field starts over', () => {
  const tr = pinTyping(5);
  tr.input(key(10, 'insertFromPaste'), '0000');
  tr.reset();
  assert.equal(tr.ready(''), false);
  assert.equal(tr.ready(typeInto(tr, '246813', 20)), true);
});

test('472: minimum length matches the app PIN rule', () => {
  assert.equal(MIN_PIN_LENGTH, MAIN_MIN);
});

test('472: both PIN fields use the tracker for Enter; the button keeps its delay and press check (#405)', async () => {
  const src = await readFile(new URL('../desktop/renderer/app/requests.js', import.meta.url), 'utf8');
  assert.match(src, /q-pin-input[\s\S]{0,200}onbeforeinput: \(\) => typing\.before\(pinInput\.value\),\s*oninput: \(e\) => typing\.input\(e, pinInput\.value\)/);
  assert.match(src, /win-pin-input[\s\S]{0,200}onbeforeinput: \(\) => typing\.before\(pinInput\.value\)/);
  assert.match(src, /if \(choice !== null && pinRequests\.single\(reqKey\) && typing\.ready\(pinInput\.value\)\) submitPin\(\);/);
  assert.match(src, /win-pin-input[\s\S]{0,200}oninput: \(e\) => typing\.input\(e, pinInput\.value\)/);
  assert.match(src, /r\.candidates\.length === 1 && pinRequests\.single\(reqKey\) && typing\.ready\(pinInput\.value\)\) choose\(r\.candidates\[0\]\)/);
  assert.match(src, /if \(!delayPassed \|\| choice === null \|\| \(e\.detail > 0 && !pressedInTime\)\) return;/);
  // Enter outside the PIN field still restarts the delay instead of confirming.
  assert.match(src, /if \(!delayPassed \|\| !confirming\) startDelay\(\);/);
  // Enter in the PIN field no longer goes through the button (which the restarted delay blocked).
  assert.doesNotMatch(src, /q-pin-input[^\n]*\n[^\n]*allow\.click\(\)/);
});
