import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// The field menu names entries, so only real input at the field opens it (#380). Runs the real content script against
// a small imitation of the page; `trusted` stands for what the browser reports in event.isTrusted.
const source = readFileSync(fileURLToPath(new URL('../extension/content/content.js', import.meta.url)), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));

function element(tag) {
  const e = {
    tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, isConnected: true, className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append(...kids) { e.children.push(...kids); },
    replaceChildren(...kids) { e.children = kids; },
    remove() { e.isConnected = false; },
    setAttribute() {}, getAttribute: () => null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    closest: () => null,
    attachShadow() { return (e.shadow = element('shadow')); },
    getBoundingClientRect: () => ({ left: 0, top: 0, bottom: 20, width: 100 }),
  };
  return e;
}

function page() {
  const listeners = {};
  const created = [];
  class HTMLInputElement {
    type = 'text'; autocomplete = 'username'; name = 'user'; maxLength = -1; isConnected = true; value = ''; form = null;
    getAttribute() { return null; }
    closest() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 20, width: 100 }; }
  }
  const document = {
    readyState: 'complete', activeElement: null, documentElement: element('html'), body: element('body'),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    createElement: (tag) => { const e = element(tag); created.push(e); return e; },
    createTextNode: (text) => ({ text }),
    querySelector: () => null, querySelectorAll: () => [],
  };
  const sent = [];
  const pageMessages = [];
  const chrome = {
    runtime: {
      id: 'test', getURL: (x) => x, onMessage: { addListener() {} },
      sendMessage: async (msg) => {
        sent.push(msg.cmd);
        if (msg.cmd === 'cs:matches') return { ok: true, result: { enabled: true, items: [{ id: '1', title: 'Fake', username: 'fake' }], ui: {} } };
        if (msg.cmd === 'cs:webauthn') return { ok: true, result: { conditional: { requestId: 'r', candidates: [{ title: 'Fake', userName: 'fake' }], ui: {} } } };
        return { ok: true, result: null };
      },
    },
  };
  const win = {
    addEventListener: (type, fn) => { (listeners[`window:${type}`] ||= []).push(fn); },
    dispatchEvent() {}, postMessage: (m) => pageMessages.push(m), innerWidth: 1000, innerHeight: 800,
  };
  win.top = win;
  vm.runInNewContext(source, {
    window: win, document, chrome, HTMLInputElement, globalThis: {}, console, setTimeout, clearTimeout, Date, Event: class {},
    location: { hostname: 'shop.example', pathname: '/', href: 'https://shop.example/' }, sessionStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const fire = (type, init) => { for (const fn of listeners[type] || []) fn(init); };
  const field = new HTMLInputElement();
  const other = new HTMLInputElement();
  const button = element('button');
  return {
    field, other, button, sent, document,
    // What the browser does for each way of reaching the field.
    scriptFocus(target = field) { document.activeElement = target; fire('focusin', { target, isTrusted: true }); },
    syntheticFocusin(target = field) { document.activeElement = target; fire('focusin', { target, isTrusted: false }); },
    press(target, { isTrusted = true } = {}) {
      fire('pointerdown', { target, isTrusted });
      if (target instanceof HTMLInputElement && isTrusted) this.scriptFocus(target);
      fire('click', { target, isTrusted });
    },
    key(key, target = document.activeElement || document.body, { isTrusted = true } = {}) { fire('keydown', { key, target, isTrusted }); },
    tabTo(target) { this.key('Tab'); this.scriptFocus(target); },
    blur() { const target = document.activeElement; document.activeElement = document.body; fire('focusout', { target }); },
    passkeyRequest() {
      for (const fn of listeners['window:message'] || []) fn({ source: win, data: { channel: 'kvpwsafe-webauthn-v1', dir: 'toExt', id: 'p', kind: 'get', payload: { conditional: true } } });
    },
    opened: () => created.some((e) => e.className === 'menu'),
    openings: () => created.filter((e) => e.className === 'menu').length,
  };
}

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
