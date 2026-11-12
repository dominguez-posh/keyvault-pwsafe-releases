// #534: the popup draws the PIN view from the last known state, before the app has answered. The PIN goes to the app only
// after the fresh state confirmed the connection (hello, #511). The view itself is measured in the extension smoke
// (scripts/extension-smoke-pinfast.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = {};
globalThis.chrome = { storage: { session: {
  get: async (k) => ({ [k]: store[k] }),
  set: async (o) => Object.assign(store, o),
} } };
const { rememberState, lockedWithPin } = await import('../extension/popup/locked.js');
const { setLanguage } = await import('../extension/core/i18n.js');
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const flush = () => new Promise((r) => setTimeout(r, 0));

test('#534: only "app running, locked, PIN set" lets the next popup draw the PIN view ahead', async () => {
  setLanguage('en');
  const base = { demo: false, open: false, desktop: { connected: true, pinSet: true }, settings: { language: 'en', secret: 'x' } };
  rememberState(base);
  await flush();
  const last = await lockedWithPin();
  assert.equal(last.texts.title, 'Vault locked');
  assert.equal(last.texts.lang, 'en');
  delete last.texts;
  assert.deepEqual(last, { demo: false, connected: true, open: false, pinSet: true, language: 'en' });
  for (const other of [{ open: true }, { demo: true }, { desktop: { connected: false } }, { desktop: { connected: true, pinSet: false } }]) {
    rememberState({ ...base, ...other });
    await flush();
    assert.equal(await lockedWithPin(), null, JSON.stringify(other));
  }
  delete store.popupLast;
  assert.equal(await lockedWithPin(), null);
});

test('#534: a PIN typed ahead is held until confirm, and the app answer decides the view', () => {
  const src = read('extension/popup/locked.js');
  // The only place the PIN leaves the popup is send(); the button holds it while the view is not confirmed.
  assert.equal(src.match(/call\('unlockPin'/g).length, 1);
  assert.match(src, /if \(mine && !mine\.confirmed\) return mine\.held \? undefined : hold\(\);\n\s+return send\(\);/);
  assert.match(src, /const hold = \(\) => \{\n\s+mine\.held = true;\n\s+pin\.readOnly = true;/);
  // A PIN already sent in the view of early.js is held, not dropped.
  assert.match(src, /if \(early\?\.dataset\.held\) hold\(\);/);
  assert.match(src, /if \(!mine\.pin\.isConnected \|\| st\.open \|\| st\.demo \|\| !st\.desktop\?\.connected \|\| !st\.desktop\.pinSet\) \{\n\s+dropDraft\(\); \/\/ a held PIN is discarded, unsent\n\s+return false;/);
  // Konrad: discarded or sent, the digits do not stay in the field or in draft.
  assert.match(src, /function dropDraft\(\) \{\n\s+if \(draft\?\.pin\) draft\.pin\.value = '';\n\s+draft = null;/);
  assert.match(src, /if \(mine\.held\) \{\n\s+draft = null;\n\s+mine\.send\(\);/);
  assert.match(src, /const value = pin\.value;\n\s+pin\.value = '';[^\n]*\n\s+await call\('unlockPin', \{ pin: value \}\);/);
  assert.match(src, /window\.kvEarlyRelease\?\.\(\);/);
  const popup = read('extension/popup/popup.js');
  // Confirmed only with the fresh state (reload), never with the cached one; the PIN view is drawn before the settings wait.
  assert.match(popup, /rememberState\(st\);[^\n]*\n[\s\S]*?if \(confirm\(st\)\) return undefined;/);
  const start = popup.slice(popup.lastIndexOf('(async () => {'));
  assert.ok(start.indexOf('renderLocked(null, { pending: true })') < start.indexOf('await rest'), 'PIN view waits for settings');
});

test('#534: early.js draws only from "app running, locked, PIN set", sends nothing and uses the lock symbols of dom.js', () => {
  const early = read('extension/popup/early.js');
  assert.match(early, /if \(l && !l\.demo && l\.connected && !l\.open && l\.pinSet && l\.texts\) draw\(l\.texts\);/);
  assert.doesNotMatch(early, /sendMessage|connectNative|innerHTML|import /);
  // Konrad: after the takeover early.js holds no reference to the field (listeners off, variables cleared).
  assert.match(early, /window\.kvEarlyRelease = \(\) => \{\n\s+listeners\.abort\(\);\n\s+pin = null;\n\s+button = null;/);
  assert.equal(early.match(/\{ signal: listeners\.signal \}/g).length, 2);
  const dom = read('extension/core/dom.js');
  const svg = (shapes) => shapes.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')}/>`).join('');
  const body = ['rect', { x: 3, y: 11, width: 18, height: 11, rx: 2 }];
  for (const name of ['lock', 'unlock']) {
    const d = early.match(new RegExp(`const ${name.toUpperCase()} = \\[BODY, \\['path', \\{ d: '([^']+)' \\}\\]\\];`))[1];
    assert.match(early, /const BODY = \['rect', \{ x: 3, y: 11, width: 18, height: 11, rx: 2 \}\];/);
    assert.ok(dom.includes(`  ${name}: '${svg([body, ['path', { d }]])}',`), name);
  }
  const html = read('extension/popup/popup.html');
  assert.ok(html.indexOf('<script src="early.js"></script>') < html.indexOf('src="popup.js"'), 'early.js not before popup.js');
});
