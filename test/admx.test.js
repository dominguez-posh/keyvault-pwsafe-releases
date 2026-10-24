import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The ADMX template and its translations must fit together, otherwise the Group Policy editor and Intune reject it.
const read = (p) => readFileSync(new URL(`../installer/policy/${p}`, import.meta.url), 'utf8');
const admx = read('Keevault.admx');
const ids = (text, re) => new Set([...text.matchAll(re)].map((m) => m[1]));

test('ADMX: every string and presentation exists in de-DE and en-US', () => {
  const strings = ids(admx, /\$\(string\.(\w+)\)/g);
  const presentations = ids(admx, /\$\(presentation\.(\w+)\)/g);
  const elementIds = ids(admx, /<(?:list|text|enum|decimal|boolean)\s+id="(\w+)"/g);
  for (const lang of ['de-DE', 'en-US']) {
    const adml = read(`${lang}/Keevault.adml`);
    const have = ids(adml, /<string id="(\w+)"/g);
    for (const s of strings) assert.ok(have.has(s), `${lang}: string ${s} fehlt`);
    const pres = ids(adml, /<presentation id="(\w+)"/g);
    for (const p of presentations) assert.ok(pres.has(p), `${lang}: presentation ${p} fehlt`);
    const refs = ids(adml, /refId="(\w+)"/g);
    for (const r of refs) assert.ok(elementIds.has(r), `${lang}: refId ${r} ohne Element`);
    for (const e of elementIds) assert.ok(refs.has(e), `${lang}: Element ${e} ohne Eingabefeld`);
  }
});

test('ADMX: value names match what the app reads (desktop/policy.js)', () => {
  const policy = readFileSync(new URL('../desktop/policy.js', import.meta.url), 'utf8');
  const valueNames = ids(admx, /valueName="(\w+)"/g);
  for (const v of valueNames) assert.ok(policy.includes(`${v}: { setting:`), `${v} wird von der App nicht gelesen`);
  assert.ok(admx.includes('key="Software\\Policies\\Keevault\\Vaults"'), 'Tresor-Liste unter …\\Keevault\\Vaults');
});
