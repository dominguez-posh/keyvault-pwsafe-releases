import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOneDrive, hasCloudAttributes, isUnder, parseRegistryRoots } from '../desktop/onedrive-detect.js';

// #514: "OneDrive - <Org>" was reported as local when the Cloud Files call gave no answer (fresh profile, Sandbox).

const ORG = 'C:\\Users\\kim\\OneDrive - Contoso GmbH';
const REG = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business1',
  '    UserFolder    REG_SZ    ' + ORG,
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal',
  '    UserFolder    REG_EXPAND_SZ    C:\\Users\\kim\\OneDrive',
  '',
].join('\r\n');

test('registry output yields the UserFolder of every account, also with spaces and a dash', () => {
  assert.deepEqual(parseRegistryRoots(REG), [ORG, 'C:\\Users\\kim\\OneDrive']);
  assert.deepEqual(parseRegistryRoots(''), []);
  assert.deepEqual(parseRegistryRoots(null), []);
});

test('isUnder: whole segments, case-insensitive, trailing slash', () => {
  assert.ok(isUnder(ORG + '\\Keevault-Persoenlich.kvpws', ORG));
  assert.ok(isUnder(ORG.toLowerCase() + '\\', ORG));
  assert.ok(isUnder(ORG, ORG + '\\'));
  assert.ok(!isUnder(ORG + ' 2\\x', ORG));
  assert.ok(!isUnder('C:\\Users\\kim\\Documents', ORG));
});

test('registry only (env missing): cloud', () => {
  const r = detectOneDrive(ORG + '\\Keevault-Persoenlich.kvpws', { env: {}, registryRoots: parseRegistryRoots(REG) });
  assert.equal(r.kind, 'cloud');
  assert.equal(r.provider, 'OneDrive');
});

test('env only (registry missing): OneDriveCommercial, OneDrive and OneDriveConsumer', () => {
  for (const k of ['OneDriveCommercial', 'OneDrive', 'OneDriveConsumer']) {
    assert.equal(detectOneDrive(ORG + '\\Sub', { env: { [k]: ORG }, registryRoots: [] })?.kind, 'cloud', k);
  }
});

test('cloud attributes alone (no env, no registry): cloud', () => {
  assert.ok(hasCloudAttributes(0x10 | 0x400000));
  assert.ok(hasCloudAttributes(0x10 | 0x80000));
  assert.ok(hasCloudAttributes(0x10 | 0x100000));
  assert.ok(!hasCloudAttributes(0x10));
  assert.ok(!hasCloudAttributes(null));
  assert.equal(detectOneDrive(ORG, { env: {}, registryRoots: [], attrs: 0x10 | 0x400000 })?.kind, 'cloud');
});

test('the org name in the folder alone is no signal: a local folder stays local', () => {
  assert.equal(detectOneDrive(ORG, { env: {}, registryRoots: [], attrs: 0x10 }), null);
  assert.equal(detectOneDrive(ORG, { env: {}, registryRoots: [], attrs: null }), null);
});

test('a local folder with OneDrive set up elsewhere stays local', () => {
  assert.equal(detectOneDrive('C:\\Users\\kim\\Documents\\Tresor', { env: { OneDrive: 'C:\\Users\\kim\\OneDrive' }, registryRoots: parseRegistryRoots(REG), attrs: 0x20 }), null);
  assert.equal(detectOneDrive('D:\\Daten', { env: {}, registryRoots: [] }), null);
});
