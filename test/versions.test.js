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

test('extension version claim (#347): plain numbers only, numeric order, missing or odd counts as outdated (hint only)', async () => {
  const { parseClientVersion, extensionOutdated } = await import('../desktop/versions.js');
  assert.equal(parseClientVersion('0.9.28'), '0.9.28');
  assert.equal(parseClientVersion('10'), '10');
  for (const bad of [undefined, null, 5, '', '0.9.28-beta', '1.2.3.4.5', '1..2', ' 1.2', '1.2\n', '9'.repeat(33), '<b>1</b>']) assert.equal(parseClientVersion(bad), null, String(bad));
  assert.equal(extensionOutdated('0.9.28'), true, 'passkeys are signed by the app from 0.9.29 on (#439)');
  assert.equal(extensionOutdated('0.9.29'), false);
  assert.equal(extensionOutdated('0.9.100'), false, 'numeric, not text order');
  assert.equal(extensionOutdated('0.9.26'), true);
  assert.equal(extensionOutdated('0.10.0'), false);
  assert.equal(extensionOutdated(undefined), true, 'an old extension reports nothing');
  assert.equal(extensionOutdated('garbage'), true);
});

test('extension status (#454): the four cases, MCP agents do not count', async () => {
  const { extensionStatus } = await import('../desktop/versions.js');
  const ok = { approved: true, origin: 'chrome-extension://abc/', extVersion: '0.9.29', minApp: '0.9.29' };
  assert.equal(extensionStatus([], '0.9.29').state, 'noConnection');
  assert.equal(extensionStatus([{ ...ok, origin: 'mcp:agent' }], '0.9.29').state, 'noConnection', 'an agent is no browser');
  assert.equal(extensionStatus([{ ...ok, approved: false }], '0.9.29').state, 'noConnection');
  assert.equal(extensionStatus([ok], '0.9.29').state, 'ok');
  const old = extensionStatus([{ ...ok, extVersion: '0.9.28' }], '0.9.29');
  assert.deepEqual([old.state, old.extVersion, old.minExtension], ['extensionOutdated', '0.9.28', '0.9.29']);
  assert.equal(extensionStatus([{ ...ok, extVersion: null }], '0.9.29').state, 'extensionOutdated');
  const app = extensionStatus([{ ...ok, minApp: '0.9.30' }], '0.9.29');
  assert.deepEqual([app.state, app.minApp], ['appOutdated', '0.9.30']);
  assert.equal(extensionStatus([{ ...ok, extVersion: '0.9.28' }, ok], '0.9.29').state, 'extensionOutdated');
});
