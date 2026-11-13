import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PinGuard } from '../desktop/pin.js';

// Review 0.9.33: a PIN entered for admin mode or for taking an older file state, or just before locking, must not
// leave the 120-second unlock token behind; the export lock through the personal vault holds when the settings can't
// be read. The main-process modules need Electron, so their wiring is checked in the source (the smoke run covers it live).

const src = (file) => readFileSync(new URL(`../desktop/${file}`, import.meta.url), 'utf8');

test('a verified PIN opens once, consume empties it', () => {
  const g = new PinGuard();
  g.success();
  assert.equal(g.consume(), true);
  assert.equal(g.consume(), false);
});

test('admin mode consumes the token right after the PIN', () => {
  assert.match(src('main/api/app.js'), /async activateAdminMode\(pin\) \{[\s\S]*?await api\.verifyPin\(String\(pin \|\| ''\)\);\n\s*pinGuard\.consume\(\);/);
});

test('taking an older file state consumes the token right after the PIN', () => {
  const files = src('main/api/files.js');
  assert.match(files, /import \{[^}]*\bpinGuard\b[^}]*\} from '\.\.\/guards\.js';/);
  assert.match(files, /async acceptOlderUnlock\(token, pin\) \{[\s\S]*?await api\.verifyPin\(String\(pin \|\| ''\)\);\n\s*pinGuard\.consume\(\);/);
});

test('locking empties the token first, before any early return', () => {
  const session = src('main/session.js');
  assert.match(session, /import \{ pinGuard \} from '\.\/guards\.js';/);
  assert.match(session, /export async function lockNow\(\) \{\n\s*pinGuard\.consume\(\);/);
});

test('every verifyPin in the main process is followed by consume or is the unlock step itself', () => {
  // Places where the PIN only confirms a step: they must consume. verifyPin itself (api/app.js) sets the token for unlock.
  for (const [file, fn] of [['main/api/app.js', 'activateAdminMode'], ['main/api/app.js', 'setPin'], ['main/api/files.js', 'acceptOlderUnlock'], ['main/api/window-hello.js', 'setWindowHello']]) {
    const body = src(file).split(new RegExp(`async ${fn}\\(`))[1]?.split(/\n {2}(?:async )?\w+[(:]/)[0] || '';
    assert.match(body, /verifyPin[\s\S]*pinGuard\.consume\(\)/, `${file} ${fn}`);
  }
});

test('leaving to the personal vault refuses when the settings of the source vault can\'t be read', () => {
  const rules = src('main/vault-rules.js');
  const body = rules.split('export async function checkLeaveToPersonal')[1].split('\n}\n')[0];
  assert.doesNotMatch(body, /RulesOf\(fromId\)\.catch/);
  assert.match(body, /const rules = await strictRulesOf\(fromId\);/); // #525: the read itself throws when it fails
});
