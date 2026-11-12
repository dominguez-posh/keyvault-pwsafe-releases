// #482: an entry stored without a creator keeps it empty – the next editor does not become its creator and so cannot
// set it to "Nur für mich" (only a Verwalter can then).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VaultSession, MemoryStore } from '../extension/core/session.js';
import { serializeItem } from '../extension/core/model.js';
import { mayMakePrivate } from '../extension/core/private.js';
import { fakeKeyVault } from './fixtures/fake-keyvault.js';

const CID = 'kv-team.vault.azure.net';

async function member(kv, who) {
  const s = new VaultSession({ getToken: async (scope) => `token-${scope}`, store: new MemoryStore(), fetch: kv.fetch, actor: () => who, viewer: () => `oid-${who}` });
  await s.refreshContainers({ configured: [{ name: 'Team', vaultUrl: 'kv-team' }], discover: false });
  return s;
}

test('model: an existing entry never gets the actor as its creator, a new one does', () => {
  assert.equal(serializeItem({ title: 'Neu' }, 'bob@contoso.com').doc.createdBy, 'bob@contoso.com');
  assert.equal(serializeItem({ title: 'Alt' }, 'bob@contoso.com', { existing: true }).doc.createdBy, undefined);
  assert.equal(serializeItem({ title: 'Alt', createdBy: 'alice@contoso.com' }, 'bob@contoso.com', { existing: true }).doc.createdBy, 'alice@contoso.com');
});

test('session: an entry without creator stays without one, whatever the editor sends', async () => {
  const kv = fakeKeyVault(CID);
  const old = await member(kv, ''); // e.g. an entry from before createdBy, or written outside Keevault
  const e = await old.saveItem(CID, { title: 'Firewall', password: 'fw' });
  assert.equal((await old.getItem(CID, e.id, { fresh: true })).createdBy, '');
  const bob = await member(kv, 'bob@contoso.com');
  await bob.refreshIndex();
  await bob.saveItem(CID, { ...(await bob.getItem(CID, e.id)), notes: 'geändert' });
  let after = await bob.getItem(CID, e.id, { fresh: true });
  assert.equal(after.createdBy, '', 'a plain edit does not make the editor the creator');
  await bob.saveItem(CID, { ...after, createdBy: 'bob@contoso.com' });
  after = await bob.getItem(CID, e.id, { fresh: true });
  assert.equal(after.createdBy, '', 'nor a creator sent along with the edit');
  assert.equal(mayMakePrivate(after, 'bob@contoso.com'), false);
  assert.equal(mayMakePrivate(after, 'bob@contoso.com', true), true, 'a Verwalter still can');
});

test('session: a known creator stays the one stored', async () => {
  const kv = fakeKeyVault(CID);
  const alice = await member(kv, 'alice@contoso.com');
  const e = await alice.saveItem(CID, { title: 'Router' });
  const bob = await member(kv, 'bob@contoso.com');
  await bob.refreshIndex();
  await bob.saveItem(CID, { ...(await bob.getItem(CID, e.id)), notes: 'x' });
  assert.equal((await bob.getItem(CID, e.id, { fresh: true })).createdBy, 'alice@contoso.com');
});
