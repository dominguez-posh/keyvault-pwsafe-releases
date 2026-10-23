// Creates (once) the extension's signing key and writes its public part into extension/manifest.json ("key").
// That fixes the extension ID and therefore the Entra redirect URI https://<id>.chromiumapp.org/.
// The private key (extension-key.pem) stays local and is gitignored; it is only needed to pack a .crx.
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const pemPath = new URL('extension-key.pem', root);
const manifestPath = new URL('extension/manifest.json', root);

let privateKey;
if (existsSync(pemPath)) {
  privateKey = createPrivateKey(readFileSync(pemPath));
} else {
  ({ privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 }));
  writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('Neuer Schlüssel extension-key.pem erzeugt – nicht einchecken, sicher aufbewahren.');
}

const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const id = [...createHash('sha256').update(der).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15)))
  .join('');

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.key = der.toString('base64');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Erweiterungs-ID: ${id}`);
console.log(`Redirect-URI:    https://${id}.chromiumapp.org/`);
