// #466: no answer of the browser bridge carries a private passkey key. browser.js needs Electron, so the handlers are
// checked on their source: every handler that reads or writes a vault item returns it only through withoutPasskeyKeys
// (or returns no item at all); the smoke check passkeyPinBrowserCheck runs the real save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withoutPasskeyKeys } from '../desktop/passkey-keys.js';

const source = readFileSync(new URL('../desktop/main/browser.js', import.meta.url), 'utf8');

function browserHandlerBodies() {
  const start = source.indexOf('export const browserHandlers = {');
  const end = source.indexOf('\n};', start);
  assert.ok(start >= 0 && end > start, 'browserHandlers not found');
  const block = source.slice(start, end);
  const parts = block.split(/\n {2}(?=[A-Za-z]+: )/).slice(1);
  return parts.map((p) => ({ name: p.match(/^([A-Za-z]+):/)[1], body: p }));
}

test('#466: every bridge handler touching a vault item returns it without private keys', () => {
  const handlers = browserHandlerBodies();
  assert.ok(handlers.some((h) => h.name === 'save'), 'save handler not found');
  const touching = handlers.filter((h) => /vault\.(getItem|saveItem|passkeyCandidates)\(/.test(h.body));
  assert.ok(touching.length >= 3);
  for (const { name, body } of touching) {
    const returns = [...body.matchAll(/\breturn ([^;]+);/g)].map((m) => m[1].trim());
    // One-expression handler (passkeyCandidates): the key is blanked in the expression itself.
    if (/^[A-Za-z]+: async \([^)]*\) => \(/.test(body)) {
      assert.match(body, /privateKey: ''/, `${name}: the answer keeps the private key`);
      continue;
    }
    assert.ok(returns.length, `${name}: no return found`);
    for (const r of returns) {
      assert.ok(r === 'true' || r === '{ response }' || r.startsWith('withoutPasskeyKeys('), `${name} returns "${r}" unfiltered`);
    }
  }
});

test('#466: a saved item with stored keys goes to the browser without them', () => {
  const saved = { id: 'e1', title: 'x', passkeys: [{ credentialId: 'c1', privateKey: 'SECRET-PKCS8' }, { credentialId: 'c2', privateKey: 'SECRET-2' }] };
  const out = withoutPasskeyKeys(saved);
  assert.equal(JSON.stringify(out).includes('SECRET'), false);
  assert.equal(out.passkeys.length, 2);
  assert.equal(saved.passkeys[0].privateKey, 'SECRET-PKCS8', 'the stored item stays unchanged');
});
