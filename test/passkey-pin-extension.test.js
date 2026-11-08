import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #439: in the extension every passkey use asks for the app PIN – in the extension's own window, checked by the app.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const bg = read('extension/background.js');
const part = (from, to) => bg.slice(bg.indexOf(from), bg.indexOf(to));

test('extension: with the PIN on, a sign-in asks in the extension (its frame in the tag, #465, or the window), never the page or the field menu', () => {
  const req = part('async function webauthnRequest', 'async function inlineFor');
  const routed = req.indexOf('passkeyPinState()).required');
  assert.ok(routed > 0, 'the request checks whether the PIN is needed');
  assert.ok(routed < req.indexOf('inline: {'), 'before any in-page offer');
  assert.ok(routed < req.indexOf('conditional: {'), 'before the field menu');
  assert.match(req.slice(routed, routed + 600), /await openPrompt\(`\$\{kind\}:\$\{request\.id\}`, sender\.tab, request\)/);
  assert.match(req.slice(routed, routed + 400), /request\.conditional\) return \{ fallback: true \}/, 'no passkey menu in the page that cannot ask');
});

test('extension: the page surfaces cannot sign with the PIN on, the window passes the PIN to the app, which signs', () => {
  assert.match(part('async function conditionalSelect', 'async function inlineCreate'), /passkeyPinState\(\)\)\.required\) throw/);
  const sign = part('async function sign(', 'async function findCandidate');
  assert.match(sign, /if \(!demo\) \{\s*const \{ response \} = await app\.passkeySign\(\{[^}]*pin,/);
  assert.match(part('async function webauthnApprove', 'async function editInPopup'), /sign\(req, await findCandidate\([^)]*\), typeof pin === 'string' \? pin : ''\)/);
});

test('extension: no local signing outside the demo, no PIN or its hash kept in the extension', () => {
  const s = bg.slice(bg.indexOf('async function sign('), bg.indexOf('async function findCandidate'));
  assert.ok(s.indexOf('app.passkeySign') < s.indexOf('getAssertion('), 'the app path comes first and returns');
  for (const file of ['extension/background.js', 'extension/lib/desktop.js', 'extension/prompt/prompt.js', 'extension/lib/settings.js']) {
    assert.ok(!/storage\.(local|sync)\.set\([^)]*pin/i.test(read(file)), `${file} stores no PIN`);
  }
});

test('extension prompt: the PIN field is in the window, wrong answers keep the request open', () => {
  const prompt = read('extension/prompt/prompt.js');
  assert.match(prompt, /type: 'password'[^}]*class: 'pin'/);
  assert.match(prompt, /pin: typed/);
  assert.match(prompt, /disabled: noPin/, 'without a set PIN no passkey can be chosen');
});
