import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// IntersectionObserver v2 calls an element not visible while it has a filter (#373, #401). The guard watches the passkey tag's
// button, so a hover effect with a filter would refuse every click that comes within the first moments of the pointer
// being over it – the extension smoke found it as a click that never counted.

const css = readFileSync(new URL('../extension/content/styles.js', import.meta.url), 'utf8');

test('the guarded buttons of the in-page UI have no filter on hover or focus', () => {
  const rules = [...css.matchAll(/([^{}\n]*:(?:hover|focus|active|focus-visible)[^{}]*)\{([^}]*)\}/g)];
  const bad = rules.filter(([, selector, body]) => /\.(primary|entry|b|opt)\b/.test(selector) && /(^|[;\s])(filter|backdrop-filter)\s*:/.test(body)).map(([, selector]) => selector.trim());
  assert.deepEqual(bad, []);
});
