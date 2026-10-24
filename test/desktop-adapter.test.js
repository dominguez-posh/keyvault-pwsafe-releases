import { test } from 'node:test';
import assert from 'node:assert/strict';

// Fake native messaging port: answers every request with its own id, like the desktop bridge.
const sent = [];
let onMessage = null;
globalThis.chrome = {
  runtime: {
    connectNative: () => ({
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      onDisconnect: { addListener: () => {} },
      postMessage: (msg) => {
        sent.push(msg);
        const results = {
          hello: { version: 'test', opened: true },
          snapshot: { version: 'test', opened: true, containers: [{ id: 'kv-team', name: 'Team' }], summaries: [{ id: 'pws-1', containerId: 'kv-team', type: 'login', hosts: ['example.com'] }] },
        };
        setTimeout(() => onMessage({ id: msg.id, ok: true, result: results[msg.cmd] ?? { title: 'Eintrag', id: msg.itemId } }), 0);
      },
      disconnect: () => {},
    }),
    lastError: null,
  },
};

const { app, connect, snapshot, status } = await import('../extension/lib/desktop.js');
connect();
onMessage({ event: 'online' });

test('app client: item ID never overwrites the request number', async () => {
  const item = await app.getItem('kv-team.vault.azure.net', 'pws-123');
  assert.equal(item.title, 'Eintrag', 'the answer reaches the caller');
  const req = sent.find((m) => m.cmd === 'item');
  assert.equal(typeof req.id, 'number');
  assert.equal(req.itemId, 'pws-123');
  assert.equal(req.containerId, 'kv-team.vault.azure.net');
});

test('app client: one snapshot until the app reports a change', async () => {
  const count = () => sent.filter((m) => m.cmd === 'snapshot').length;
  const before = count();
  assert.equal((await app.containers())[0].kind, 'remote');
  assert.equal((await app.matchesForHost('example.com')).length, 1);
  assert.equal(count(), before + 1, 'containers and summaries share one request');
  onMessage({ event: 'changed' });
  await snapshot();
  assert.equal(count(), before + 2, 'a change loads a new snapshot');
});

test('app client: app not running – fails at once, recovers when it is back', async () => {
  onMessage({ event: 'offline' });
  const started = Date.now();
  await assert.rejects(app.getItem('kv-team', 'pws-1'), { name: 'AppOffline' });
  assert.ok(Date.now() - started < 1000, 'no waiting for a timeout');
  assert.equal((await status()).connected, false);
  onMessage({ event: 'online' });
  assert.deepEqual(await status(), { connected: true, version: 'test', opened: true });
});
