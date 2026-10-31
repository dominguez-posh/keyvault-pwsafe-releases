import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyManifest, parseManifest, signManifest, UPDATE_PUBLIC_KEY } from '../desktop/update-verify.js';
import { notesForLanguage } from '../extension/core/release-notes.js';

const YML = 'version: 1.2.3\nfiles:\n  - url: Keevault-Setup-1.2.3.exe\n    sha512: abc==\n    size: 1\npath: Keevault-Setup-1.2.3.exe\nsha512: abc==\nreleaseDate: 2026-10-29T00:00:00.000Z\n';

test('update manifest: signature verifies, anything changed or unsigned fails', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const sig = signManifest(YML, privateKey);
  assert.equal(verifyManifest(YML, sig, pub), true);
  assert.equal(verifyManifest(YML, `${sig}\n`, pub), true, 'trailing newline from the server is tolerated');
  assert.equal(verifyManifest(YML.replace('1.2.3', '1.2.4'), sig, pub), false, 'changed version');
  assert.equal(verifyManifest(YML.replace('abc==', 'abd=='), sig, pub), false, 'changed installer hash');
  assert.equal(verifyManifest(YML, sig), false, 'signed with a different key than the embedded one');
  assert.equal(verifyManifest(YML, 'kein-base64!', pub), false);
  assert.equal(verifyManifest(YML, '', pub), false);
  assert.equal(verifyManifest(YML, sig, ''), false, 'no public key → nothing verifies');
  // PEM private key works too (the signing script reads update-key.pem).
  assert.equal(verifyManifest(YML, signManifest(YML, privateKey.export({ type: 'pkcs8', format: 'pem' })), pub), true);
});

test('update manifest: version, hash and file name are read from latest.yml', () => {
  assert.deepEqual(parseManifest(YML), { version: '1.2.3', sha512: 'abc==', url: 'Keevault-Setup-1.2.3.exe', notes: '' });
  assert.deepEqual(parseManifest(''), { version: '', sha512: '', url: '', notes: '' });
});

test('update manifest: release notes block (CHANGELOG section) is read and split by language', () => {
  const notes = '## 1.2.3 – 2026-10-31\n- Neuer Update-Dialog\n\n  mit Details\n- Fehler behoben\n\n### English\n- New update dialog\n- Bug fixed\n';
  const yml = `${YML}releaseNotes: |\n${notes.split('\n').map((l) => (l ? `  ${l}` : '')).join('\n')}\n`;
  const parsed = parseManifest(yml);
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.notes, notes.trim());
  assert.equal(notesForLanguage(parsed.notes, 'de'), '- Neuer Update-Dialog\n\n  mit Details\n- Fehler behoben');
  assert.equal(notesForLanguage(parsed.notes, 'en'), '- New update dialog\n- Bug fixed');
  assert.equal(notesForLanguage('## 1.2.3\n- nur Deutsch', 'en'), '- nur Deutsch', 'no English part → German');
  assert.equal(notesForLanguage('', 'de'), '');
  // Windows line endings as written by release.ps1 on Windows.
  assert.equal(parseManifest(yml.replace(/\n/g, '\r\n')).notes, notes.trim());
});

test('embedded update public key is an Ed25519 key', () => {
  const key = crypto.createPublicKey({ key: Buffer.from(UPDATE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'ed25519');
});

test('release notes: every version newer than the installed one, per language, area in front', async () => {
  const { releaseNotesSince } = await import('../extension/core/release-notes.js');
  const { recentSections } = await import('../scripts/release-notes.mjs');
  const changelog = '# Changelog\n\nIntro\n\n## 1.3.0 – 2026-11-02\n- Neu: C\n\n### English\n- New: C\n\n## 1.2.10 – 2026-11-01\n- B eins\n  weiter\n- B zwei\n\n### English\n- B one\n\n## 1.2.9 – 2026-10-31\n- A\n';
  const notes = recentSections(changelog, '1.3.0');
  assert.match(notes, /^## 1\.3\.0/);
  assert.match(notes, /## 1\.2\.9/, 'older sections come along');
  assert.equal(recentSections(changelog, '1.2.10', 1).match(/^## /gm).length, 1, 'count limits the sections');
  const de = releaseNotesSince(notes, '1.2.9', 'de');
  assert.deepEqual(de.map((v) => v.version), ['1.3.0', '1.2.10'], 'skipped 1.2.10 included, installed 1.2.9 not');
  assert.deepEqual(de[1].items, ['B eins weiter', 'B zwei']);
  assert.equal(de[0].date, '2026-11-02');
  assert.deepEqual(releaseNotesSince(notes, '1.2.10', 'en')[0].items, ['New: C']);
  assert.deepEqual(releaseNotesSince('- old style', '1.0.0', 'de'), [{ version: '', date: '', items: ['old style'] }]);
});
