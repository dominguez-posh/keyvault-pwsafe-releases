import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPackage } from '@electron/asar';
import { verifyPackage } from '../scripts/verify-package.mjs';
import { kindFrom, stampCommit, isPackagedDir } from '../desktop/build-kind.js';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });

// The real verifyPackage path with a stamped package: the kind lives in package.json (never compared), no extra file.
test('verifyPackage accepts a package stamped through package.json (#445)', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-verify-repo-'));
  fs.mkdirSync(path.join(repo, 'desktop'));
  fs.writeFileSync(path.join(repo, 'desktop', 'a.js'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"x","version":"1.0.0"}\n');
  git(repo, 'init', '-q');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'c');
  const pack = (mutate) => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-verify-src-'));
    fs.cpSync(path.join(repo, 'desktop'), path.join(src, 'desktop'), { recursive: true });
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', kvBuild: { kind: 'release', commit: stampCommit('abc1234') } }));
    mutate?.(src);
    const asar = path.join(os.tmpdir(), `kv-verify-${Date.now()}-${Math.random().toString(16).slice(2)}.asar`);
    return createPackage(src, asar).then(() => asar);
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-verify-tmp-'));
  await verifyPackage(await pack(), repo, tmp);
  // A file git does not know (the old build-stamp.json) still stops the build.
  await assert.rejects(async () => verifyPackage(await pack((s) => fs.writeFileSync(path.join(s, 'desktop', 'build-stamp.json'), '{}')), repo, tmp), /nicht im Commit/);
  await assert.rejects(async () => verifyPackage(await pack((s) => fs.appendFileSync(path.join(s, 'desktop', 'a.js'), '//x\n')), repo, tmp), /weicht vom Commit ab/);
});

test('build kind: packaged builds never call git, no stamp means Developer without commit (#445)', () => {
  const boom = () => { throw new Error('git must not run'); };
  assert.deepEqual(kindFrom({ kind: 'release', commit: stampCommit('abc1234') }, { packaged: true, git: boom }), { developer: false, commit: '' });
  assert.deepEqual(kindFrom(undefined, { packaged: true, git: boom }), { developer: true, commit: '' });
  assert.deepEqual(kindFrom({ kind: 'developer', commit: stampCommit('abc1234def') }, { packaged: true, git: boom }), { developer: true, commit: 'abc1234' });
  assert.deepEqual(kindFrom(undefined, { packaged: false, git: () => 'f00ba12' }), { developer: true, commit: 'f00ba12' });
});

test('build kind: app.asar is recognised with Windows and POSIX separators (#461)', () => {
  assert.equal(isPackagedDir('C:\\Program Files\\Keevault\\resources\\app.asar\\desktop'), true);
  assert.equal(isPackagedDir('C:\\Program Files\\Keevault\\resources\\app.asar'), true);
  assert.equal(isPackagedDir('/Applications/Keevault.app/Contents/Resources/app.asar/desktop'), true);
  assert.equal(isPackagedDir('/opt/Keevault/resources/app.asar'), true);
  assert.equal(isPackagedDir('C:\\git\\keyvault-pwsafe\\desktop'), false);
  assert.equal(isPackagedDir('C:\\git\\app.asar.old\\desktop'), false);
  assert.equal(isPackagedDir('/home/u/src/desktop'), false);
});
