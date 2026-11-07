import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flush, page } from './fixtures/content-page.js';

// Clickjacking at the passkey tag and the sign-in bars (#401): the same page-owned host element, the same remedy.
const ui = { menuRefused: 'refused', msTitle: 'Microsoft', msSearch: 's', msNone: 'n', msRemember: 'r', bastionPickTitle: 'Bastion', bastionSave: 's', bastionSaveOnly: 'o' };
const account = { key: 'k', containerId: 'c', id: 'i', title: 'zebra-title', username: 'zebra-user', container: 'zebra-vault' };
const count = (p, cmd) => p.sent.filter((c) => c === cmd).length;

const surfaces = {
  'passkey tag': {
    open: async () => {
      const p = page({ replies: { 'cs:webauthn': { inline: { kind: 'get', requestId: 'q', candidates: [{ userName: 'zebra-user', title: 'zebra-title', container: 'zebra-vault', containerId: 'c', itemId: 'i', credentialId: 'x' }], containers: [], ui } } } });
      p.passkeyRequest();
      await flush();
      return p;
    },
    target: 'primary', act: (p, o) => p.click('primary', o), done: (p) => count(p, 'cs:webauthnSelect'),
  },
  'Microsoft bar': {
    open: async () => {
      const p = page({ host: 'login.microsoftonline.com', signIn: 'ms', replies: { 'cs:msAccounts': { accounts: [account], ui } } });
      await flush();
      await flush();
      return p;
    },
    target: 'banner', act: (p, o) => p.click('entry', o), done: (p) => count(p, 'cs:msAccount'),
  },
  'Bastion bar': {
    open: async () => {
      const p = page({ host: 'bastion.azure.com', signIn: 'bastion', replies: { 'cs:bastionAccounts': { accounts: [account], vmName: 'vm', ui } } });
      await flush();
      await flush();
      return p;
    },
    target: 'banner bastion-pick', act: (p, o) => p.click('entry', o), done: (p) => count(p, 'cs:bastionAccount'),
  },
  '"Save" in the Bastion bar': {
    open: async () => {
      const p = page({ host: 'bastion.azure.com', signIn: 'bastion', replies: { 'cs:bastionAccounts': { accounts: [account], vmName: 'vm', ui } } });
      await flush();
      await flush();
      return p;
    },
    target: 'banner bastion-pick', act: (p, o) => p.click('b save-only', o), done: (p) => count(p, 'cs:bastionAccount'),
  },
  '"Forget" in the Microsoft bar': {
    open: async () => {
      const p = page({ host: 'login.microsoftonline.com', signIn: 'ms', replies: { 'cs:msAccounts': { accounts: [account], defaultKey: 'another', ui } } });
      await flush();
      await flush();
      return p;
    },
    target: 'banner', act: (p, o) => p.click('b', o), done: (p) => count(p, 'cs:msRemember'),
  },
  // #411: the page calls the bar under the pointer, "Update" replaces the stored password.
  'save bar': {
    open: async () => {
      const p = page({ replies: { 'cs:pending': { action: 'update', title: 'zebra-title', host: 'shop.example', username: 'zebra-user', containers: [], ui } } });
      await flush();
      return p;
    },
    target: 'banner', act: (p, o) => p.click('b primary', o), done: (p) => count(p, 'cs:saveCaptured'),
  },
  '"never" in the save bar': {
    open: async () => {
      const p = page({ replies: { 'cs:pending': { action: 'save', host: 'shop.example', username: 'zebra-user', containers: [], ui } } });
      await flush();
      return p;
    },
    target: 'banner', act: (p, o) => p.click('b', o), done: (p) => count(p, 'cs:dismissCaptured'),
  },
};

test('passkey tag #405: its button does not take the focus, a space or Enter while typing would sign in', async () => {
  const p = await surfaces['passkey tag'].open();
  assert.equal(p.watcher().target.className, 'primary', 'the tag is open');
  assert.deepEqual(p.focused(), []);
});

for (const [name, s] of Object.entries(surfaces)) {
  test(`${name} #401: asks the browser about real visibility of the surface`, async () => {
    const p = await s.open();
    assert.equal(p.watcher().options.trackVisibility, true);
    assert.equal(p.watcher().target.className, s.target);
  });

  test(`${name} #401: a real click on a surface the browser never called visible does nothing`, async () => {
    const p = await s.open();
    p.wait(5000);
    s.act(p);
    await flush();
    assert.equal(s.done(p), 0, 'no report yet');
    p.browserSays(false);
    p.wait(5000);
    s.act(p);
    await flush();
    assert.equal(s.done(p), 0, 'covered or transparent');
  });

  test(`${name} #401: just appeared, covered in between: no click; visible long enough: real click only`, async () => {
    const p = await s.open();
    p.browserSays(true);
    s.act(p);
    await flush();
    assert.equal(s.done(p), 0, 'at once');
    p.wait(5000);
    p.browserSays(false);
    p.browserSays(true);
    p.wait(499);
    s.act(p);
    await flush();
    assert.equal(s.done(p), 0, 'time started over');
    p.wait(1);
    s.act(p, { isTrusted: false });
    await flush();
    assert.equal(s.done(p), 0, 'synthetic click');
    s.act(p);
    await flush();
    assert.equal(s.done(p), 1);
  });
}

test('save bar #411: closing it ends the watching and works at once: nobody is kept from closing', async () => {
  const p = await surfaces['save bar'].open();
  const watcher = p.watcher();
  p.click('x');
  await flush();
  assert.equal(count(p, 'cs:dismissCaptured'), 1);
  assert.equal(watcher.gone, true);
});

test('passkey tag #401: closing the tag ends the watching', async () => {
  const p = await surfaces['passkey tag'].open();
  const watcher = p.watcher();
  p.browserSays(true);
  p.wait(500);
  p.click('link link-cancel');
  await flush();
  assert.equal(watcher.gone, true);
});

for (const [name, s] of Object.entries(surfaces)) {
  test(`${name} #383: account names are drawn by CSS, a script's window.find() finds none`, async () => {
    const p = await s.open();
    assert.equal(p.drawn('zebra-user'), true, 'drawn');
    for (const text of ['zebra-user', 'zebra-title', 'zebra-vault']) assert.equal(p.findable(text), false, text);
  });
}

test('save prompt #383: only a password the user typed is looked at, requestSubmit() on a script-set value tests no guesses', async () => {
  const p = page();
  p.submit({ typing: 'script' }); // the page sets the value and calls requestSubmit(): the browser's submit event is trusted
  p.submit({ typing: 'changed' }); // typed, then replaced by the page before the submit
  p.submit({ typing: 'script', isTrusted: false });
  await flush();
  assert.equal(count(p, 'cs:capture'), 0);
  p.submit({ typing: 'user' });
  await flush();
  assert.equal(count(p, 'cs:capture'), 1);
});

test('save prompt #383: a submit event the page fired itself is not looked at, even on a typed password', async () => {
  const p = page();
  p.submit({ typing: 'user', isTrusted: false });
  await flush();
  assert.equal(count(p, 'cs:capture'), 0);
});

test('save prompt #383: the account name and the site are drawn by CSS, window.find() of the page finds none', async () => {
  const p = page();
  p.showSave({ action: 'update', title: 'zebra-title', host: 'zebra-host.example', username: 'zebra-user', containers: [], ui: { saveTitle: 's', updateTitle: 'u', noUser: 'n', close: 'c' } });
  await flush();
  assert.equal(p.drawn('zebra-user'), true, 'drawn');
  for (const text of ['zebra-user', 'zebra-title', 'zebra-host']) assert.equal(p.findable(text), false, text);
});
