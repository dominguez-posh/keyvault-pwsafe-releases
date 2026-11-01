import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The setup window's rollback (windows/Setup/Rollback.cs): a broken update is undone, a failed first installation
// leaves nothing behind. Runs the built helper (windows/out/Keevault-Update.exe) in a temporary folder.
const exe = fileURLToPath(new URL('../windows/out/Keevault-Update.exe', import.meta.url));

test('setup rollback: broken update restored, failed first install removed', { skip: process.platform !== 'win32' || !existsSync(exe) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-rollback-'));
  try {
    let code = 0;
    try { execFileSync(exe, ['--rollback-selftest', dir], { stdio: 'ignore', timeout: 30_000 }); } catch (e) { code = e.status ?? -1; }
    assert.equal(code, 0, `self-test step ${code} failed`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
