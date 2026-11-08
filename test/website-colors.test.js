// Website blue matches the product blue (#363, E1 in docs/DESIGN.md): tokens in light and dark (media block and data-theme), contrast WCAG AA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(`${root}website/assets/style.css`, 'utf8');

const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const tok = (block, name) => block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))[1].toLowerCase();

const light = css.slice(0, css.indexOf('@media (prefers-color-scheme: dark)'));
const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf(':root[data-theme="dark"]'));
const dark = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf('* { box-sizing'));

test('accent tokens carry the product values, dark in both places', () => {
  assert.deepEqual(['accent', 'accent-2', 'accent-soft'].map((n) => tok(light, n)), ['#0f6cbd', '#115ea3', '#e6f0fa']);
  for (const block of [media, dark]) {
    assert.deepEqual(['accent', 'accent-2', 'accent-soft'].map((n) => tok(block, n)), ['#479ef5', '#62abf5', '#1f3247']);
  }
});

test('old blues are gone from the stylesheet', () => {
  assert.doesNotMatch(css, /#(2f5bea|1c3fb8|e6ecff|7c9bff|a3b9ff|1d2a4d)/i);
});

test('contrast of accent text and button text is at least 4.5:1 (light and dark)', () => {
  for (const [block, bg, onAccent] of [[light, 'surface', '#ffffff'], [dark, 'surface', '#0d1119']]) {
    const accent = tok(block, 'accent');
    const soft = tok(block, 'accent-soft');
    const accent2 = tok(block, 'accent-2');
    const surf = tok(block, bg);
    const pageBg = tok(block, 'bg');
    for (const [fg, back] of [[accent, surf], [accent, pageBg], [accent, soft], [accent2, surf], [accent2, soft], [onAccent, accent], [onAccent, accent2]]) {
      assert.ok(ratio(fg, back) >= 4.5, `${fg} on ${back}: ${ratio(fg, back).toFixed(2)}`);
    }
  }
});
