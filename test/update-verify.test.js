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

// ---- key list, second signature and hardware key (#378)
import { readFileSync } from 'node:fs';
import { UPDATE_KEYS, releaseChallenge, encodeAssertion } from '../desktop/update-verify.js';

const ed = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, key: { id: 't', alg: 'ed25519', publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } };
};

test('key list: any listed key verifies, unknown algorithm and empty entries never do', () => {
  const a = ed();
  const b = ed();
  assert.equal(verifyManifest(YML, signManifest(YML, b.privateKey), [a.key, b.key]), true, 'second key in the list');
  assert.equal(verifyManifest(YML, signManifest(YML, b.privateKey), [a.key]), false, 'key not in the list');
  assert.equal(verifyManifest(YML, signManifest(YML, a.privateKey), [{ ...a.key, alg: 'rsa' }]), false, 'unknown algorithm');
  assert.equal(verifyManifest(YML, signManifest(YML, a.privateKey), [{ alg: 'ed25519' }, null]), false);
  assert.equal(verifyManifest(YML, signManifest(YML, a.privateKey), []), false);
  assert.equal(UPDATE_KEYS.every((k) => k.id && k.alg && k.publicKey), true);
});

// A real WebAuthn assertion from a virtual FIDO2 authenticator (Electron, cross-platform, no PRF, challenge = 32 x 0x07).
const fx = JSON.parse(readFileSync(new URL('./fixtures/webauthn-es256.json', import.meta.url), 'utf8'));
const hw = { id: 'hw', alg: 'es256', publicKey: fx.spki };

/** The fixture's challenge is fixed, so the tests rebuild an assertion for their own manifest with a software ES256 key. */
function assertionFor(manifest, { privateKey }, over = {}) {
  const origin = over.origin ?? 'http://localhost';
  const clientDataJSON = Buffer.from(JSON.stringify({ type: over.type ?? 'webauthn.get', challenge: over.challenge ?? releaseChallenge(manifest), origin, crossOrigin: false }));
  const rpId = over.rpId ?? 'localhost';
  const authData = Buffer.concat([crypto.createHash('sha256').update(rpId).digest(), Buffer.from([over.flags ?? 0x05]), Buffer.alloc(4)]);
  const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), privateKey);
  return encodeAssertion({ authData, clientDataJSON, signature });
}
const ec = () => {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { privateKey: pair.privateKey, key: { id: 'ec', alg: 'es256', publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } };
};

test('hardware key: the fixture from a virtual FIDO2 key verifies its own challenge and nothing else', () => {
  const clientData = Buffer.from(fx.clientDataJSON, 'base64').toString();
  assert.match(clientData, /"type":"webauthn.get"/);
  const own = encodeAssertion({ authData: Buffer.from(fx.authData, 'base64'), clientDataJSON: Buffer.from(fx.clientDataJSON, 'base64'), signature: Buffer.from(fx.signature, 'base64') });
  // The fixture's challenge is not a release challenge, so it must be refused for any manifest ...
  assert.equal(verifyManifest(YML, own, [hw], 'http://localhost:57374'), false);
  // ... but the signature itself is valid for authData || SHA-256(clientDataJSON): prove it with the same primitive.
  const signed = Buffer.concat([Buffer.from(fx.authData, 'base64'), crypto.createHash('sha256').update(Buffer.from(fx.clientDataJSON, 'base64')).digest()]);
  assert.equal(crypto.verify('sha256', signed, crypto.createPublicKey({ key: Buffer.from(fx.spki, 'base64'), format: 'der', type: 'spki' }), Buffer.from(fx.signature, 'base64')), true);
  assert.equal(Buffer.from(fx.authData, 'base64')[32] & 0x01, 1, 'user presence flag set');
});

test('hardware key: right challenge, RP ID, origin and touch pass; every deviation fails', () => {
  const k = ec();
  const list = [k.key];
  assert.equal(verifyManifest(YML, assertionFor(YML, k), list), true);
  assert.equal(verifyManifest(YML.replace('1.2.3', '1.2.4'), assertionFor(YML, k), list), false, 'changed manifest bytes');
  assert.equal(verifyManifest(YML, assertionFor(YML, k, { challenge: releaseChallenge('anderes') }), list), false, 'wrong challenge');
  assert.equal(verifyManifest(YML, assertionFor(YML, k, { flags: 0 }), list), false, 'no user presence (not touched)');
  assert.equal(verifyManifest(YML, assertionFor(YML, k, { flags: 0x0d }), list), false, 'B6: backup eligible = synced passkey');
  assert.equal(verifyManifest(YML, assertionFor(YML, k, { flags: 0x01 }), list), false, 'C2: touched but no PIN (user verification missing)');
  assert.equal(verifyManifest(YML, assertionFor(YML, k, { flags: 0x1d }), list), false, 'B6: backed up');
  assert.equal(verifyManifest(YML, assertionFor(YML, k, { rpId: 'example.com' }), list), false, 'other RP ID');
  assert.equal(verifyManifest(YML, assertionFor(YML, k, { origin: 'https://evil.example' }), list), false, 'other origin');
  assert.equal(verifyManifest(YML, assertionFor(YML, k, { type: 'webauthn.create' }), list), false, 'wrong ceremony type');
  assert.equal(verifyManifest(YML, assertionFor(YML, k), [ec().key]), false, 'foreign key');
  assert.equal(verifyManifest(YML, assertionFor(YML, k), [{ ...k.key, alg: 'ed25519' }]), false, 'assertion is not an Ed25519 signature');
  assert.equal(verifyManifest(YML, '{"alg":"es256"}', list), false, 'incomplete assertion');
  assert.equal(verifyManifest(YML, signManifest(YML, ed().privateKey), list), false, 'plain signature on an es256 key');
});
