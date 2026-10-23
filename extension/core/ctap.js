// CTAP2 messages of the Windows passkey provider interface (plugin authenticator). Windows hands over
// authenticatorMakeCredential / authenticatorGetAssertion requests as CBOR and expects the bare CBOR response
// map (no status byte) – the format of WebAuthNEncodeMakeCredentialResponse / WebAuthNEncodeGetAssertionResponse.

import { decodeFirst, encode } from './cbor.js';
import { b64uEncode, b64uDecode, toBytes } from './util.js';
import { AAGUID } from './webauthn.js';

// Tolerate a leading CTAP command byte (0x01 makeCredential, 0x02 getAssertion) before the CBOR map.
function body(bytes) {
  const b = toBytes(bytes);
  return b.length > 1 && (b[0] === 0x01 || b[0] === 0x02) && b[1] >= 0xa0 && b[1] <= 0xbf ? b.subarray(1) : b;
}

const field = (map, key) => (map instanceof Map ? map.get(key) : undefined);
const text = (v) => (typeof v === 'string' ? v : '');
const options = (m) => ({ rk: field(m, 'rk'), up: field(m, 'up'), uv: field(m, 'uv') });

export function parseMakeCredential(bytes) {
  const [m] = decodeFirst(body(bytes));
  const rp = field(m, 2);
  const user = field(m, 3);
  return {
    clientDataHash: field(m, 1),
    rp: { id: text(field(rp, 'id')), name: text(field(rp, 'name')) },
    user: { id: b64uEncode(field(user, 'id') || new Uint8Array(0)), name: text(field(user, 'name')), displayName: text(field(user, 'displayName')) },
    pubKeyCredParams: (field(m, 4) || []).map((p) => ({ type: field(p, 'type'), alg: field(p, 'alg') })),
    excludeList: (field(m, 5) || []).map((c) => b64uEncode(field(c, 'id'))),
    options: options(field(m, 7)),
  };
}

export function parseGetAssertion(bytes) {
  const [m] = decodeFirst(body(bytes));
  return {
    rpId: text(field(m, 1)),
    clientDataHash: field(m, 2),
    allowList: (field(m, 3) || []).map((c) => b64uEncode(field(c, 'id'))),
    options: options(field(m, 5)),
  };
}

export function encodeMakeCredentialResponse(authData) {
  return encode(new Map([[1, 'none'], [2, authData], [3, new Map()]]));
}

export function encodeGetAssertionResponse({ credentialId, authData, signature, user }) {
  const userMap = new Map([['id', b64uDecode(user.id || '')]]);
  if (user.name) userMap.set('name', user.name);
  if (user.displayName) userMap.set('displayName', user.displayName);
  return encode(new Map([
    [1, new Map([['id', b64uDecode(credentialId)], ['type', 'public-key']])],
    [2, authData],
    [3, signature],
    [4, userMap],
  ]));
}

/** authenticatorGetInfo for the provider registration. */
export function authenticatorInfo() {
  return encode(new Map([
    [1, ['FIDO_2_0', 'FIDO_2_1']],
    [3, AAGUID],
    [4, new Map([['rk', true], ['up', true], ['uv', true]])],
    [9, ['internal']],
    [10, [new Map([['alg', -7], ['type', 'public-key']])]],
  ]));
}

