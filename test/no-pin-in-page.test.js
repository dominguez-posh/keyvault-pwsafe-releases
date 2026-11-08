import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The app PIN is never typed into a page: the content script lives in the page's event path (keydown is composed, the
// page reads keystrokes), and a field in the page can take the focus, so a stray Enter counts as a wrong PIN.
// A locked app with a PIN asks in the extension's own window (prompt.js) or in the app.

const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');

test('content script: no PIN field, no unlock command to the background', () => {
  const content = read('content/content.js') + read('content/styles.js'); // the tag's styles live in styles.js
  assert.ok(!/inputMode|showPinPill|webauthnUnlock|input\.pin|inputmode/i.test(content), 'no field the user could type a PIN into');
  assert.ok(!/kind === 'unlock' \? 'get'/.test(content));
});

test('background: a locked app with a PIN opens the prompt window, the page never asks for the PIN (#465: only the extension frame in the tag)', () => {
  const bg = read('background.js');
  assert.ok(!/webauthnUnlock|inlineUnlock|kind: 'unlock'/.test(bg));
  const req = bg.slice(bg.indexOf('async function webauthnRequest'), bg.indexOf('async function inlineFor'));
  assert.ok(!/pinSet/.test(req), 'the PIN state does not change the path');
  assert.match(req, /await openPrompt\(`\$\{kind\}:\$\{request\.id\}`, sender\.tab, request\)/);
  // The prompt window itself (an extension page, not the web page) still has the PIN field.
  assert.match(read('prompt/prompt.js'), /placeholder: t\('PIN'\)/);
});
