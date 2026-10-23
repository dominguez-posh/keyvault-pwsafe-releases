import { test } from 'node:test';
import assert from 'node:assert/strict';
import EN from '../extension/core/i18n-en.js';
import { t, setLanguage, resolveLanguage } from '../extension/core/i18n.js';
import { collectKeys } from '../scripts/i18n-keys.mjs';

// Strings picked up by the key scanner that are not UI texts.
const NOT_TEXT = new Set(['decrypt', 'shift', 'control', 'removed', 'active', 'pending', 'get', 'none', 'typ', 'verify', 'Deutscher Text', 'Deutsch', 'English', 'public-key', 'rk', 'up', 'uv', 'Example', 'example.com', 'win@example.com']);

test('every German UI text has an English translation with the same placeholders', () => {
  const keys = collectKeys().map((k) => k.replace(/\\n/g, '\n')).filter((k) => !NOT_TEXT.has(k));
  const missing = keys.filter((k) => !(k in EN));
  assert.deepEqual(missing, [], `missing translations:\n${missing.join('\n')}`);
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [de, en] of Object.entries(EN)) assert.equal(placeholders(en), placeholders(de), `placeholders differ: ${de}`);
});

test('language switch and interpolation', () => {
  assert.equal(resolveLanguage('auto', 'de-AT'), 'de');
  assert.equal(resolveLanguage('auto', 'fr-FR'), 'en');
  setLanguage('en');
  assert.equal(t('{count} Einträge', { count: 3 }), '3 items');
  assert.equal(t('Unbekannter Text'), 'Unbekannter Text');
  setLanguage('de');
  assert.equal(t('{count} Einträge', { count: 3 }), '3 Einträge');
});
