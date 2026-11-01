import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../desktop/versions.js';

test('update versions: numbers, and a pre-release below its release (Early Access)', () => {
  assert.equal(compareVersions('0.9.10', '0.9.9'), 1);
  assert.equal(compareVersions('0.9.7', '0.9.7'), 0);
  assert.equal(compareVersions('0.9.8-beta.1', '0.9.8'), -1);
  assert.equal(compareVersions('0.9.8', '0.9.8-beta.3'), 1);
  assert.equal(compareVersions('0.9.8-beta.2', '0.9.8-beta.10'), -1);
  assert.equal(compareVersions('0.9.8-beta.1', '0.9.7'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
});
