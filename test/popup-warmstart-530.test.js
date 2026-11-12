// #530: the popup's way to its list carries only what the list needs. The entry views, the move dialogs and the QR
// decoder load on first use (popup/lazy.js), and the last list is asked for beside the settings and the tab.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('popup: no jsQR and no entry views before the list', () => {
  assert.doesNotMatch(read('extension/popup/popup.html'), /jsqr\.js/);
  const imports = read('extension/popup/popup.js').split('\n').filter((l) => l.startsWith('import '));
  for (const heavy of ['ui-item.js', 'item-move.js', 'generator.js']) {
    assert.ok(!imports.some((l) => l.includes(heavy)), `${heavy} statically imported by popup.js`);
  }
  const lazy = read('extension/popup/lazy.js');
  assert.match(lazy, /import\('\.\.\/core\/ui-item\.js'\)/);
  assert.match(lazy, /import\('\.\/item-move\.js'\)/);
  assert.match(lazy, /s\.src = '\.\.\/lib\/jsqr\.js'/);
});

test('popup: the last list is asked for before the settings and the tab are back', () => {
  const src = read('extension/popup/popup.js');
  const start = src.slice(src.lastIndexOf('(async () => {'));
  assert.ok(start.indexOf("call('peek')") >= 0 && start.indexOf("call('peek')") < start.indexOf('Promise.all([getSettings()'), 'peek not started first');
  assert.match(start, /await load\(\{ peek, pending: !!last \}\)/);
});

test('popup (#533): the fresh list after the cached one keeps an opened entry', () => {
  const src = read('extension/popup/popup.js');
  assert.match(src, /function setView\(\.\.\.children\) \{\n {2}onList = false;/);
  assert.match(src, /status,\n {2}\);\n {2}onList = true;/);
  assert.match(src, /if \(keepView && !onList\) return undefined;\n {2}return renderList\(\);/);
  assert.match(src, /await reload\(\{ step: cached \? null : loading\.step, keepView: !!cached \}\)/);
});
