// #413: the smoke area "offlinedelete" against the demo backend without Electron; a check that can't fail checks nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoBackend } from '../extension/core/demo.js';
import { VaultSession, MemoryStore } from '../extension/core/session.js';
import { offlineDeleteCheck } from '../desktop/smoke-offline.js';

test('offlinedelete passes on the demo backend and leaves no entry behind', async () => {
  const vault = new VaultSession({ getToken: async () => 'demo-token', store: new MemoryStore(), fetch: createDemoBackend().fetch, actor: () => 'alex@contoso.com' });
  await vault.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-pws-demo-team' }], discover: false, access: false });
  const [kvc] = await vault.containers();
  const online = vault.fetch;
  const errors = [];
  await offlineDeleteCheck({ vault, kvc, fail: (area, message) => errors.push(`${area}: ${message}`) });
  assert.deepEqual(errors, []);
  assert.equal(vault.fetch, online);
  await vault.refreshIndex();
  assert.deepEqual((await vault.summaries()).filter((s) => s.title.startsWith('Smoke Offline')), []);
});
