import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfflineMirror, OfflineError, isNetworkError } from '../desktop/offline.js';

// Stand-in for the OS key store: reversible, so the tests run without Electron.
const protect = (b) => Buffer.from(b).map((x) => x ^ 0x5a);
const unprotect = (b) => Buffer.from(b).map((x) => x ^ 0x5a);
const mirror = (dir) => new OfflineMirror({ dir, protect, unprotect, now: () => 1_700_000_000_000 });

const vault = 'https://kv-team.vault.azure.net';
const fakeFetch = async (url, init = {}) => {
  if ((init.method || 'GET') !== 'GET') return new Response('{}', { status: 200 });
  if (String(url).includes('/secrets?')) return new Response(JSON.stringify({ value: [{ id: `${vault}/secrets/a` }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ value: 'secret-value' }), { status: 200, headers: { 'content-type': 'application/json' } });
};

test('offline mirror: records GETs, replays them after a PIN unlock, refuses writes and wrong PINs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-offline-'));
  try {
    const m = mirror(dir);
    const fetch = m.record(fakeFetch);
    // Without the key nothing is recorded (the user has not entered the PIN yet).
    await fetch(`${vault}/secrets?api-version=7.4`);
    assert.equal(m.entries.size, 0);
    await m.unlockKey('1234');
    const list = await (await fetch(`${vault}/secrets?api-version=7.4`)).json();
    assert.equal(list.value.length, 1, 'the real answer passes through');
    await fetch(`${vault}/secrets/a/?api-version=7.4`);
    await fetch(`${vault}/secrets/a?api-version=7.4`, { method: 'PUT', body: '{}' });
    await fetch('https://management.azure.com/subscriptions?api-version=2020-01-01');
    assert.equal(m.entries.size, 2, 'only Key Vault GETs are kept');
    m.setContainers([{ kind: 'keyvault', name: 'Team', vaultUrl: vault }, { kind: 'file', name: 'x' }]);
    assert.ok(await m.save());

    // A fresh process: PIN → key → mirror readable.
    const again = mirror(dir);
    await assert.rejects(again.load(), OfflineError);
    await again.unlockKey('1234');
    const info = await again.load();
    assert.deepEqual([info.entries, info.containers, info.at], [2, 1, 1_700_000_000_000]);
    const replayed = await (await again.replay(`${vault}/secrets/a/?api-version=7.4`)).json();
    assert.equal(replayed.value, 'secret-value');
    await assert.rejects(again.replay(`${vault}/secrets/a?api-version=7.4`, { method: 'PUT' }), /Offline/);
    await assert.rejects(again.replay(`${vault}/secrets/unknown/?api-version=7.4`), /Offline/);

    // Wrong PIN: the GCM tag fails, nothing leaks.
    const wrong = mirror(dir);
    await wrong.unlockKey('9999');
    await assert.rejects(wrong.load(), /PIN/);

    // PIN change re-encrypts; removal leaves nothing behind.
    await again.rekey('1234', '5678');
    const changed = mirror(dir);
    await changed.unlockKey('5678');
    assert.equal((await changed.load()).entries, 2);
    await changed.remove();
    assert.equal(await changed.exists(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('network errors are told apart from refused sign-ins', () => {
  assert.ok(isNetworkError(new Error('getaddrinfo ENOTFOUND login.microsoftonline.com')));
  assert.ok(isNetworkError({ errorCode: 'network_error', message: 'Network request failed' }));
  assert.ok(isNetworkError(new TypeError('fetch failed')));
  assert.ok(!isNetworkError({ errorCode: 'interaction_required', message: 'AADSTS50076' }));
  assert.ok(!isNetworkError(new Error('user_cancelled')));
});
