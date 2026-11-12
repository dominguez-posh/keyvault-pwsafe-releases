// Setup tool part e (#501): the updater against release folders built here like scripts/release.mjs does (the real
// pack script, SHA256SUMS.txt, latest.yml with kvSha256Sums, signed with a test key), the signature check against
// Node's crypto (Ed25519 and the hardware key's WebAuthn assertion), the drift and framework checks (in Run-Tests.ps1
// via setup-tool-501.test.js), the key list equal to the app's, and the package content. Windows only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { UPDATE_KEYS, signManifest, releaseChallenge } from '../desktop/update-verify.js';
import { zip } from '../scripts/zip.mjs';
import { releaseAssets } from '../scripts/release-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shells = process.platform !== 'win32' ? [] : ['powershell.exe', 'pwsh'].filter((s) =>
  spawnSync(s, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('setup tool: embedded update keys are the app\'s UPDATE_KEYS', () => {
  const keys = JSON.parse(readFileSync(join(root, 'setup-tool/KeevaultSetup/Data/update-keys.json'), 'utf8'));
  assert.deepEqual(keys, UPDATE_KEYS.map(({ id, alg, publicKey }) => ({ id, alg, publicKey })), 'setup-tool/KeevaultSetup/Data/update-keys.json an desktop/update-verify.js angleichen');
});

test('setup tool: the release uploads the package', () => {
  assert.ok(releaseAssets('1.2.3').includes('release/Keevault-Einrichtungstool-1.2.3.zip'));
  assert.match(readFileSync(join(root, 'scripts/release.mjs'), 'utf8'), /pack-setup-tool\.mjs/);
});

test('setup tool: the package holds only versioned files, never ignored local ones (keys, config)', () => {
  const planted = [join(root, 'setup-tool', 'kvpwsafe.config.json'), join(root, 'setup-tool', 'KeevaultSetup', 'ks-test-ignored.pem'), join(root, 'installer', 'policy', 'ks-test-ignored.pem')]
    .filter((f) => !existsSync(f));
  const out = mkdtempSync(join(tmpdir(), 'ks-pack-'));
  try {
    for (const f of planted) writeFileSync(f, 'nicht ins Paket');
    for (const f of planted) assert.equal(spawnSync('git', ['check-ignore', '-q', f], { cwd: root }).status, 0, `${f} ist nicht ignoriert`);
    const r = spawnSync(process.execPath, [join(root, 'scripts/pack-setup-tool.mjs'), `--out=${out}`, '--version=99.0.0'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const zipBytes = readFileSync(join(out, 'Keevault-Einrichtungstool-99.0.0.zip'));
    for (const name of ['kvpwsafe.config.json', 'ks-test-ignored.pem']) assert.equal(zipBytes.includes(Buffer.from(name)), false, `${name} im Paket`);
    for (const name of ['setup-tool/Keevault-Setup.ps1', 'setup-tool/policy/Keevault.admx', 'setup-tool/version.json', 'extension/styles/app.css']) {
      assert.ok(zipBytes.includes(Buffer.from(name)), `${name} fehlt im Paket`);
    }
    assert.equal(zipBytes.includes(Buffer.from('setup-tool/tests/')), false, 'Tests nicht im Paket');
  } finally {
    for (const f of planted) rmSync(f, { force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

/** WebAuthn assertion of a test P-256 key over the release challenge, like latest.yml.sig2 (desktop/update-verify.js). */
function assertion(manifest, key, { flags = 0x05, origin = 'http://localhost' } = {}) {
  const authData = Buffer.concat([crypto.createHash('sha256').update('localhost').digest(), Buffer.from([flags, 0, 0, 0, 1])]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: releaseChallenge(manifest), origin }));
  const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientDataJSON).digest()]), key);
  const b64 = (x) => Buffer.from(x).toString('base64');
  return JSON.stringify({ alg: 'es256', authData: b64(authData), clientDataJSON: b64(clientDataJSON), signature: b64(signature) });
}

test('setup tool: updater only takes a signed, listed, matching package into a new folder', { skip: !shells.length && 'PowerShell fehlt', timeout: 600_000 }, () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ks-upd-'));
  try {
    const ed = crypto.generateKeyPairSync('ed25519');
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const other = crypto.generateKeyPairSync('ed25519');
    const spki = (k) => k.export({ type: 'spki', format: 'der' }).toString('base64');
    const keys = [{ id: 'test-ed', alg: 'ed25519', publicKey: spki(ed.publicKey) }, { id: 'test-ec', alg: 'es256', publicKey: spki(ec.publicKey) }];
    const pack = (version, dir) => {
      const r = spawnSync(process.execPath, [join(root, 'scripts/pack-setup-tool.mjs'), `--out=${dir}`, `--version=${version}`], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return readFileSync(join(dir, `Keevault-Einrichtungstool-${version}.zip`));
    };
    const release = (name, version, { zipBytes, signWith = 'ed', alterYml, alterSums, alterZip } = {}) => {
      const dir = join(tmp, name);
      mkdirSync(dir, { recursive: true });
      const pkg = `Keevault-Einrichtungstool-${version}.zip`;
      const z = zipBytes || pack(version, dir);
      writeFileSync(join(dir, pkg), z);
      const sums = Buffer.from(`${sha256(Buffer.from('setup'))}  Keevault-Setup-${version}.exe\n${sha256(z)}  ${pkg}\n`);
      writeFileSync(join(dir, 'SHA256SUMS.txt'), alterSums ? Buffer.concat([sums, Buffer.from('x')]) : sums);
      const yml = Buffer.from(`version: ${version}\npath: Keevault-Setup-${version}.exe\nkvSha256Sums: ${sha256(sums)}\n`);
      if (signWith === 'ed') writeFileSync(join(dir, 'latest.yml.sig'), signManifest(yml, ed.privateKey));
      if (signWith === 'other') writeFileSync(join(dir, 'latest.yml.sig'), signManifest(yml, other.privateKey));
      if (signWith === 'ec') writeFileSync(join(dir, 'latest.yml.sig2'), assertion(yml, ec.privateKey));
      writeFileSync(join(dir, 'latest.yml'), alterYml ? Buffer.from(yml.toString().replace(version, '98.0.0')) : yml);
      if (alterZip) writeFileSync(join(dir, pkg), Buffer.concat([z, Buffer.from('changed')]));
      return dir;
    };
    const a = pack('99.0.0', join(tmp, 'build-a'));
    release('a', '99.0.0', { zipBytes: a });
    release('b', '99.1.0', { signWith: 'ec' });
    release('badsig', '99.1.0', { alterYml: true });
    release('otherkey', '99.1.0', { signWith: 'other' });
    release('badsums', '99.1.0', { alterSums: true });
    release('badzip', '99.1.0', { alterZip: true });
    const slip = zip([{ name: 'setup-tool/version.json', data: Buffer.from('{"version":"99.1.0"}') }, { name: 'setup-tool/../../evil.txt', data: Buffer.from('x') }]);
    release('slip', '99.1.0', { zipBytes: slip });
    // Single signatures for the PowerShell check of both algorithms.
    const msg = Buffer.from('version: 1.0.0\n');
    const vectors = {
      msg: msg.toString('base64'),
      ed: signManifest(msg, ed.privateKey),
      ec: assertion(msg, ec.privateKey),
      ecBackedUp: assertion(msg, ec.privateKey, { flags: 0x05 | 0x18 }),
      ecNoPin: assertion(msg, ec.privateKey, { flags: 0x01 }),
      ecOrigin: assertion(msg, ec.privateKey, { origin: 'https://evil.example' }),
      // Raw Ed25519 over the one byte 0x00 and over the empty message (Konrad: 0x00 must not count as empty).
      zeroPub: ed.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64'),
      zeroSig: crypto.sign(null, Buffer.from([0]), ed.privateKey).toString('base64'),
      emptySig: crypto.sign(null, Buffer.alloc(0), ed.privateKey).toString('base64'),
    };
    writeFileSync(join(tmp, 'keys.json'), JSON.stringify(keys));
    writeFileSync(join(tmp, 'vectors.json'), JSON.stringify(vectors));
    for (const shell of shells) {
      const work = join(tmp, `work-${shell.replace(/\W/g, '')}`);
      mkdirSync(work);
      const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'setup-tool/tests/Update-Tests.ps1'), '-Root', tmp, '-Work', work],
        { encoding: 'utf8', timeout: 300_000 });
      const lines = (r.stdout || '').split(/\r?\n/).filter((l) => /^(PASS|FAIL) /.test(l));
      assert.ok(lines.length >= 7, `${shell}: zu wenige Szenarien\n${r.stdout}\n${r.stderr}`);
      const failed = lines.filter((l) => l.startsWith('FAIL'));
      assert.deepEqual(failed, [], `${shell}:\n${failed.join('\n')}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
