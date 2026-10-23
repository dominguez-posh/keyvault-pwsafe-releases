import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyRegistrationResponse, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { parseMakeCredential, parseGetAssertion, encodeMakeCredentialResponse, encodeGetAssertionResponse, authenticatorInfo } from '../extension/core/ctap.js';
import { makeCredentialData, signAssertionData, AAGUID } from '../extension/core/webauthn.js';
import { encode, decode } from '../extension/core/cbor.js';
import { b64uEncode, utf8, sha256, randomBytes, toHex } from '../extension/core/util.js';

const origin = 'https://example.com';

// What a browser hands to Windows: clientDataJSON, of which the authenticator only sees the hash.
function clientData(type, challenge) {
  return `{"type":"${type}","challenge":"${challenge}","origin":"${origin}","crossOrigin":false}`;
}

test('Windows provider: CTAP makeCredential / getAssertion verify end to end', async () => {
  const challenge = b64uEncode(randomBytes(32));
  const cdj = clientData('webauthn.create', challenge);
  const userId = randomBytes(16);
  // authenticatorMakeCredential request as Windows passes it (with and without command byte).
  const request = encode(new Map([
    [1, await sha256(utf8(cdj))],
    [2, new Map([['id', 'example.com'], ['name', 'Example']])],
    [3, new Map([['id', userId], ['name', 'alice@example.com'], ['displayName', 'Alice']])],
    [4, [new Map([['alg', -7], ['type', 'public-key']]), new Map([['alg', -257], ['type', 'public-key']])]],
    [7, new Map([['rk', true]])],
  ]));
  for (const bytes of [request, new Uint8Array([0x01, ...request])]) {
    const r = parseMakeCredential(bytes);
    assert.equal(r.rp.id, 'example.com');
    assert.equal(r.user.name, 'alice@example.com');
    assert.equal(r.options.rk, true);
  }
  const mc = parseMakeCredential(request);
  const { passkey, authData } = await makeCredentialData({ rpId: mc.rp.id, rpName: mc.rp.name, user: mc.user, pubKeyCredParams: mc.pubKeyCredParams });
  const response = encodeMakeCredentialResponse(authData);
  // Same layout as Windows' own encoder (probe on Windows 11 25H2): a3 01 "none" 02 authData 03 {}.
  assert.equal(toHex(response.subarray(0, 7)), 'a301646e6f6e65');
  assert.equal(toHex(response.subarray(-2)), '03a0');

  // The browser builds attestationObject from the CTAP response; verify like a relying party would.
  const ctap = decode(response);
  const attestationObject = encode(new Map([['fmt', ctap.get(1)], ['attStmt', ctap.get(3)], ['authData', ctap.get(2)]]));
  const reg = await verifyRegistrationResponse({
    response: {
      id: passkey.credentialId, rawId: passkey.credentialId, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64uEncode(utf8(cdj)), attestationObject: b64uEncode(attestationObject) },
    },
    expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: 'example.com',
  });
  assert.equal(reg.verified, true);
  assert.equal(reg.registrationInfo.aaguid.replace(/-/g, ''), toHex(AAGUID));

  const challenge2 = b64uEncode(randomBytes(32));
  const cdj2 = clientData('webauthn.get', challenge2);
  const getRequest = encode(new Map([
    [1, 'example.com'],
    [2, await sha256(utf8(cdj2))],
    [3, [new Map([['id', randomBytes(16)], ['type', 'public-key']])]],
  ]));
  const ga = parseGetAssertion(getRequest);
  assert.equal(ga.rpId, 'example.com');
  assert.equal(ga.allowList.length, 1);
  const signed = await signAssertionData({ rpId: ga.rpId, clientDataHash: ga.clientDataHash, passkey });
  const assertion = encodeGetAssertionResponse({
    credentialId: passkey.credentialId, authData: signed.authData, signature: signed.signature,
    user: { id: passkey.userHandle, name: passkey.userName, displayName: passkey.userDisplayName },
  });
  // Layout as from Windows' encoder: a4 01 {id, type} 02 authData 03 sig 04 {id, name, displayName}.
  assert.equal(toHex(assertion.subarray(0, 4)), 'a401a262');
  const a = decode(assertion);
  assert.deepEqual([...a.get(4).keys()], ['id', 'name', 'displayName']);
  const auth = await verifyAuthenticationResponse({
    response: {
      id: passkey.credentialId, rawId: passkey.credentialId, type: 'public-key', clientExtensionResults: {},
      response: {
        clientDataJSON: b64uEncode(utf8(cdj2)), authenticatorData: b64uEncode(a.get(2)),
        signature: b64uEncode(a.get(3)), userHandle: b64uEncode(a.get(4).get('id')),
      },
    },
    expectedChallenge: challenge2, expectedOrigin: origin, expectedRPID: 'example.com', credential: reg.registrationInfo.credential,
  });
  assert.equal(auth.verified, true);
  assert.equal(toHex(authenticatorInfo().subarray(0, 2)), 'a501');
});
