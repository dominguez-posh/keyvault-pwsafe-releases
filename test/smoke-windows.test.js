// #377: a smoke run keeps every window off the desktop and fails if one gets there anyway. The app itself stays untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keepWindowsHidden, screenshotProblem, windowViolations } from '../desktop/main/smoke-windows.js';

function fakeElectron() {
  const real = [];
  const all = [];
  class BrowserWindow {
    constructor() { this.nativeVisible = false; this.webContents = { focus: () => real.push('webContents.focus') }; all.push(this); }
    show() { real.push('show'); this.nativeVisible = true; }
    showInactive() { real.push('showInactive'); this.nativeVisible = true; }
    restore() { real.push('restore'); }
    hide() { real.push('hide'); this.nativeVisible = false; }
    minimize() { real.push('minimize'); }
    focus() { real.push('focus'); }
    moveTop() { real.push('moveTop'); }
    flashFrame() { real.push('flashFrame'); }
    setAlwaysOnTop() { real.push('setAlwaysOnTop'); }
    isVisible() { return this.nativeVisible; }
    isMinimized() { return false; }
    isAlwaysOnTop() { return false; }
    isDestroyed() { return false; }
    destroy() {}
    getTitle() { return 'Keevault'; }
    static getAllWindows() { return all; }
  }
  return { BrowserWindow, real };
}

test('the module needs no Electron: importing it cannot change the app\'s windows', () => {
  const source = readFileSync(new URL('../desktop/main/smoke-windows.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /require\(/);
});

test('in a smoke run the app\'s requests are recorded and no window really appears', () => {
  windowViolations.length = 0;
  const { BrowserWindow, real } = fakeElectron();
  const { scan } = keepWindowsHidden({ BrowserWindow, env: {}, every: 1e6 });
  const w = new BrowserWindow();
  w.show();
  w.showInactive();
  w.restore();
  w.setAlwaysOnTop(true);
  w.moveTop();
  w.flashFrame(true);
  w.focus();
  assert.deepEqual(real, ['webContents.focus'], 'only the page gets focus');
  assert.equal(w.nativeVisible, false);
  // "Comes to the front" stays checkable.
  assert.equal(w.isVisible(), true);
  assert.equal(w.isAlwaysOnTop(), true);
  w.setAlwaysOnTop(false);
  w.hide();
  assert.equal(w.isVisible(), false);
  assert.equal(w.isAlwaysOnTop(), false);
  scan();
  assert.deepEqual(windowViolations, []);
});

test('the watcher reports a really visible window once, even when the recorder says hidden', () => {
  windowViolations.length = 0;
  const { BrowserWindow } = fakeElectron();
  const { scan } = keepWindowsHidden({ BrowserWindow, env: {}, every: 1e6 });
  const w = new BrowserWindow();
  w.nativeVisible = true;
  assert.equal(w.isVisible(), false);
  scan();
  scan();
  assert.deepEqual(windowViolations, ['window visible on the desktop: "Keevault"']);
  windowViolations.length = 0;
});

test('counter-test "front": show and always-on-top do nothing, so a front check has to fail', () => {
  const { BrowserWindow } = fakeElectron();
  keepWindowsHidden({ BrowserWindow, env: { KVPWSAFE_SMOKE_COUNTERTEST: 'front' }, every: 1e6 });
  const w = new BrowserWindow();
  w.show();
  w.setAlwaysOnTop(true);
  assert.equal(w.isVisible(), false);
  assert.equal(w.isAlwaysOnTop(), false);
});

test('debug log names the request', () => {
  const { BrowserWindow } = fakeElectron();
  const lines = [];
  keepWindowsHidden({ BrowserWindow, env: { KVPWSAFE_SMOKE_DEBUG: '1' }, log: (l) => lines.push(l), every: 1e6 });
  new BrowserWindow().show();
  assert.match(lines[0], /^\[smoke-window\] show .*smoke-windows\.test\.js/);
});

test('boot.js turns it on only for an unpackaged smoke run', () => {
  const boot = readFileSync(new URL('../desktop/main/boot.js', import.meta.url), 'utf8');
  const calls = boot.split(/\r?\n/).filter((line) => line.includes('keepWindowsHidden('));
  assert.deepEqual(calls, ['if (smokeTest && !app.isPackaged) keepWindowsHidden({ BrowserWindow, app });']);
});

test('a screenshot that is empty or blank is a problem', () => {
  const image = (bytes) => ({ isEmpty: () => bytes.length === 0, toBitmap: () => Buffer.from(bytes) });
  assert.equal(screenshotProblem(image([])), 'screenshot: empty image');
  assert.match(screenshotProblem(image([1, 2, 3, 255, 1, 2, 3, 255])), /blank/);
  assert.equal(screenshotProblem(image([1, 2, 3, 255, 1, 2, 4, 255])), null);
});
