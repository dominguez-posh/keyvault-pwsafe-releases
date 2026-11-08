// Mobile (#361): active filter and plus button use --on-accent; contrast measured from the token values in light and dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const mobile = readFileSync(`${root}mobile/www/mobile.css`, 'utf8');
const app = readFileSync(`${root}extension/styles/app.css`, 'utf8');
const lum = (h) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const tok = (block, name) => block.match(new RegExp(`--${name}: (#[0-9a-f]{6})`, 'i'))[1];

test('active filter and fab text use --on-accent, not fixed white', () => {
  for (const sel of ['.chips button.active', '.fab']) {
    const rule = mobile.split('\n').find((l) => l.startsWith(sel + ' '));
    assert.match(rule, /color: var\(--on-accent\)/, sel);
    assert.ok(!/#fff/i.test(rule), sel);
  }
});

test('contrast on --accent is at least 4.5:1 in light and dark; fixed white in dark fails (counter-check)', () => {
  const dark = app.slice(app.indexOf('prefers-color-scheme: dark'));
  const light = app.slice(0, app.indexOf('prefers-color-scheme: dark'));
  assert.ok(ratio(tok(light, 'on-accent'), tok(light, 'accent')) >= 4.5);
  assert.ok(ratio(tok(dark, 'on-accent'), tok(dark, 'accent')) >= 4.5);
  assert.ok(ratio('#ffffff', tok(dark, 'accent')) < 3);
});
