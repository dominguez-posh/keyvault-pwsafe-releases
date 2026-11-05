import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Electron deprecates the synchronous safeStorage calls (they will be removed): only the async API is used.
test('desktop code uses only the async safeStorage API', () => {
  const dir = fileURLToPath(new URL('../desktop/', import.meta.url));
  // With the subfolders (main/, main/api/ …) – the main process is split into modules.
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
  const files = walk(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.some((f) => relative(dir, f).startsWith('main')), 'desktop/main/ is checked as well');
  for (const file of files) {
    const sync = readFileSync(file, 'utf8').match(/safeStorage\.(encryptString|decryptString|isEncryptionAvailable)\b(?!Async)/g);
    assert.equal(sync, null, `${relative(dir, file)}: ${sync}`);
  }
});
