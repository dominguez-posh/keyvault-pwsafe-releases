// electron-builder hook (build.beforePack): writes the SHA-256 of the passkey provider's certificate next to the app code
// (desktop/cert-pin.json, not tracked), so it ends up in app.asar. The device setup (desktop/machine-setup.js) adds a
// certificate to the machine's trust store only when it has exactly this fingerprint (#395). Every build pins the
// certificate it ships, so a new certificate needs no manual step. Without the certificate the pin stays empty and
// nothing is ever trusted.
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async function beforePack() {
  const root = join(__dirname, '..');
  const cer = join(root, 'windows', 'out', 'KvPwSafe-Test.cer');
  let sha256 = '';
  if (existsSync(cer)) {
    const raw = readFileSync(cer);
    const text = raw.toString('latin1');
    // DER or PEM: the fingerprint is always that of the DER form
    const der = text.includes('BEGIN CERTIFICATE') ? Buffer.from(text.replace(/-----[^-]+-----|\s/g, ''), 'base64') : raw;
    sha256 = createHash('sha256').update(der).digest('hex');
  }
  writeFileSync(join(root, 'desktop', 'cert-pin.json'), `${JSON.stringify({ sha256 })}\n`);
};
