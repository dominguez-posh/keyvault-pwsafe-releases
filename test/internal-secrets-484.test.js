// #484: the entry API never reaches the vault's own secrets (pws-keyring, pws-container, pws-policy, index …), whatever
// path asks: the session checks every entry ID centrally; MCP, IPC and the browser bridge only reach entries through it.
// And the diagnostics log never carries subscription IDs, GUIDs or UPNs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup } from './fixtures/fake-keyvault.js';
import { requireItemId, isInternalSecretName, newItemId } from '../extension/core/model.js';
import { McpService } from '../desktop/mcp.js';
import { maskLogText } from '../extension/core/log-mask.js';

const cid = 'kv-team.vault.azure.net';
const INTERNAL = ['pws-keyring', 'pws-container', 'pws-policy', 'pws-folders', 'pws-logo', 'pws-index', 'pws-index-00', 'pws-index-12', 'pws-KEYRING', 'PWS-keyring'];
const INVALID = /Ungültige Eintrags-ID/;

async function withInternals() {
  const s = await setup();
  const c = await s.session.container(cid);
  for (const name of ['pws-keyring', 'pws-container', 'pws-policy']) await s.session.kv(c).setSecret(name, `{"marker":"${name}"}`);
  const value = (name) => s.kv.secrets.get(name)?.at(-1)?.value;
  const snapshot = () => Object.fromEntries(['pws-keyring', 'pws-container', 'pws-policy'].map((n) => [n, [value(n), s.kv.secrets.get(n)?.length]]));
  return { ...s, snapshot };
}

test('entry IDs: the entry format passes, internal names and other names are refused', () => {
  for (const id of [newItemId(), 'pws-1', 'pws-abc', 'pws-9b7f40d8580b4b659a152517828cee80']) assert.equal(requireItemId(id), id);
  for (const id of INTERNAL) assert.throws(() => requireItemId(id), INVALID, id);
  for (const id of ['', 'pws-', 'keyring', 'kv-team', 'pws-a/b', 'pws-a b', '../pws-1', null, undefined, 42, {}, `pws-${'a'.repeat(200)}`]) {
    assert.throws(() => requireItemId(id), INVALID, String(id));
  }
  assert.ok(isInternalSecretName('pws-index-03'));
  assert.ok(!isInternalSecretName('pws-1'));
});

test('session: read, save, delete, trash and versions refuse internal secrets; nothing changes', async () => {
  const { session, snapshot } = await withInternals();
  const before = snapshot();
  for (const id of INTERNAL.slice(0, 3)) {
    await assert.rejects(session.getItem(cid, id, { fresh: true }), INVALID, `getItem ${id}`);
    await assert.rejects(session.readItem(cid, id), INVALID, `readItem ${id}`);
    await assert.rejects(session.saveItem(cid, { id, type: 'login', title: 'x', password: 'overwritten' }), INVALID, `saveItem ${id}`);
    await assert.rejects(session.deleteItem(cid, id), INVALID, `deleteItem ${id}`);
    await assert.rejects(session.purge(cid, id), INVALID, `purge ${id}`);
    await assert.rejects(session.restore(cid, id), INVALID, `restore ${id}`);
    await assert.rejects(session.history(cid, id), INVALID, `history ${id}`);
    await assert.rejects(session.moveItem(cid, cid, id), INVALID, `moveItem ${id}`);
    await assert.rejects(session.duplicateItem(cid, id), INVALID, `duplicateItem ${id}`);
  }
  assert.deepEqual(snapshot(), before, 'internal secrets unchanged');
});

test('session: ordinary entries are saved, changed, read and deleted as before', async () => {
  const { session } = await setup();
  const saved = await session.saveItem(cid, { type: 'login', title: 'Normal', password: 'p' });
  const again = await session.saveItem(cid, { ...saved, title: 'Normal 2' });
  assert.equal((await session.getItem(cid, again.id, { fresh: true })).title, 'Normal 2');
  await session.deleteItem(cid, again.id);
});

test('MCP: update_entry and get_entry with an internal secret as entryId are refused before any question', async () => {
  const { session, snapshot } = await withInternals();
  const before = snapshot();
  const asked = { read: 0, write: 0 };
  const mcp = new McpService({ admitted: () => true, policy: () => ({ write: true }), vault: () => session,
    confirmRead: async () => { asked.read++; return 'session'; },
    confirmWrite: async () => { asked.write++; return true; },
    audit: () => {},
  });
  const client = { agent: 'claude-ai' };
  mcp.connect(client);
  for (const entryId of ['pws-keyring', 'pws-container', 'pws-policy']) {
    await assert.rejects(mcp.call(client, 'update_entry', { vaultId: cid, entryId, title: 'x', password: 'overwritten' }), INVALID, entryId);
    await assert.rejects(mcp.call(client, 'get_entry', { vaultId: cid, entryId }), INVALID, entryId);
  }
  assert.equal(asked.write, 0, 'no confirmation dialog with an empty title');
  assert.deepEqual(snapshot(), before, 'internal secrets unchanged');
});

// IPC (api/items.js) and bridge (browser.js) need Electron: their source shows they reach entries only through the
// session's entry methods, never through a Key Vault client of their own.
for (const [name, file] of [['IPC', '../desktop/main/api/items.js'], ['bridge', '../desktop/main/browser.js'], ['MCP', '../desktop/mcp.js']]) {
  test(`${name}: entries only through the session's checked entry methods`, () => {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /\.(getSecret|setSecret|deleteSecret|purgeDeletedSecret|recoverDeletedSecret)\(/, `${name} talks to Key Vault directly`);
    assert.doesNotMatch(src, /\.kv\(/, `${name} takes a Key Vault client`);
  });
}

test('IPC save: the handler passes the item to vault.saveItem', () => {
  const src = readFileSync(new URL('../desktop/main/api/items.js', import.meta.url), 'utf8');
  assert.match(src, /save: async \(containerId, item, expectedVersion\) => \{[^}]*vault\.saveItem\(containerId, (await adminFlagsGuard\(containerId, )?item/); // #487: admin flags kept outside admin mode
});

test('diagnostics log: subscription ID, GUIDs and UPNs are masked, method, host and status stay', () => {
  const SUB = '11111111-2222-3333-4444-555555555555';
  const OBJ = '99999999-8888-7777-6666-000000000000';
  const lines = [
    `GET management.azure.com/subscriptions/${SUB}/resourceGroups/rg-x/providers/Microsoft.KeyVault/vaults/kv-x 403 1200ms`,
    `GET graph.microsoft.com/v1.0/users/max%40contoso.com/memberOf 404 80ms`,
    `PENDING TOKEN vault.azure.net tenant=${OBJ} >10000ms`,
    `rename failed: Der Client "max@contoso.com" mit der Objekt-ID ${OBJ} …`,
  ].map(maskLogText);
  const all = lines.join('\n');
  for (const leak of [SUB, OBJ, 'max@contoso.com', 'max%40contoso.com', '5555-555555555555']) assert.ok(!all.includes(leak), `leaks ${leak}`);
  assert.match(lines[0], /^GET management\.azure\.com\/subscriptions\/\*{8}\/resourceGroups\/rg-x\/.* 403 1200ms$/);
  assert.match(lines[2], /tenant=9999\*{4} /);
  // The log writer masks every line, whoever calls it.
  const diagSrc = readFileSync(new URL('../desktop/main/diag.js', import.meta.url), 'utf8');
  assert.match(diagSrc, /const line = maskLogText\(raw\);/);
});
