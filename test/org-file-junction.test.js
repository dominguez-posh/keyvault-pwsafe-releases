import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRights, readOrgFile } from '../desktop/org-file.js';

// #431 (Konrad): between checking the rights and reading, a user could turn a junction "Keevault" from the old, trusted
// folder to a folder of their own. The rights and the content come from one handle now, and a reparse point on the way
// is refused.

const win = process.platform === 'win32';

test('rights and content come from the same opened file', { skip: !win }, () => {
  const root = mkdtempSync(join(tmpdir(), 'kv431-'));
  try {
    const file = join(root, 'kvpwsafe.config.json');
    writeFileSync(file, JSON.stringify({ tenantId: 'ä-same-handle' }));
    const r = readRights(file);
    assert.ok(r?.file?.owner, 'rights read');
    assert.equal(JSON.parse(r.text).tenantId, 'ä-same-handle');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a junction in the way is refused, whatever it points to', { skip: !win }, () => {
  const root = mkdtempSync(join(tmpdir(), 'kv431-'));
  try {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'kvpwsafe.config.json'), JSON.stringify({ tenantId: 'via-junction' }));
    symlinkSync(join(root, 'real'), join(root, 'Keevault'), 'junction');
    assert.equal(readRights(join(root, 'Keevault', 'kvpwsafe.config.json')), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the content taken is the one checked: a trusted check without content takes nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'kv431-'));
  try {
    mkdirSync(join(root, 'Keevault'));
    writeFileSync(join(root, 'Keevault', 'kvpwsafe.config.json'), JSON.stringify({ tenantId: 'on-disk-now' }));
    const where = { execPath: join(root, 'bin', 'x.exe'), programData: root, appPath: join(root, 'app') };
    const trusted = { owner: 'S-1-5-18', writers: [] };
    assert.deepEqual(readOrgFile(where, { security: () => ({ file: trusted, folder: trusted }) }), {});
    assert.equal(readOrgFile(where, { security: () => ({ file: trusted, folder: trusted, text: '{"tenantId":"checked"}' }) }).tenantId, 'checked');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
