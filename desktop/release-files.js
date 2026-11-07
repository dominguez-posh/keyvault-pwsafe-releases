// What a release signature covers (#378): reads a release folder once and returns the exact manifest bytes plus the
// hashes the approval dialog shows. The signature goes over the buffer returned here, never over the file a second
// time, and the installer is hashed again and compared with the sha512 in the manifest: a folder where the two differ
// gets no dialog and no signature. No Electron import: the module is also used by the unit tests.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseManifest } from './update-verify.js';

const COMMIT = /^[0-9a-f]{7,40}$/;

const sha = (algorithm, file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash(algorithm);
  fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash));
});

/**
 * dir: release folder with latest.yml, the installer it names and build-info.json (written by scripts/release.mjs:
 * { version, commit, clean, channel }). → { manifest: Buffer, version, commit, channel, installer, manifestSha512, files }.
 * Throws on anything that does not fit: no manifest, missing or changed installer, unclean build, version mismatch.
 */
export async function inspectRelease(dir) {
  let manifest;
  try {
    manifest = fs.readFileSync(path.join(dir, 'latest.yml')); // read once: these bytes are signed
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`Im Ordner „${dir}“ liegt keine latest.yml – den Release-Ordner wählen, den scripts/release.mjs gebaut hat (meist „release“ im Projekt), nicht „Downloads“.`);
    throw new Error(`latest.yml lässt sich nicht lesen (${e.code || e.message}).`);
  }
  const parsed = parseManifest(manifest.toString('utf8'));
  if (!parsed.version || !parsed.sha512 || !parsed.url) throw new Error('latest.yml ist unvollständig (Version, Installer oder sha512 fehlt).');
  if (path.basename(parsed.url) !== parsed.url) throw new Error('latest.yml nennt einen Installer außerhalb des Ordners.');
  let info;
  try {
    info = JSON.parse(fs.readFileSync(path.join(dir, 'build-info.json'), 'utf8'));
  } catch {
    throw new Error('build-info.json fehlt – der Ordner stammt nicht aus scripts/release.mjs.');
  }
  if (info.clean !== true) throw new Error('Das Release wurde aus einem unsauberen Arbeitsstand gebaut.');
  if (!COMMIT.test(String(info.commit))) throw new Error('build-info.json enthält keinen gültigen Commit.');
  if (info.version !== parsed.version) throw new Error(`Version in build-info.json (${info.version}) und latest.yml (${parsed.version}) unterscheiden sich.`);
  if (!/^(stable|beta)$/.test(String(info.channel))) throw new Error('build-info.json nennt keinen Kanal.');
  const installerFile = path.join(dir, parsed.url);
  if (!fs.existsSync(installerFile)) throw new Error(`Installer fehlt: ${parsed.url}`);
  const installerSha512 = (await sha('sha512', installerFile)).digest('base64');
  if (installerSha512 !== parsed.sha512) throw new Error(`Installer ${parsed.url} stimmt nicht mit sha512 in latest.yml überein – nichts wird signiert.`);
  // Every other file of the release is covered through SHA256SUMS.txt, whose hash the manifest carries (B5): what is
  // not in that list is not signed, and every listed file must still be what the list says.
  const sumsFile = path.join(dir, 'SHA256SUMS.txt');
  if (!fs.existsSync(sumsFile)) throw new Error('SHA256SUMS.txt fehlt – der Ordner stammt nicht aus scripts/release.mjs.');
  const sums = (await sha('sha256', sumsFile)).digest('hex');
  const claimed = /^kvSha256Sums:\s*([0-9a-f]{64})\s*$/m.exec(manifest.toString('utf8'))?.[1];
  if (claimed !== sums) throw new Error('SHA256SUMS.txt passt nicht zu dem Hash in latest.yml (kvSha256Sums) – nichts wird signiert.');
  const files = [];
  for (const line of fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m || path.basename(m[2]) !== m[2]) throw new Error(`SHA256SUMS.txt: unlesbare Zeile „${line.slice(0, 80)}“`);
    const full = path.join(dir, m[2]);
    if (!fs.existsSync(full)) throw new Error(`${m[2]} steht in SHA256SUMS.txt, fehlt aber im Ordner.`);
    const actual = (await sha('sha256', full)).digest('hex');
    if (actual !== m[1]) throw new Error(`${m[2]} stimmt nicht mit SHA256SUMS.txt überein – nichts wird signiert.`);
    files.push({ name: m[2], size: fs.statSync(full).size, sha256: actual });
  }
  if (!files.some((f) => f.name === parsed.url)) throw new Error('Der Installer steht nicht in SHA256SUMS.txt.');
  return {
    manifest,
    version: parsed.version,
    commit: info.commit,
    channel: info.channel,
    installer: { name: parsed.url, sha512: installerSha512 },
    sums,
    manifestSha512: crypto.createHash('sha512').update(manifest).digest('hex'),
    files,
  };
}
