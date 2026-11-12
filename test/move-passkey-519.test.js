import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { movePasskeyBetween } from '../extension/core/move-assets.js';

// #519: moving a passkey across vaults follows the same rules as moving an entry.
function fakeSession(containers) {
  const items = new Map([
    ['shared/a', { id: 'a', type: 'login', version: 1, username: '', passkeys: [{ credentialId: 'c1', privateKey: 'PK', userName: 'u' }] }],
    ['shared/b', { id: 'b', type: 'login', version: 1, username: '', passkeys: [] }],
    ['personal/p', { id: 'p', type: 'login', version: 1, username: '', passkeys: [] }],
    ['other/o', { id: 'o', type: 'login', version: 1, username: '', passkeys: [] }],
  ]);
  return {
    items,
    container: async (id) => containers[id],
    getItem: async (c, id) => structuredClone(items.get(`${c}/${id}`)),
    saveItem: async (c, it) => { items.set(`${c}/${it.id}`, it); return it; },
  };
}
const CONTAINERS = {
  shared: { id: 'shared', name: 'Team', access: { write: true } },
  personal: { id: 'personal', name: 'Persönlich', personal: true },
  other: { id: 'other', name: 'Andere', access: { write: false } },
};

test('#519: a passkey from a shared vault does not move into the personal vault', async () => {
  const s = fakeSession(CONTAINERS);
  await assert.rejects(movePasskeyBetween(s, { from: { containerId: 'shared', id: 'a' }, to: { containerId: 'personal', id: 'p' }, credentialId: 'c1' }), /persönlichen Tresor/);
  assert.equal(s.items.get('personal/p').passkeys.length, 0);
  assert.equal(s.items.get('shared/a').passkeys.length, 1);
});

test('#519: no write access in the target vault refuses the move', async () => {
  const s = fakeSession(CONTAINERS);
  await assert.rejects(movePasskeyBetween(s, { from: { containerId: 'shared', id: 'a' }, to: { containerId: 'other', id: 'o' }, credentialId: 'c1' }), /Schreibrecht/);
  assert.equal(s.items.get('other/o').passkeys.length, 0);
});

test('#519: inside one vault the passkey still moves', async () => {
  const s = fakeSession(CONTAINERS);
  assert.equal(await movePasskeyBetween(s, { from: { containerId: 'shared', id: 'a' }, to: { containerId: 'shared', id: 'b' }, credentialId: 'c1' }), true);
  assert.equal(s.items.get('shared/b').passkeys.length, 1);
  assert.equal(s.items.get('shared/a').passkeys.length, 0);
});

test('#519: the window API checks the export lock before moving a passkey', () => {
  const src = fs.readFileSync(new URL('../desktop/main/api/items.js', import.meta.url), 'utf8');
  assert.match(src, /async movePasskey\(args\) \{\n\s*requireOpen\(\);\n\s*await checkLeaveToPersonal\(args\?\.from\?\.containerId, args\?\.to\?\.containerId\);/);
});
