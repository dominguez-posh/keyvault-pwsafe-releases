import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #506: the accent colour of a popup state's big symbol must not reach the icon inside the accent button – there it was
// invisible and its space pushed "Keevault starten" / "Entsperren" right of centre. The layout itself is measured in the
// extension smoke (scripts/extension-smoke-center.mjs).

const css = readFileSync(new URL('../extension/popup/popup.css', import.meta.url), 'utf8');

test('#506: only the direct symbol of .center is coloured, not icons in its buttons', () => {
  assert.match(css, /\.center > \.icon \{ color: var\(--accent\); \}/);
  assert.doesNotMatch(css, /\.center \.icon\b/);
});
