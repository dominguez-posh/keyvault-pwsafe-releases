import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, page } from './fixtures/content-page.js';

// The field menu names entries, so only real input at the field opens it (#380).

test('field menu: a script focus() or a synthetic focusin opens nothing', async () => {
  const p = page();
  p.scriptFocus();
  await flush();
  assert.equal(p.opened(), false);
  assert.deepEqual(p.sent.filter((c) => c === 'cs:matches'), [], 'entries are not even requested');
  p.blur();
  p.syntheticFocusin();
  await flush();
  assert.equal(p.opened(), false);
});

test('field menu: a real press elsewhere or other real keys do not let a script open it', async () => {
  const p = page();
  p.press(p.button);
  p.scriptFocus();
  await flush();
  assert.equal(p.opened(), false, 'press on a button, then focus()');
  const q = page();
  q.key('a', q.other);
  q.scriptFocus();
  await flush();
  assert.equal(q.opened(), false, 'key in another element, then focus()');
});

test('field menu: a synthetic pointerdown or key opens nothing', async () => {
  const p = page();
  p.press(p.field, { isTrusted: false });
  p.scriptFocus();
  await flush();
  assert.equal(p.opened(), false, 'synthetic pointerdown');
  const q = page();
  q.key('Tab', q.document.body, { isTrusted: false });
  q.scriptFocus();
  q.key('a', q.field, { isTrusted: false });
  await flush();
  assert.equal(q.opened(), false, 'synthetic keys');
});

test('field menu: a click at the field opens it', async () => {
  const p = page();
  p.press(p.field);
  await flush();
  assert.equal(p.opened(), true);
});

test('field menu: the Tab key opens it, once per press', async () => {
  const p = page();
  p.tabTo(p.field);
  await flush();
  assert.equal(p.opened(), true);
  const before = p.openings();
  p.blur();
  p.scriptFocus(p.other);
  await flush();
  assert.equal(p.openings(), before, 'the same Tab press does not open a second field');
});

test('field menu: an autofocused field opens on a click or the first key, Escape stays closed', async () => {
  const c = page();
  c.scriptFocus();
  c.press(c.field);
  await flush();
  assert.equal(c.opened(), true, 'click on the focused field');

  const k = page();
  k.scriptFocus();
  k.key('Shift');
  await flush();
  assert.equal(k.opened(), false, 'a modifier alone');
  k.key('a');
  await flush();
  assert.equal(k.openings(), 1, 'first typed key');
  k.key('Escape');
  await flush();
  k.key('b');
  await flush();
  assert.equal(k.openings(), 1, 'typing on after Escape');
});

test('field menu: a passkey request on a focused field waits for real input as well', async () => {
  const p = page();
  p.scriptFocus();
  p.passkeyRequest();
  await flush();
  assert.equal(p.opened(), false);
  p.press(p.field);
  await flush();
  assert.equal(p.opened(), true);

  const q = page();
  q.press(q.field);
  await flush();
  const before = q.openings();
  q.passkeyRequest();
  await flush();
  assert.equal(q.openings(), before + 1, 'a field the user is at shows the passkeys at once');
});
