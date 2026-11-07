import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSignedRelease, distFiles, releaseAssets } from '../scripts/release-check.mjs';
import { signManifest } from '../desktop/update-verify.js';

// C1: the real asset list and the real publish check, with test keys and test files only.
const V = '9.9.9';
const newKey = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, key: { id: 'k', alg: 'ed25519', publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64') } };
};
const sha = (a, b) => crypto.createHash(a).update(b).digest(b === undefined ? 'hex' : 'hex');

/** A release folder the way release.mjs leaves it: every asset in release/, checksum list, hash in the manifest, signatures. */
function release({ sign = ['sig'], keys, extraAssets = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-rel-'));
  const dir = path.join(root, 'release');
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(root, 'dist'));
  const assets = releaseAssets(V).filter((a) => !a.endsWith('-sbom.cdx.json')).concat(`release/Keevault-${V}-sbom.cdx.json`).map((a) => path.join(root, a));
  for (const a of assets) fs.writeFileSync(a, `content of ${path.basename(a)}`);
  const installer = path.join(dir, `Keevault-Setup-${V}.exe`);
  const sums = assets.map((a) => `${crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex')}  ${path.basename(a)}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'SHA256SUMS.txt'), sums);
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(installer)).digest('base64');
  fs.writeFileSync(path.join(dir, 'latest.yml'), `version: ${V}\npath: Keevault-Setup-${V}.exe\nsha512: ${sha512}\nkvSha256Sums: ${crypto.createHash('sha256').update(sums).digest('hex')}\n`);
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify({ version: V, commit: 'abc1234', kind: 'release', clean: true, channel: 'stable' }));
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'));
  const k = newKey();
  for (const which of sign) fs.writeFileSync(path.join(dir, which === 'sig' ? 'latest.yml.sig' : 'latest.yml.sig2'), signManifest(yml, k.privateKey));
  return { root, dir, assets: [...assets, ...extraAssets, ...['latest.yml', ...sign.map((w) => (w === 'sig' ? 'latest.yml.sig' : 'latest.yml.sig2')), 'SHA256SUMS.txt'].map((n) => path.join(dir, n))], keys: keys || [k.key] };
}

test('C1: every asset of the real list lives in release/, names are unique, the dist files are copied there first', () => {
  const list = releaseAssets(V);
  assert.equal(list.every((a) => a.startsWith('release/')), true, list.join(', '));
  assert.equal(new Set(list.map((a) => path.basename(a))).size, list.length);
  for (const n of distFiles(V)) assert.equal(list.includes(`release/${n}`), true, `${n} is in the upload list`);
  const src = fs.readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8');
  assert.match(src, /copyFresh\(R\('dist', n\), R\('release', n\)\)/);
  assert.equal(/R\(['"`]dist\//.test(src), false, 'release.mjs no longer uploads from dist/');
});

test('--publish as before: one embedded key, the old signature only, checksum list and upload list consistent -> passes', () => {
  const r = release();
  assert.doesNotThrow(() => checkSignedRelease({ dir: r.dir, version: V, assets: r.assets, keys: r.keys }));
});

test('publish check counter-tests: dist/ upload, unlisted file, changed file, stale list, missing sig2, wrong build', () => {
  const r = release();
  const args = { dir: r.dir, version: V, assets: r.assets, keys: r.keys };
  const fromDist = [...r.assets.slice(0, -5), path.join(r.root, 'dist', 'kvpwsafe-extension.crx'), ...r.assets.slice(-4)];
  assert.throws(() => checkSignedRelease({ ...args, assets: fromDist }), /nicht im Release-Ordner/, 'C1: an asset outside release/');
  fs.writeFileSync(path.join(r.dir, 'extra.bin'), 'x');
  assert.throws(() => checkSignedRelease({ ...args, assets: [...r.assets, path.join(r.dir, 'extra.bin')] }), /nicht in der signierten Prüfsummenliste/);
  fs.appendFileSync(path.join(r.dir, 'Keevault.msi'), 'changed after the list');
  assert.throws(() => checkSignedRelease(args), /Prüfsummenliste/);
  const stale = release();
  fs.appendFileSync(path.join(stale.dir, 'SHA256SUMS.txt'), 'x');
  assert.throws(() => checkSignedRelease({ dir: stale.dir, version: V, assets: stale.assets, keys: stale.keys }), /kvSha256Sums/);
  const two = release();
  assert.throws(() => checkSignedRelease({ dir: two.dir, version: V, assets: two.assets, keys: [...two.keys, { id: 'release-1', alg: 'es256', publicKey: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), credentialId: 'c' }] }), /sig2 fehlt/, 'with a security key in the list the app signature is mandatory');
  const app = release({ sign: ['sig2'] });
  assert.doesNotThrow(() => checkSignedRelease({ dir: app.dir, version: V, assets: app.assets, keys: app.keys }));
  assert.throws(() => checkSignedRelease({ dir: app.dir, version: V, assets: app.assets, keys: [newKey().key] }), /passt nicht/, 'signature of another key');
  const build = release({ sign: ['sig2'] });
  assert.doesNotThrow(() => checkSignedRelease({ dir: build.dir, version: V, assets: build.assets, keys: build.keys, publishOnly: true, head: 'abc1234' }));
  assert.throws(() => checkSignedRelease({ dir: build.dir, version: V, assets: build.assets, keys: build.keys, publishOnly: true, head: 'def5678' }), /Commit/);
  fs.writeFileSync(path.join(build.dir, 'build-info.json'), JSON.stringify({ version: V, commit: 'abc1234', kind: 'developer', clean: true, channel: 'stable' }));
  assert.throws(() => checkSignedRelease({ dir: build.dir, version: V, assets: build.assets, keys: build.keys, publishOnly: true, head: 'abc1234' }), /Developer-Build/, 'a Developer build is never published');
  fs.writeFileSync(path.join(build.dir, 'build-info.json'), JSON.stringify({ version: V, commit: 'abc1234', kind: 'release', clean: true, channel: 'stable' }));
  assert.throws(() => checkSignedRelease({ dir: build.dir, version: V, assets: build.assets, keys: build.keys, publishOnly: true, head: 'abc1234', earlyAccess: true }), /Kanal/);
});

test('#442: the app signs once a security key stands in the list, not by the number of entries', async () => {
  const { appSignsWith } = await import('../scripts/release-check.mjs');
  const ed = { id: 'update-1', alg: 'ed25519', publicKey: 'x' };
  assert.equal(appSignsWith([ed]), false);
  assert.equal(appSignsWith([ed, { ...ed, id: 'update-2' }]), false, 'two software keys are no reason');
  assert.equal(appSignsWith([ed, { id: 'release-1', alg: 'es256', publicKey: 'y', credentialId: 'c' }]), true);
  assert.equal(appSignsWith([{ id: 'release-1', alg: 'es256', publicKey: 'y' }]), true);
  assert.equal(appSignsWith([]), false);
  assert.equal(appSignsWith(undefined), false);
});

test('#442: the old signature is written only while the list carries a software key', async () => {
  const { signsOldWith } = await import('../scripts/release-check.mjs');
  const ed = { id: 'update-1', alg: 'ed25519', publicKey: 'x' };
  const es = { id: 'release-1', alg: 'es256', publicKey: 'y', credentialId: 'c' };
  assert.equal(signsOldWith([ed, es]), true, 'stages 1 and 2');
  assert.equal(signsOldWith([es, { ...es, id: 'release-2' }]), false, 'stage 3: no .sig even if a PEM lies in the folder');
  assert.equal(signsOldWith([ed]), true);
  assert.equal(signsOldWith(undefined), false);
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8'), /signsOldWith\(UPDATE_KEYS\) && \(existsSync/);
});
