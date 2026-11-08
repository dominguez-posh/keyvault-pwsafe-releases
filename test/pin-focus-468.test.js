// #468: the window comes to the front and gets the keyboard; if the foreground is refused, the taskbar flashes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bringToFront } from '../desktop/main/focus.js';

function fakeWindow({ focused, minimized = false }) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isFocused: () => focused,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    moveTop: () => calls.push('moveTop'),
    focus: () => calls.push('focus'),
    flashFrame: (on) => calls.push(`flash:${on}`),
    webContents: { focus: () => calls.push('webContents.focus') },
  };
}

test('window to the front, then the keyboard to the page', () => {
  const w = fakeWindow({ focused: true, minimized: true });
  bringToFront(w, { later: (fn) => fn() });
  assert.deepEqual(w.calls, ['restore', 'show', 'moveTop', 'focus', 'webContents.focus']);
});

test('foreground refused by Windows: the taskbar flashes', () => {
  const w = fakeWindow({ focused: false });
  bringToFront(w, { later: (fn) => fn() });
  assert.deepEqual(w.calls.at(-1), 'flash:true');
});

test('a destroyed or missing window is ignored', () => {
  bringToFront(null);
  bringToFront({ isDestroyed: () => true });
});

test('every PIN field is focused through focusField, none via a bare setTimeout focus', () => {
  const dir = new URL('../desktop/renderer/app/', import.meta.url);
  for (const f of ['requests.js', 'start.js', 'admin-mode.js', 'personal.js']) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.match(src, /focusField\(/, f);
    assert.doesNotMatch(src, /setTimeout\(\(\) => \(?pin\.focus|win-pin-input'\)\?\.focus/, f);
  }
});
