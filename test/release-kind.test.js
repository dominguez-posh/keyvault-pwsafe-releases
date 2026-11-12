import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { isReleaseRun } from '../scripts/release-kind.mjs';

test('release.mjs: only an explicit release option makes a release build (#445)', () => {
  assert.equal(isReleaseRun([]), false);
  assert.equal(isReleaseRun(['--previews']), false);
  for (const f of ['--early-access', '--publish', '--publish-only', '--hotfix', '--release']) assert.equal(isReleaseRun([f]), true, f);
  assert.equal(isReleaseRun(['--publish', '--early-access']), true);
});

// The workflow stays in the private repo; the public export has no copy (#524).
test('the Early Access workflow still builds a release', { skip: !existsSync(new URL('../.github/workflows/early-access.yml', import.meta.url)) && 'private workflow' }, () => {
  const yml = readFileSync(new URL('../.github/workflows/early-access.yml', import.meta.url), 'utf8');
  const m = yml.match(/node scripts\/release\.mjs([^\r\n]*)/);
  assert.ok(m && isReleaseRun(m[1].trim().split(/\s+/)), 'early-access.yml runs release.mjs without a release option');
});
