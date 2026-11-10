import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, page } from './fixtures/content-page.js';

// #502: the field menu offers Keevault only in real sign-in fields. Before, every text field whose name, id, placeholder
// or autocomplete held "e-mail", "account", "user" … got it: contact forms, newsletter boxes, search boxes.
// Runs the real content script (with field-kind.js) and presses the field like a person.

const shown = { left: 0, top: 0, bottom: 32, width: 300, height: 32 };

function setup({ host = 'shop.example', fields = [], form = true, totp = false } = {}) {
  let inputs = [];
  const p = page({
    host,
    replies: totp ? { 'cs:matches': { enabled: true, items: [{ id: '1', title: 'Fake', username: 'fake', hasTotp: true }], ui: {} } } : {},
    query: (sel) => (sel === 'input' ? inputs : []),
  });
  const box = form ? { getAttribute: () => null, querySelectorAll: (sel) => (sel === 'input' ? inputs : []) } : null;
  inputs = fields.map((spec) => {
    const i = new p.Input();
    Object.assign(i, { type: 'text', autocomplete: '', name: '', id: '', placeholder: '', form: box }, spec.props);
    const attrs = spec.attrs || {};
    i.getAttribute = (a) => (a in attrs ? attrs[a] : null);
    if (spec.classes) i.classList = { contains: (c) => spec.classes.includes(c) };
    if (spec.closest) i.closest = spec.closest;
    i.getBoundingClientRect = () => spec.rect || shown;
    i.compareDocumentPosition = (other) => (inputs.indexOf(other) > inputs.indexOf(i) ? 4 : 2); // order on the page
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

const user = { props: { type: 'email', name: 'email', autocomplete: 'email', placeholder: 'E-Mail' } };
const password = { props: { type: 'password', name: 'password', autocomplete: 'current-password' } };

test('#502 login form: the name field and the password field get the menu', async () => {
  let s = setup({ fields: [user, password] });
  assert.equal(await menuAt(s.p, s.inputs[0]), true, 'name field next to a password');
  s = setup({ fields: [user, password] });
  assert.equal(await menuAt(s.p, s.inputs[1]), true, 'password field');
});

test('#502 a name step of its own: autocomplete username or a field clearly named for the login', async () => {
  let s = setup({ fields: [{ props: { type: 'email', name: 'identifier', autocomplete: 'username' } }] });
  assert.equal(await menuAt(s.p, s.inputs[0]), true, 'autocomplete username');
  s = setup({ fields: [{ props: { name: 'username' } }] });
  assert.equal(await menuAt(s.p, s.inputs[0]), true, 'name=username without autocomplete');
});

test('#502/#463 Microsoft: the name page (only the e-mail field, an invisible password copy) and the password page', async () => {
  const hiddenPw = { props: { type: 'password', name: 'passwd' }, attrs: { 'aria-hidden': 'true' }, classes: ['moveOffScreen'] };
  let s = setup({ host: 'login.microsoftonline.com', fields: [{ props: { type: 'email', name: 'loginfmt' } }, hiddenPw] });
  assert.equal(await menuAt(s.p, s.inputs[0]), true, 'e-mail field of the name page');
  const hiddenName = { props: { type: 'text', name: 'loginfmt' }, attrs: { 'aria-hidden': 'true' }, classes: ['moveOffScreen'], rect: { left: 0, top: 0, bottom: 12, width: 20, height: 12 } };
  s = setup({ host: 'login.microsoftonline.com', fields: [hiddenName, { props: { type: 'password', name: 'passwd', autocomplete: 'current-password' } }] });
  assert.equal(await menuAt(s.p, s.inputs[1]), true, 'password field with the name shown above it');
});

test('#502 one-time-code field: the menu with the code entries', async () => {
  const s = setup({ fields: [{ props: { type: 'tel', name: 'otc', autocomplete: 'one-time-code' } }], totp: true });
  assert.equal(await menuAt(s.p, s.inputs[0]), true);
});

test('#502 search fields: no menu', async () => {
  const cases = [
    { props: { type: 'search', name: 'q' } },
    { props: { name: 'q' } },
    { props: { name: 'user-filter', placeholder: 'Search users' } },
    { props: { name: 'account' }, closest: (sel) => (/role=search/.test(sel) ? {} : null) },
    { props: { name: 'login-suche', placeholder: 'Konto suchen' } },
  ];
  for (const spec of cases) {
    const s = setup({ fields: [spec], form: false });
    assert.equal(await menuAt(s.p, s.inputs[0]), false, JSON.stringify(spec.props));
  }
});

test('#502 contact form, newsletter, address and autocomplete=off: no menu', async () => {
  const contact = [
    { props: { name: 'name', autocomplete: 'name', placeholder: 'Name' } },
    { props: { type: 'email', name: 'email', autocomplete: 'email', placeholder: 'E-Mail' } },
    { props: { type: 'tel', name: 'phone', placeholder: 'Telefon' } },
  ];
  for (let i = 0; i < contact.length; i++) {
    const s = setup({ fields: contact });
    assert.equal(await menuAt(s.p, s.inputs[i]), false, `contact form: ${contact[i].props.name}`);
  }
  let s = setup({ fields: [{ props: { type: 'email', name: 'newsletter-email', placeholder: 'Your e-mail' } }] });
  assert.equal(await menuAt(s.p, s.inputs[0]), false, 'newsletter');
  s = setup({ fields: [{ props: { name: 'account', autocomplete: 'off', placeholder: 'Account number' } }] });
  assert.equal(await menuAt(s.p, s.inputs[0]), false, 'autocomplete off without a password');
  s = setup({ fields: [{ props: { name: 'zip', autocomplete: 'postal-code', placeholder: 'Postal code' } }], totp: true });
  assert.equal(await menuAt(s.p, s.inputs[0]), false, 'postal code is no one-time code');
  s = setup({ fields: [{ props: { name: 'comment-author', placeholder: 'Your account e-mail for the comment' } }] });
  assert.equal(await menuAt(s.p, s.inputs[0]), false, 'comment form');
});

test('#502 a search box on a page with a login form: only the login fields get the menu', async () => {
  const search = { props: { type: 'search', name: 'q', form: null } };
  const s = setup({ fields: [search, user, password], form: false });
  assert.equal(await menuAt(s.p, s.inputs[0]), false, 'search box above the login');
});

test('#502 textarea: no menu', async () => {
  const s = setup({ fields: [user, password] });
  await flush();
  const area = { tagName: 'TEXTAREA', name: 'comment', getAttribute: () => null };
  s.p.press(area);
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(s.p.opened(), false);
});
