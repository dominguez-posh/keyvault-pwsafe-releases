// Key for signed update manifests (desktop/update-verify.js).
//   node scripts/update-key.mjs                    creates update-key.pem once (Ed25519, local, gitignored via *.pem)
//                                                  and prints the public key for UPDATE_PUBLIC_KEY
//   node scripts/update-key.mjs sign <file>        writes <file>.sig – release.ps1 signs release/latest.yml with it
// Losing the key means new versions can only be installed by hand (the app rejects manifests it cannot verify):
// keep a backup like extension-key.pem.
import { generateKeyPairSync, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { signManifest, UPDATE_PUBLIC_KEY } from '../desktop/update-verify.js';

const root = new URL('..', import.meta.url);
const pemPath = new URL('update-key.pem', root);
const [cmd, file] = process.argv.slice(2);

let privateKey;
if (existsSync(pemPath)) {
  privateKey = createPrivateKey(readFileSync(pemPath));
} else if (cmd === 'sign') {
  throw new Error('update-key.pem fehlt – ohne den Schlüssel kein Release. Ein neuer Schlüssel (node scripts/update-key.mjs) verlangt den neuen öffentlichen Schlüssel in desktop/update-verify.js.');
} else {
  ({ privateKey } = generateKeyPairSync('ed25519'));
  writeFileSync(pemPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  console.log('Neuer Schlüssel update-key.pem erzeugt – nicht einchecken, sicher aufbewahren.');
}

const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
if (cmd === 'sign') {
  if (!file) throw new Error('Datei fehlt: node scripts/update-key.mjs sign <datei>');
  if (publicKey !== UPDATE_PUBLIC_KEY) throw new Error('update-key.pem passt nicht zu UPDATE_PUBLIC_KEY in desktop/update-verify.js');
  writeFileSync(`${file}.sig`, signManifest(readFileSync(file), privateKey));
  console.log(`signiert: ${file}.sig`);
} else {
  console.log(`Öffentlicher Schlüssel (UPDATE_PUBLIC_KEY in desktop/update-verify.js):\n${publicKey}`);
  if (publicKey !== UPDATE_PUBLIC_KEY) console.log('Achtung: weicht vom eingebetteten Schlüssel ab – update-verify.js anpassen.');
}
