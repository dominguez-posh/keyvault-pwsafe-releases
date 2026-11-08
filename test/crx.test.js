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

test('self-hosted extension carries the update URL (otherwise Edge/Chrome look for updates in the store and never update)', async () => {
  const { readFileSync } = await import('node:fs');
  const { EXTENSION_UPDATE } = await import('../scripts/release-urls.mjs');
  const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.update_url, EXTENSION_UPDATE.manifest);
});

test('#455: Early Access update.xml points to the CRX of its own tag, Prod to latest; pack-crx.mjs and release.mjs pass the flag on', async () => {
  const { readFileSync } = await import('node:fs');
  const { extensionCodebase, EXTENSION_UPDATE, RELEASE_REPO } = await import('../scripts/release-urls.mjs');
  assert.equal(extensionCodebase('0.9.30', false), EXTENSION_UPDATE.crx);
  assert.match(EXTENSION_UPDATE.crx, /\/releases\/latest\/download\//);
  assert.equal(extensionCodebase('0.9.30', true), `https://github.com/${RELEASE_REPO}/releases/download/v0.9.30/kvpwsafe-extension.crx`);
  const pack = readFileSync(new URL('../scripts/pack-crx.mjs', import.meta.url), 'utf8');
  assert.match(pack, /extensionCodebase\(version, process\.argv\.includes\('--early-access'\)\)/);
  const release = readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8');
  assert.match(release, /pack-crx\.mjs'\), \.\.\.\(earlyAccess \? \['--early-access'\] : \[\]\)\]/);
});
