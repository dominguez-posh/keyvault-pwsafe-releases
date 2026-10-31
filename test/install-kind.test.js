import test from 'node:test';
import assert from 'node:assert/strict';
import { detectInstallKind } from '../desktop/install-kind.js';

const win = { packaged: true, windowsStore: false, platform: 'win32' };

test('install kind: the EXE installation is recognised by its uninstaller, whatever the product name', () => {
  assert.equal(detectInstallKind({ ...win, filesNextToExe: ['Keevault.exe', 'Uninstall Keevault.exe', 'resources'] }), 'nsis');
  assert.equal(detectInstallKind({ ...win, filesNextToExe: ['Keevault.exe', 'Uninstall KeyVault PwSafe.exe'] }), 'nsis', 'older product name');
  assert.equal(detectInstallKind({ ...win, filesNextToExe: ['Keevault.exe', 'resources'] }), 'msi', 'no uninstaller → MSI');
  assert.equal(detectInstallKind({ ...win, windowsStore: true, filesNextToExe: ['Uninstall Keevault.exe'] }), 'msix');
  assert.equal(detectInstallKind({ ...win, platform: 'darwin', filesNextToExe: [] }), 'other');
  assert.equal(detectInstallKind({ ...win, packaged: false, filesNextToExe: ['Uninstall Keevault.exe'] }), 'dev');
});
