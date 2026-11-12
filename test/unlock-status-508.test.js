import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// #508: unlocking with the PIN in the extension shows what is going on, and a failed unlock says why. The busy view
// itself is checked in the extension smoke (scripts/extension-smoke-unlock.mjs, pinbar part).

const { unlockError } = await import('../extension/lib/api.js');
const read = (p) => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');

test('#508: no answer in time is a plain timeout message, the app’s own words stay', () => {
  assert.match(unlockError(Object.assign(new Error('Keevault-App antwortet nicht'), { name: 'TimeoutError' })), /^Zeitüberschreitung/);
  assert.equal(unlockError(new Error('Falsche PIN – bitte 30 Sekunden warten')), 'Falsche PIN – bitte 30 Sekunden warten');
  assert.equal(unlockError(new Error('')), 'Entsperren fehlgeschlagen');
});

test('#508: the app request times out with the name TimeoutError', () => {
  assert.match(read('lib/desktop.js'), /new Error\(t\('Keevault-App antwortet nicht'\)\), \{ name: 'TimeoutError' \}/);
});

test('#508: popup, window and bar show "Entsperre …" and lock the field while unlocking', () => {
  for (const file of ['popup/popup.js', 'prompt/prompt.js', 'pin/pin.js']) {
    const src = read(file);
    assert.match(src, /t\('Entsperre …'\)/, file);
    assert.match(src, /pin\.disabled = true/, file);
    assert.match(src, /unlockError\(/, file);
  }
  for (const file of ['popup/popup.js', 'prompt/prompt.js']) assert.match(read(file), /t\('Lade Tresore …'\)/, file);
});
