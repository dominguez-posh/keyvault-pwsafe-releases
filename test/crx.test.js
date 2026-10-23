import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { buildCrx, extensionId, updateManifest } from '../scripts/crx.mjs';

// Minimal protobuf reader for the CRX3 header (length-delimited fields only).
function fields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = buf[i++];
      n += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return n;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const tag = varint();
    const len = varint();
    out.push({ number: Math.floor(tag / 8), data: buf.subarray(i, i + len) });
    i += len;
  }
  return out;
}

test('CRX3: signed with the extension key, ID derived from it, update manifest points to the package', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const zip = Buffer.from('PK\x03\x04 fake zip content');
  const { crx, id } = buildCrx(zip, pem);

  assert.equal(crx.subarray(0, 4).toString('latin1'), 'Cr24');
  assert.equal(crx.readUInt32LE(4), 3);
  const headerLen = crx.readUInt32LE(8);
  const header = fields(crx.subarray(12, 12 + headerLen));
  assert.deepEqual(crx.subarray(12 + headerLen), zip, 'ZIP follows the header unchanged');

  const proof = fields(header.find((f) => f.number === 2).data);
  const spki = proof.find((f) => f.number === 1).data;
  const signature = proof.find((f) => f.number === 2).data;
  const signedHeader = header.find((f) => f.number === 10000).data;
  assert.equal(extensionId(spki), id);
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(fields(signedHeader)[0].data.length, 16, 'crx_id = 16 bytes');

  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedHeader.length);
  const signed = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), len, signedHeader, zip]);
  assert.ok(verify('sha256', signed, createPublicKey({ key: spki, format: 'der', type: 'spki' }), signature));

  const xml = updateManifest({ id, version: '1.2.3', codebase: 'https://example.com/x.crx' });
  assert.match(xml, new RegExp(`appid='${id}'`));
  assert.match(xml, /version='1\.2\.3'/);
});
