import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, page } from './fixtures/content-page.js';

// #504: made-up autocomplete values ("nope", "false") that pages set to keep the browser's autofill away do not count as
// another purpose: a one-time-code field and a login name field with them still get the field menu. Real autofill names
// (postal-code, email, …) and "off" keep it away as before. Same setup as field-kind-502.test.js.

const shown = { left: 0, top: 0, bottom: 32, width: 300, height: 32 };

function setup({ fields = [], totp = false } = {}) {
  let inputs = [];
  const p = page({
    host: 'shop.example',
    replies: totp ? { 'cs:matches': { enabled: true, items: [{ id: '1', title: 'Fake', username: 'fake', hasTotp: true }], ui: {} } } : {},
    query: (sel) => (sel === 'input' ? inputs : []),
  });
  const box = { getAttribute: () => null, querySelectorAll: (sel) => (sel === 'input' ? inputs : []) };
  inputs = fields.map((props) => {
    const i = new p.Input();
    Object.assign(i, { type: 'text', autocomplete: '', name: '', id: '', placeholder: '', form: box }, props);
    i.getAttribute = () => null;
    i.getBoundingClientRect = () => shown;
    i.compareDocumentPosition = (other) => (inputs.indexOf(other) > inputs.indexOf(i) ? 4 : 2);
    return i;
  });
  return { p, inputs };
}

async function menuAt(p, input) {
  await flush();
  p.press(input);
  for (let i = 0; i < 4; i++) await flush();
  return p.opened();
}

test('#504 one-time-code field with a made-up autocomplete value: the menu with the code entries', async () => {
  for (const autocomplete of ['nope', 'false', 'new-field-7']) {
    const s = setup({ fields: [{ type: 'tel', name: 'otp', maxLength: 6, autocomplete }], totp: true });
    assert.equal(await menuAt(s.p, s.inputs[0]), true, autocomplete);
  }
});

test('#504 login name step with a made-up autocomplete value: the menu', async () => {
  for (const autocomplete of ['nope', 'false']) {
    const s = setup({ fields: [{ name: 'username', autocomplete }] });
    assert.equal(await menuAt(s.p, s.inputs[0]), true, autocomplete);
  }
});

test('#504 real autofill names and "off" still keep the menu away', async () => {
  let s = setup({ fields: [{ name: 'otp-zip', maxLength: 6, autocomplete: 'shipping postal-code' }], totp: true });
  assert.equal(await menuAt(s.p, s.inputs[0]), false, 'postal code with a section token');
  s = setup({ fields: [{ name: 'username', autocomplete: 'off' }] });
  assert.equal(await menuAt(s.p, s.inputs[0]), false, 'autocomplete off without a password');
  s = setup({ fields: [{ type: 'email', name: 'login-email', autocomplete: 'email' }] });
  assert.equal(await menuAt(s.p, s.inputs[0]), false, 'autocomplete email without a password');
});
