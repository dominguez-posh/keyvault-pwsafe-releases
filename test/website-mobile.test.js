// Website on a phone (#357): the CSS rules that keep the pages inside the screen width. The width itself was measured with a mobile
// emulation of Edge (390 px: scrollWidth equal to the viewport on demo, download, index, faq in German and English).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(`${root}website/assets/style.css`, 'utf8');

test('grid children of .split may shrink, so a code block scrolls inside itself (download page)', () => {
  assert.match(css, /\.split > \* \{ min-width: 0; \}/);
  assert.match(css, /@media \(max-width: 860px\) \{ \.split \{ grid-template-columns: minmax\(0, 1fr\); \} \}/);
});

test('demo frame on a phone: no fixed ratio with a minimum height, a hint is shown', () => {
  const m = css.match(/@media \(max-width: 700px\) \{\s*\.demo-frame \{([^}]*)\}\s*\.demo-mobile-note \{([^}]*)\}/);
  assert.ok(m, 'phone rule for the demo frame');
  assert.match(m[1], /aspect-ratio: auto/);
  assert.match(m[1], /min-height: 0/);
  assert.match(m[2], /display: block/);
  assert.match(css, /\.demo-mobile-note \{ display: none; \}/);
  for (const page of ['demo.html', 'en/demo.html']) {
    assert.ok(readFileSync(`${root}website/pages/${page}`, 'utf8').includes('demo-mobile-note'), page);
  }
});

test('the demo page has an icon of its own, so /favicon.ico is not asked for', () => {
  assert.ok(readFileSync(`${root}scripts/build-website.mjs`, 'utf8').includes('<link rel="icon" href="../assets/icon.png">'));
});
