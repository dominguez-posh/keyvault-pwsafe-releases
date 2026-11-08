import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmCardHtml, releaseDialogHtml } from '../desktop/release-dialog.js';

// #459: the confirmation card (replaces Windows message boxes) and the release dialog share one frameless card page.
const card = { title: 'Zugriff <b>erlauben</b>?', detail: 'chrome-extension://abc\n\nNur erlauben, wenn du sie nutzt.', go: 'Erlauben', cancel: 'Ablehnen' };

test('card page: escaped text, tokens, no external resources, light and dark', () => {
  const html = confirmCardHtml(card, { nonce: 'N0nce', delayMs: 1500 });
  assert.ok(!html.includes('<b>erlauben</b>'), 'title must be escaped');
  assert.ok(html.includes('&lt;b&gt;erlauben&lt;/b&gt;'));
  assert.match(html, /default-src 'none'/);
  assert.ok(!/https?:\/\//.test(html.replace(/chrome-extension:\/\/abc/g, '')), 'no external resource');
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /--accent:#0f6cbd/, 'brand blue of the product tokens');
  assert.match(html, /border-radius:16px/);
  assert.ok(html.includes('>Ablehnen</button>') && html.includes('"Erlauben"'));
});

test('card page: Enter confirms only after the wait and as a real key, Esc denies', () => {
  const html = confirmCardHtml(card, { nonce: 'x' });
  assert.match(html, /const enterConfirms = true/);
  assert.match(html, /e\.key === 'Enter'\) \{ if \(ready && e\.isTrusted && !e\.repeat && document\.activeElement !== no\)/);
  assert.match(html, /e\.key === 'Escape' && e\.isTrusted\) window\.releaseDialog\.decide\(false\)/);
});

test('release dialog keeps its protection: Enter confirms nothing and restarts the wait', () => {
  const html = releaseDialogHtml({ setup: true, existing: 0 }, { nonce: 'x' });
  assert.match(html, /const enterConfirms = false/);
  assert.match(html, /else start\(\);/);
  assert.match(html, /e\.isTrusted\) window\.releaseDialog\.decide\(true\)/);
});
