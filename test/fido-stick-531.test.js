// #531: a FIDO key stored for the personal vault is recognised as such, named as such, and one without PRF gets a
// message that says so instead of being silently not recognised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceKind, deviceName, registerPrf } from '../extension/core/prf.js';
import * as P from '../extension/core/protect.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

test('deviceKind tells a security key from Windows Hello and a phone', () => {
  assert.equal(deviceKind({ platform: true, attachment: 'platform', transports: ['internal'] }), 'hello');
  assert.equal(deviceKind({ platform: false, attachment: 'cross-platform', transports: ['usb'] }), 'key');
  assert.equal(deviceKind({ platform: false, attachment: 'cross-platform', transports: ['nfc', 'usb'] }), 'key');
  assert.equal(deviceKind({ platform: false, attachment: 'cross-platform', transports: [] }), 'key');
  assert.equal(deviceKind({ platform: false, attachment: 'cross-platform', transports: ['hybrid', 'internal'] }), 'phone');
  assert.equal(deviceKind({ platform: false, attachment: '', transports: [] }), '');
  assert.equal(deviceKind(), '');
  assert.equal(deviceName('key'), 'Sicherheitsschlüssel');
  assert.equal(deviceName('hello'), 'Windows Hello');
  assert.equal(deviceName(''), '');
});

/** A fake authenticator: create → credential with the given attachment/transports; prf: 'create' | 'get' | 'none'. */
function fakeCredentials({ attachment, transports, prf }) {
  const seen = { create: null, get: null };
  const rawId = randomBytes(16).buffer;
  const first = randomBytes(32).buffer;
  const credentials = {
    async create(options) {
      seen.create = options;
      return {
        rawId,
        authenticatorAttachment: attachment,
        response: { getTransports: () => transports },
        getClientExtensionResults: () => ({ prf: prf === 'create' ? { enabled: true, results: { first } } : prf === 'get' ? { enabled: true } : { enabled: false } }),
      };
    },
    async get(options) {
      seen.get = options;
      return { rawId, getClientExtensionResults: () => ({ prf: prf === 'none' ? {} : { results: { first } } }) };
    },
  };
  Object.defineProperty(globalThis.navigator, 'credentials', { value: credentials, configurable: true });
  return seen;
}

test('registerPrf reports what was registered and passes the security-key hint', async () => {
  const seen = fakeCredentials({ attachment: 'cross-platform', transports: ['usb'], prf: 'create' });
  const r = await registerPrf('localhost', { userName: 'Ich', attachment: 'cross-platform', hints: ['security-key'] });
  assert.deepEqual(seen.create.publicKey.hints, ['security-key']);
  assert.equal(seen.create.publicKey.authenticatorSelection.authenticatorAttachment, 'cross-platform');
  assert.equal(r.attachment, 'cross-platform');
  assert.deepEqual(r.transports, ['usb']);
  assert.equal(deviceKind(r), 'key');
  assert.ok(r.prfOutput);
});

test('a security key that reports PRF only on sign-in is still taken (second confirmation)', async () => {
  const seen = fakeCredentials({ attachment: 'cross-platform', transports: ['usb'], prf: 'get' });
  const r = await registerPrf('localhost', { userName: 'Ich' });
  assert.ok(seen.get, 'a sign-in follows to get the PRF value');
  assert.ok(seen.get.publicKey.extensions.prf.evalByCredential[r.credentialId]);
  assert.ok(r.prfOutput);
  assert.equal(seen.create.publicKey.hints, undefined, 'no hint unless asked');
});

test('a security key without PRF gets a message that names the stick and hmac-secret', async () => {
  fakeCredentials({ attachment: 'cross-platform', transports: ['usb'], prf: 'none' });
  await assert.rejects(registerPrf('localhost', { userName: 'Ich' }), (e) => {
    assert.match(e.message, /Sicherheitsschlüssel unterstützt kein PRF \(hmac-secret\)/);
    return true;
  });
});

test('the keyring keeps the kind of a passkey for display, and only known kinds', async () => {
  const pk = (device) => ({ credentialId: `c-${device}`, rpId: 'localhost', prfSalt: 's', prfOutput: b64uEncode(randomBytes(32)), label: 'Ich – Sicherheitsschlüssel', device });
  let { keyring, ck } = await P.setupKeyring('c1', { password: 'correct horse battery' }, 'me');
  keyring = await P.addPasskey(keyring, ck, pk('key'), 'me');
  keyring = await P.addPasskey(keyring, ck, pk('<script>'), 'me');
  const listed = P.describeKeyring(keyring, 'localhost').passkeys;
  assert.equal(listed.find((p) => p.label && p.device === 'key')?.label, 'Ich – Sicherheitsschlüssel');
  assert.equal(listed.filter((p) => p.device === '').length, 1, 'an unknown kind is not stored');
  assert.equal(keyring.entries.some((e) => e.device === '<script>'), false);
});
