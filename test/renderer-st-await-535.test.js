// #535: `st.settings = await call(…)` evaluates `st` before the wait. A reload that replaces st during the wait (setSt
// in reloadAll) makes the answer land on the old object: the window showed admin mode off while it was on, and the
// smoke run's switch then found no "off". In the window the answer is taken first and assigned afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'desktop', 'renderer');

function files(d) {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
  });
}

test('the window never assigns an awaited answer to a field of st (#535)', () => {
  const found = [];
  for (const f of files(dir)) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/\bst(\.\w+)+\s*=\s*(\S.*\?\s*)?await\b/.test(code)) found.push(`${relative(root, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});

test('admin mode takes the answer before it assigns it (#535)', () => {
  const src = readFileSync(join(dir, 'app', 'admin-mode.js'), 'utf8');
  assert.match(src, /const settings = on \? await call\('activateAdminMode', pin\) : await call\('deactivateAdminMode'\);\s*st\.settings = settings;/);
});
