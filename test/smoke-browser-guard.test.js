import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionIdFromKey, foreignKeevault, hostResolverRules } from '../scripts/smoke-browser-guard.mjs';

const REAL_ID = 'pbkjijhihclckeeefbepoedgdmajioip';

function profileWith(id, name) {
  const profile = mkdtempSync(join(tmpdir(), 'kv-guard-'));
  if (id) {
    const dir = join(profile, 'Default', 'Extensions', id, '1.0.0_0');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ name }));
  }
  return profile;
}

test('extension smoke guard: the ID comes from the manifest key', () => {
  const { key } = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(extensionIdFromKey(key), REAL_ID);
});

test('extension smoke guard: a clean profile passes, also with other extensions and the copy running', () => {
  const clean = profileWith(null);
  const other = profileWith('lpephllkfajfgmnfepkdcappnopogjbe', 'Other extension');
  try {
    assert.equal(foreignKeevault({ profile: clean, realId: REAL_ID }), null);
    const targets = [{ url: 'about:blank' }, { url: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js' }];
    assert.equal(foreignKeevault({ profile: other, targets, realId: REAL_ID }), null);
  } finally {
    rmSync(clean, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test('extension smoke guard: finds the real extension, installed or running, and a Keevault with its own ID', () => {
  const installed = profileWith(REAL_ID, 'Keevault');
  const ownId = profileWith('abcdefghijklmnopabcdefghijklmnop', 'Keevault');
  const clean = profileWith(null);
  try {
    assert.match(foreignKeevault({ profile: installed, realId: REAL_ID }), /installiert/);
    assert.match(foreignKeevault({ profile: ownId, realId: REAL_ID }), /Name Keevault/);
    const targets = [{ url: `chrome-extension://${REAL_ID}/background.js` }];
    assert.match(foreignKeevault({ profile: clean, targets, realId: REAL_ID }), /läuft/);
  } finally {
    rmSync(installed, { recursive: true, force: true });
    rmSync(ownId, { recursive: true, force: true });
    rmSync(clean, { recursive: true, force: true });
  }
});

test('extension smoke guard: only the imitated hosts and localhost resolve', () => {
  const rules = hostResolverRules(['login.microsoftonline.com']).split(',');
  assert.ok(rules.includes('MAP login.microsoftonline.com 127.0.0.1'));
  assert.ok(rules.includes('EXCLUDE localhost'));
  assert.equal(rules.at(-1), 'MAP * ~NOTFOUND');
  assert.ok(!rules.some((r) => /github/i.test(r)));
});
