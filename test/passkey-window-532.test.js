// #532: the passkey window is never visible without content. The module needs Electron, so this checks its source: the
// window is shown only where the page fetched its request, a show without a ready ceremony is undone, and closing it
// without a ceremony hides it. The smoke check (desktop/smoke-passkey-window.js) drives the real window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.resolve(import.meta.dirname, '..', 'desktop', 'main', 'passkey-window.js'), 'utf8');
const block = (start) => {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `${start} not found`);
  const end = src.indexOf('\n}', i);
  return src.slice(i, end);
};

test('the ceremony does not show the window before its page asked for the request', () => {
  assert.doesNotMatch(block('export function passkeyCeremony('), /\.show\(\)/);
  const request = src.slice(src.indexOf("ipcMain.handle('passkey:request'"), src.indexOf("ipcMain.handle('passkey:done'"));
  assert.match(request, /ceremony\.ready = true/);
  assert.match(request, /passkeyWindow\.show\(\)/);
  assert.ok(request.indexOf('ceremony?.id !== id') < request.indexOf('passkeyWindow.show()'), 'shown only for the current ceremony');
});

test('a show without a ready ceremony is undone and closing without a ceremony hides the window', () => {
  const ensure = block('function ensurePasskeyWindow(');
  assert.match(ensure, /on\('show', \(\) => \{\s*if \(ceremony\?\.ready\) return;[\s\S]*?passkeyWindow\.hide\(\)/);
  assert.match(ensure, /if \(ceremony\) finishCeremony\(\{ ok: false \}\);\s*else passkeyWindow\.hide\(\);/);
  assert.match(ensure, /did-fail-load/);
});
