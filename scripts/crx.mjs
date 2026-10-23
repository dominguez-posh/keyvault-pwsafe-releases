// CRX3 packaging (Chromium extension package) for self-hosting: signed with the extension's own RSA key, so
// the extension keeps its fixed ID. Format: "Cr24", version 3, header length, CrxFileHeader (protobuf), ZIP.
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';

function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

// Length-delimited protobuf field.
const field = (number, bytes) => Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);

/** Extension ID: first 16 bytes of SHA-256 of the public key (DER SPKI), hex digits mapped to a–p. */
export function extensionId(spki) {
  return [...createHash('sha256').update(spki).digest().subarray(0, 16).toString('hex')]
    .map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

export function buildCrx(zip, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem);
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const crxId = createHash('sha256').update(spki).digest().subarray(0, 16);
  const signedHeader = field(1, crxId); // SignedData { crx_id }
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedHeader.length);
  const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), len, signedHeader, zip]), key);
  // CrxFileHeader { sha256_with_rsa = 2: AsymmetricKeyProof { public_key = 1, signature = 2 }, signed_header_data = 10000 }
  const header = Buffer.concat([field(2, Buffer.concat([field(1, spki), field(2, signature)])), field(10000, signedHeader)]);
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'latin1');
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return { crx: Buffer.concat([prefix, header, zip]), id: extensionId(spki) };
}

/** Update manifest for ExtensionInstallForcelist / self-hosted updates. */
export function updateManifest({ id, version, codebase }) {
  return `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${codebase}' version='${version}' />
  </app>
</gupdate>
`;
}
