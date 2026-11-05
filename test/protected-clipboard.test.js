import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Every value Keevault copies lands in the protected clipboard (#337): kept out of Windows' clipboard history and the
// cloud clipboard, cleared after the configured time. Never a plain copy as a fallback.
const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

test('desktop app: one copy function, and no plain clipboard on Windows when the protected one fails', () => {
  const clip = read('desktop/main/clipboard.js');
  const win32 = clip.slice(clip.indexOf("if (process.platform === 'win32')"), clip.indexOf('} else {', clip.indexOf("if (process.platform === 'win32')")));
  assert.doesNotMatch(win32, /clipboard\.writeText/, 'no plain copy on Windows');
  assert.match(win32, /throw new Error\(t\('Kopieren nicht möglich/);
});

test('extension: copies go through the app, never the page clipboard', () => {
  const api = read('extension/lib/api.js');
  assert.doesNotMatch(api, /navigator\.clipboard/);
  assert.match(api, /await call\('copy', \{ text \}\)/);
  const bg = read('extension/background.js');
  // The one-time code after filling, and the popup: secureCopy → app.copy (the browser's clipboard only in the demo).
  assert.match(bg, /return await secureCopy\(code\);/);
  assert.match(bg, /copy: \(\{ text \}\) => secureCopy\(/);
  assert.match(bg, /if \(demo\) \{\s*await offscreen\(\{ cmd: 'copy', text \}\);[\s\S]*?\}\s*return app\.copy\(text\);/);
  assert.equal((bg.match(/offscreen\(\{ cmd: 'copy'/g) || []).length, 1, 'the offscreen copy only in secureCopy (demo)');
  const browser = read('desktop/main/browser.js');
  assert.match(browser, /copy: async \(\{ text \}\) => \{\s*requireOpen\(\);[\s\S]*?await copyToClipboard\(text\);/);
});
