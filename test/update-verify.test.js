import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyManifest, parseManifest, signManifest, UPDATE_PUBLIC_KEY } from '../desktop/update-verify.js';

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
  assert.deepEqual(parseManifest(YML), { version: '1.2.3', sha512: 'abc==', url: 'Keevault-Setup-1.2.3.exe' });
  assert.deepEqual(parseManifest(''), { version: '', sha512: '', url: '' });
});

test('embedded update public key is an Ed25519 key', () => {
  const key = crypto.createPublicKey({ key: Buffer.from(UPDATE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });
  assert.equal(key.asymmetricKeyType, 'ed25519');
});
