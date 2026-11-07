import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOrgFile, orgPlaceTrusted, TRUSTED_SIDS } from '../desktop/org-file.js';

// #423: %ProgramData% lets standard users create folders and files. An organization file there counts only when only
// SYSTEM, Administrators or TrustedInstaller own and can change it and its folder; its values are enforced otherwise.

const SYSTEM = 'S-1-5-18';
const ADMINS = 'S-1-5-32-544';
const USER = 'S-1-5-21-1-2-3-1001';
const USERS = 'S-1-5-32-545';

function place(withFileBy) {
  const root = mkdtempSync(join(tmpdir(), 'kv423-'));
  mkdirSync(join(root, 'Keevault'));
  writeFileSync(join(root, 'Keevault', 'kvpwsafe.config.json'), JSON.stringify({ tenantId: withFileBy, mcpEnabled: true }));
  return root;
}
const where = (root) => ({ execPath: join(root, 'bin', 'Keevault.exe'), programData: root, appPath: join(root, 'app') });

test('owner and writers decide: only SYSTEM, Administrators and TrustedInstaller', () => {
  const ok = { owner: SYSTEM, writers: [SYSTEM, ADMINS] };
  assert.equal(orgPlaceTrusted({ file: ok, folder: { owner: ADMINS, writers: [ADMINS] } }), true);
  assert.equal(orgPlaceTrusted({ file: { owner: USER, writers: [USER] }, folder: ok }), false, 'file planted by a user');
  assert.equal(orgPlaceTrusted({ file: { owner: ADMINS, writers: [ADMINS, USERS] }, folder: ok }), false, 'users may change the file');
  assert.equal(orgPlaceTrusted({ file: ok, folder: { owner: USER, writers: [] } }), false, 'folder created by a user');
  assert.equal(orgPlaceTrusted({ file: ok, folder: { owner: SYSTEM, writers: [USERS] } }), false, 'users may replace the file');
  assert.equal(orgPlaceTrusted(null), false, 'unknown rights');
  assert.ok(TRUSTED_SIDS.includes(SYSTEM) && TRUSTED_SIDS.includes(ADMINS));
});

test('a ProgramData file with untrusted rights is ignored, a trusted one is used', () => {
  const root = place('evil');
  try {
    assert.deepEqual(readOrgFile(where(root), { security: () => ({ file: { owner: USER, writers: [USER] }, folder: { owner: USER, writers: [USER] } }) }), {});
    assert.equal(readOrgFile(where(root), { security: () => ({ file: { owner: SYSTEM, writers: [] }, folder: { owner: SYSTEM, writers: [] }, text: '{"tenantId":"evil"}' }) }).tenantId, 'evil');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real rights: a file the current user created is not taken (Windows, unelevated)', { skip: process.platform !== 'win32' }, () => {
  const root = place('mine');
  try {
    assert.deepEqual(readOrgFile(where(root)), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('next to the program and in the app folder nothing changes (only the installer or the developer write there)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv423-'));
  try {
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin', 'kvpwsafe.config.json'), JSON.stringify({ tenantId: 'beside' }));
    assert.equal(readOrgFile(where(root), { security: () => null }).tenantId, 'beside');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
