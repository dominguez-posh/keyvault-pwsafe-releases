import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// Runs the real content script against a small imitation of the page; `trusted` stands for what the browser reports in
// event.isTrusted. For the tests of what the page may do to the in-page UI (field menu, passkey tag, bars).
export const script = (name) => readFileSync(fileURLToPath(new URL(`../../extension/content/${name}`, import.meta.url)), 'utf8');
export const source = [script('styles.js'), script('visible-guard.js'), script('content.js')].join('\n');
export const flush = () => new Promise((r) => setImmediate(r));

function element(tag) {
  const e = {
    tagName: tag.toUpperCase(), children: [], style: {}, dataset: {}, isConnected: true, className: '', nodeType: 1, computed: {}, left: 0, top: 0, width: 100, height: 20,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    append(...kids) { e.children.push(...kids); },
    after(...kids) { e.next = kids; },
    replaceChildren(...kids) { e.children = kids; },
    remove() { e.isConnected = false; },
    setAttribute() {}, getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    on: {},
    addEventListener(type, fn) { e.on[type] = fn; },
    focus() { e.focused = true; },
    closest: () => null,
    attachShadow() { return (e.shadow = element('shadow')); },
    getBoundingClientRect: () => ({ left: e.left, top: e.top, right: e.left + e.width, bottom: e.top + e.height, width: e.width, height: e.height }),
  };
  return e;
}

// query: the page's own fields for a selector (#463), in place of the fixed sign-in input.
export function page({ host = 'shop.example', replies = {}, signIn = '', query = null } = {}) {
  const listeners = {};
  const created = [];
  class HTMLInputElement {
    type = 'text'; autocomplete = 'username'; name = 'user'; maxLength = -1; isConnected = true; form = null;
    // An accessor on the prototype like the browser's: the content script sets values through it (setValue).
    get value() { return this.v ?? ''; }
    set value(v) { this.v = v; }
    focus() {}
    dispatchEvent() {}
    classList = { contains: () => false };
    getAttribute() { return null; }
    closest() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 20, width: 100 }; }
  }
  const document = {
    readyState: 'complete', activeElement: null, documentElement: element('html'), body: element('body'),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    createElement: (tag) => { const e = element(tag); created.push(e); return e; },
    createTextNode: (text) => ({ text }),
    // The sign-in pages: the one input the bar waits for (Microsoft: account name, Bastion: password), really on screen.
    querySelector: (sel) => (query ? query(sel)[0] || null : signIn === 'ms' && sel === 'input[name=loginfmt]' ? signInput : null),
    querySelectorAll: (sel) => (query ? query(sel) : signIn === 'bastion' && sel === 'input' ? [signInput] : signIn === 'ms' && sel === 'input[name=loginfmt]' ? [signInput] : []),
  };
  const signInput = new HTMLInputElement();
  signInput.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 20, width: 100, height: 20 });
  if (signIn === 'bastion') signInput.type = 'password';
  const sent = [];
  const pageMessages = [];
  let fromBackground = null;
  const chrome = {
    runtime: {
      id: 'test', getURL: (x) => x, onMessage: { addListener: (fn) => { fromBackground = fn; } },
      sendMessage: async (msg) => {
        sent.push(msg.cmd);
        if (replies[msg.cmd]) return { ok: true, result: replies[msg.cmd] };
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
  // The browser's verdict on the menu (IntersectionObserver v2) and the clock are the test's to set.
  const clock = { start: Date.now(), offset: 0 }; // stands still between waits, or 499 ms plus a real millisecond passes the time
  const watchers = [];
  class IntersectionObserver {
    constructor(report, options) { this.report = report; this.options = options; watchers.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.gone = true; }
  }
  const frames = new Map(); // the browser's next frame, the test's to run
  let frameId = 0;
  const requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
  const cancelAnimationFrame = (id) => { frames.delete(id); };
  vm.runInNewContext(source, {
    window: win, document, chrome, HTMLInputElement, globalThis: {}, console, setTimeout: signIn === 'bastion' ? () => 0 : setTimeout, clearTimeout, setInterval, clearInterval, Event: class {}, requestAnimationFrame, cancelAnimationFrame,
    Date: class extends Date { static now() { return clock.start + clock.offset; } }, IntersectionObserver, getComputedStyle: (e) => ({ visibility: 'visible', ...e.computed }),
    location: { hostname: host, pathname: '/', href: `https://${host}/` }, sessionStorage: { getItem: () => null, setItem() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const fire = (type, init) => { for (const fn of listeners[type] || []) fn(init); };
  const field = new HTMLInputElement();
  const other = new HTMLInputElement();
  const button = element('button');
  return {
    field, other, button, sent, document, Input: HTMLInputElement,
    // The background asks the page to show the save prompt (save:show).
    showSave: (info) => fromBackground({ type: 'save:show', info }, { id: 'test' }),
    // Any other message of the service worker; returns what the content script answered right away.
    fromWorker(msg) { let answer; fromBackground(msg, { id: 'test' }, (r) => { answer = r; }); return answer; },
    created,
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
    focused: () => created.filter((e) => e.focused).map((e) => e.className),
    watcher: () => watchers.at(-1),
    menu: () => created.filter((e) => e.className === 'menu').at(-1),
    scroll() { for (const fn of listeners['window:scroll'] || []) fn({}); },
    browserSays(isVisible, intersectionRatio = 1) { watchers.at(-1).report([{ isVisible, intersectionRatio }]); },
    frame() { const due = [...frames.values()]; frames.clear(); for (const fn of due) fn(); },
    framesWaiting: () => frames.size,
    wait(ms) { clock.offset += ms; },
    click(className, { isTrusted = true } = {}) { created.filter((e) => e.className === className).at(-1).on.click({ isTrusted }); },
    // A submit of a form with a password (#383). typing: how the password got into the field. 'user' = real input events (the
    // browser's own, isTrusted), 'script' = the page set the value (and may fire its own input event), 'changed' = the user
    // typed, then the page replaced the value. isTrusted of the submit event is true in all cases: the browser fires it, also for requestSubmit().
    submit({ isTrusted = true, typing = 'user' } = {}) {
      const pw = new HTMLInputElement();
      pw.type = 'password'; pw.autocomplete = '';
      pw.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 20, width: 100, height: 20 });
      if (typing === 'user' || typing === 'changed') { pw.value = 'typed'; fire('input', { target: pw, isTrusted: true }); }
      if (typing === 'script') { pw.value = 'guess'; fire('input', { target: pw, isTrusted: false }); }
      if (typing === 'changed') pw.value = 'guess';
      const form = { querySelectorAll: (sel) => (sel === 'input' || sel === 'input[type=password]' ? [pw] : []) };
      fire('submit', { target: { form }, isTrusted });
    },
    // Text a script can find with window.find(): in the shadow tree as text. Generated content (data-t) is not.
    findable: (text) => created.some((e) => typeof e.textContent === 'string' && e.textContent.includes(text)),
    drawn: (text) => created.some((e) => String(e.dataset.t || '').includes(text)),
    has: (className) => created.some((e) => e.className === className),
    clickEntry({ isTrusted = true } = {}) { created.filter((e) => e.className === 'entry').at(-1).on.click({ isTrusted }); },
  };
}
