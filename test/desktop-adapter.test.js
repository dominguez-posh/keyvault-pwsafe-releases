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
        const result = msg.cmd === 'hello' ? { version: 'test', opened: true } : { title: 'Eintrag', id: msg.itemId };
        setTimeout(() => onMessage({ id: msg.id, ok: true, result }), 0);
      },
      disconnect: () => {},
    }),
    lastError: null,
  },
};

test('desktop adapter: item ID never overwrites the request number', async () => {
  const { desktopAdapter } = await import('../extension/lib/desktop.js');
  const item = await desktopAdapter.getItem('kv-team.vault.azure.net', 'pws-123');
  assert.equal(item.title, 'Eintrag', 'the answer reaches the caller');
  const req = sent.find((m) => m.cmd === 'item');
  assert.equal(typeof req.id, 'number');
  assert.equal(req.itemId, 'pws-123');
  assert.equal(req.containerId, 'kv-team.vault.azure.net');
});
