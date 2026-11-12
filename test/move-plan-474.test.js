// #474: the browser's moveWithAssets hands the plan it compared after the confirmation to moveWithAssets, which uses it
// with the versions it read instead of calculating a third one – a change after the check moves nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VaultSession, MemoryStore } from '../extension/core/session.js';
import { moveWithAssets, planMoveWithAssets } from '../extension/core/move-assets.js';
import { fakeKeyVault } from './fixtures/fake-keyvault.js';

const A = 'kv-a.vault.azure.net';

async function vault() {
  const kv = fakeKeyVault(A);
  const session = new VaultSession({ getToken: async (scope) => `token-${scope}`, store: new MemoryStore(), fetch: kv.fetch, actor: () => 'bob@contoso.com' });
  await session.refreshContainers({ configured: [{ name: 'A', vaultUrl: 'kv-a' }], discover: false });
  const login = await session.saveItem(A, { type: 'login', title: 'Admin', password: 'x', folder: 'Alt' });
  const vm = await session.saveItem(A, { type: 'server', title: 'VM01', folder: 'Alt', server: { kind: 'azurevm', rdpLink: `${A}/${login.id}` } });
  return { session, login, vm };
}

test('a confirmed plan is used as it is: an entry changed after the check stops the move, nothing moves', async () => {
  const { session, login, vm } = await vault();
  const plan = await planMoveWithAssets(session, A, A, login.id);
  // Changed between the check and the write (another client, the same person in a second window).
  await session.saveItem(A, { ...(await session.getItem(A, vm.id, { fresh: true })), notes: 'geändert' });
  await assert.rejects(moveWithAssets(session, A, A, login.id, { folder: 'Neu', expected: plan.order, plan }));
  for (const id of [login.id, vm.id]) assert.equal((await session.getItem(A, id, { fresh: true })).folder, 'Alt');
});

test('without a plan, moveWithAssets still calculates its own (the app path)', async () => {
  const { session, login, vm } = await vault();
  await moveWithAssets(session, A, A, login.id, { folder: 'Neu' });
  for (const id of [login.id, vm.id]) assert.equal((await session.getItem(A, id, { fresh: true })).folder, 'Neu');
});

test('the browser path passes the plan it compared after the confirmation', () => {
  const src = readFileSync(new URL('../desktop/browser-items.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('moveWithAssets: async (msg)'), src.indexOf('movePasskey: async'));
  assert.equal((body.match(/planMoveWithAssets\(/g) || []).length, 2, 'once for the card, once after the confirmation');
  assert.match(body, /moveWithAssets\(vault, fromId, toId, itemId, \{ \.\.\.folderOf\(msg\), expected, plan: checked \}\)/);
});
