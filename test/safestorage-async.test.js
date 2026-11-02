import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Electron deprecates the synchronous safeStorage calls (they will be removed): only the async API is used.
test('desktop code uses only the async safeStorage API', () => {
  const dir = new URL('../desktop/', import.meta.url);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const src = readFileSync(new URL(name, dir), 'utf8');
    const sync = src.match(/safeStorage\.(encryptString|decryptString|isEncryptionAvailable)\b(?!Async)/g);
    assert.equal(sync, null, `${name}: ${sync}`);
  }
});
