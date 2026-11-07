// The checks right before a release goes public (scripts/release.mjs, #378) and the list of what is uploaded. In their own
// module so that the unit tests run the real code: the asset list and the signature check are what decides whether a
// release is published.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { UPDATE_KEYS, verifyManifest } from '../desktop/update-verify.js';

/** Files that scripts/pack-*.mjs write to dist/ and that go to the release: they are copied to release/ before the checksums. */
export const distFiles = (version) => ['kvpwsafe-extension.crx', 'update.xml', `kvpwsafe-extension-${version}-firefox.zip`];

/**
 * Everything that is uploaded, relative to the repository: every file lives in release/ (C1), the checksum list is made
 * from exactly these paths and the upload reads exactly these paths. latest.yml, its signatures and SHA256SUMS.txt are
 * added by release.mjs after the checksums (they are what is signed, not part of the list).
 */
export const releaseAssets = (version) => [
  `release/Keevault-Setup-${version}.exe`, 'release/Keevault-Setup.exe', `release/Keevault-${version}.msi`, 'release/Keevault.msi',
  `release/Keevault-${version}.msix`, 'release/Keevault.msix', 'release/Keevault-Zertifikat.cer', `release/Keevault-Setup-${version}.exe.blockmap`,
  'release/Keevault-Geraet-Einrichten.ps1', 'release/Keevault-Richtlinien.zip', ...distFiles(version).map((n) => `release/${n}`),
  `release/Keevault-${version}-sbom.cdx.json`,
];

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Before anything goes public: every signature that exists must verify against the embedded keys, at least one must
 * exist, and once the app signs, latest.yml.sig2 is required. The checksum list must be the one the manifest names, every
 * uploaded file must be listed in it and match it, and the installer must still be the one the manifest names.
 * With publishOnly the build must also be the one this commit and channel describe.
 * dir: the release folder; assets: absolute paths that are uploaded; keys: the embedded key list.
 */
/** The app signs once a security key (es256) stands in the key list; the number of entries says nothing (#442). */
export const appSignsWith = (keys) => Array.isArray(keys) && keys.some((k) => k?.alg === 'es256');

/** The old signature (latest.yml.sig, update-key.pem) is written only while the list still carries a software key (#442). */
export const signsOldWith = (keys) => Array.isArray(keys) && keys.some((k) => k?.alg === 'ed25519');

export function checkSignedRelease({ dir, version, assets, keys = UPDATE_KEYS, publishOnly = false, earlyAccess = false, head = '' }) {
  const appSigns = appSignsWith(keys);
  const yml = readFileSync(join(dir, 'latest.yml'));
  const read = (n) => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8') : '');
  const [sig, sig2] = [read('latest.yml.sig'), read('latest.yml.sig2')];
  if (!sig && !sig2) throw new Error('Keine Signatur (latest.yml.sig / latest.yml.sig2) – erst in Keevault „Release signieren“.');
  if (sig && !verifyManifest(yml, sig, keys)) throw new Error('latest.yml.sig passt nicht zu latest.yml und den eingebetteten Schlüsseln.');
  if (sig2 && !verifyManifest(yml, sig2, keys)) throw new Error('latest.yml.sig2 passt nicht zu latest.yml und den eingebetteten Schlüsseln.');
  if (appSigns && !sig2) throw new Error('latest.yml.sig2 fehlt: die Signatur der App ist Pflicht, sobald ein Stick-Schlüssel (es256) eingebettet ist.');
  if (publishOnly) {
    const info = JSON.parse(readFileSync(join(dir, 'build-info.json'), 'utf8'));
    if (info.kind !== 'release') throw new Error('Der Build ist ein Developer-Build (ohne --early-access oder --release gebaut) – neu bauen mit --early-access bzw. --release.');
    if (info.commit !== head) throw new Error(`Der Build stammt von Commit ${info.commit}, der Arbeitsstand ist ${head} – neu bauen und signieren.`);
    if (info.version !== version) throw new Error(`Der Build ist Version ${info.version}, package.json sagt ${version}.`);
    if (info.channel !== (earlyAccess ? 'beta' : 'stable')) throw new Error(`Der Build ist für den Kanal ${info.channel}, veröffentlicht wird für ${earlyAccess ? 'beta' : 'stable'}.`);
  }
  const claimed = /^kvSha256Sums:\s*([0-9a-f]{64})\s*$/m.exec(yml.toString('utf8'))?.[1];
  const sumsText = readFileSync(join(dir, 'SHA256SUMS.txt'));
  if (!claimed || createHash('sha256').update(sumsText).digest('hex') !== claimed) throw new Error('SHA256SUMS.txt passt nicht zu kvSha256Sums im signierten Manifest.');
  const listed = new Map();
  for (const line of sumsText.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const [hash, name] = [line.slice(0, 64), line.slice(66)];
    if (!existsSync(join(dir, name)) || sha256(join(dir, name)) !== hash) throw new Error(`${name} fehlt oder stimmt nicht mit der signierten Prüfsummenliste überein.`);
    listed.set(name, hash);
  }
  // What is uploaded is what was listed and signed, read from the release folder (C1).
  const signedDirect = new Set(['latest.yml', 'latest.yml.sig', 'latest.yml.sig2', 'SHA256SUMS.txt']);
  for (const asset of assets) {
    const name = basename(asset);
    if (resolve(dirname(asset)) !== resolve(dir)) throw new Error(`${asset} liegt nicht im Release-Ordner – hochgeladen wird nur, was geprüft wurde.`);
    if (!signedDirect.has(name) && !listed.has(name)) throw new Error(`${name} steht nicht in der signierten Prüfsummenliste.`);
  }
  const sha512 = /^sha512:\s*(\S+)/m.exec(yml.toString('utf8'))?.[1];
  const installer = join(dir, `Keevault-Setup-${version}.exe`);
  if (sha512 && createHash('sha512').update(readFileSync(installer)).digest('base64') !== sha512) throw new Error('Der Installer passt nicht mehr zum signierten Manifest.');
}
