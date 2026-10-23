import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { createCredential, getAssertion, effectiveRpId, rawSignatureToDer, filterPasskeys, WebAuthnError } from '../extension/core/webauthn.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';
import { encode, decode } from '../extension/core/cbor.js';

const origin = 'https://login.example.com';
const rpId = 'example.com';

test('registration and authentication verify with an independent relying-party library', async () => {
  const challenge = b64uEncode(randomBytes(32));
  const { passkey, response } = await createCredential({
    origin, rpId, rpName: 'Example',
    user: { id: b64uEncode(randomBytes(16)), name: 'alice@example.com', displayName: 'Alice' },
    challenge, pubKeyCredParams: [{ type: 'public-key', alg: -257 }, { type: 'public-key', alg: -7 }], credProps: true,
  });
  const reg = await verifyRegistrationResponse({
    response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpId, requireUserVerification: true,
  });
  assert.equal(reg.verified, true);
  assert.equal(reg.registrationInfo.fmt, 'none');
  assert.equal(reg.registrationInfo.credentialDeviceType, 'multiDevice');
  assert.equal(reg.registrationInfo.credentialBackedUp, true);
  assert.equal(reg.registrationInfo.credential.id, passkey.credentialId);
  assert.deepEqual(response.clientExtensionResults, { credProps: { rk: true } });

  for (let i = 0; i < 2; i++) {
    const authChallenge = b64uEncode(randomBytes(32));
    const { response: assertion } = await getAssertion({ origin, rpId, challenge: authChallenge, passkey });
    const auth = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: authChallenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      credential: reg.registrationInfo.credential,
      requireUserVerification: true,
    });
    assert.equal(auth.verified, true);
    assert.equal(assertion.response.userHandle, passkey.userHandle);
  }
});

test('imported passkeys with a counter keep counting', async () => {
  const challenge = b64uEncode(randomBytes(32));
  const { passkey, response } = await createCredential({
    origin, rpId, user: { id: 'dXNlcg', name: 'u', displayName: 'U' }, challenge,
  });
  const reg = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpId });
  const authChallenge = b64uEncode(randomBytes(32));
  const { response: assertion, signCount } = await getAssertion({ origin, rpId, challenge: authChallenge, passkey: { ...passkey, signCount: 41 } });
  assert.equal(signCount, 42);
  const auth = await verifyAuthenticationResponse({
    response: assertion, expectedChallenge: authChallenge, expectedOrigin: origin, expectedRPID: rpId,
    credential: { ...reg.registrationInfo.credential, counter: 41 },
  });
  assert.equal(auth.authenticationInfo.newCounter, 42);
});

test('RP ID rules', () => {
  assert.equal(effectiveRpId('https://login.example.com', 'example.com'), 'example.com');
  assert.equal(effectiveRpId('https://example.com'), 'example.com');
  assert.equal(effectiveRpId('http://localhost:3000'), 'localhost');
  assert.throws(() => effectiveRpId('https://example.com', 'other.com'), WebAuthnError);
  assert.throws(() => effectiveRpId('https://evilexample.com', 'example.com'), WebAuthnError);
  assert.throws(() => effectiveRpId('http://example.com'), /HTTPS/);
  assert.throws(() => effectiveRpId('https://example.com', 'com'), WebAuthnError);
  assert.throws(() => effectiveRpId('https://192.168.1.1'), WebAuthnError);
});

test('only ES256 is offered', async () => {
  await assert.rejects(
    createCredential({ origin, rpId, user: { id: 'AA', name: 'x' }, challenge: 'AAAA', pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }),
    (e) => e.name === 'NotSupportedError',
  );
});

test('DER encoding of r||s signatures', () => {
  const raw = new Uint8Array(64);
  raw[0] = 0x80; // high bit set → needs a leading zero
  raw[63] = 1;
  const der = rawSignatureToDer(raw);
  assert.equal(der[0], 0x30);
  assert.equal(der[2], 0x02);
  assert.equal(der[3], 33);
  assert.equal(der[4], 0);
  assert.deepEqual([...der.slice(-3)], [0x02, 1, 1]);
});

test('allowCredentials filtering', () => {
  const keys = [{ rpId, credentialId: 'AQID' }, { rpId, credentialId: 'BAUG' }, { rpId: 'other.com', credentialId: 'AQID' }];
  assert.equal(filterPasskeys(keys, rpId).length, 2);
  assert.deepEqual(filterPasskeys(keys, rpId, ['AQID']).map((k) => k.credentialId), ['AQID']);
});

test('CBOR round trip', () => {
  const value = new Map([[1, 2], [3, -7], [-1, 1], ['fmt', 'none'], ['b', new Uint8Array([1, 2, 3])], ['arr', [true, false, null, 70000, 2 ** 40]]]);
  const back = decode(encode(value));
  assert.equal(back.get(3), -7);
  assert.equal(back.get('fmt'), 'none');
  assert.deepEqual([...back.get('b')], [1, 2, 3]);
  assert.deepEqual(back.get('arr'), [true, false, null, 70000, 2 ** 40]);
});
