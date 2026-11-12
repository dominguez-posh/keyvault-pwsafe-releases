// #485: a vault name from the ARM tag that differs from the Key Vault's own name shows the host, like a name from the
// vault's metadata (#479); the vault picker of the MCP approval uses the same label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shownVaultHost, vaultChoiceLabel } from '../extension/core/session-meta.js';
import { AzureClient } from '../extension/core/azure.js';

const KV_B = 'https://kv-b.vault.azure.net';

test('a name from the ARM tag that differs from the Key Vault name carries the host', () => {
  // Cyrillic "К" (U+041A) and "е": NFKC does not fold them, so only the host tells the vaults apart.
  const spoof = { id: 'kv-b.vault.azure.net', name: 'Кundеn', tagName: 'Кundеn', vaultUrl: KV_B };
  assert.equal(shownVaultHost(spoof), 'kv-b.vault.azure.net');
  assert.equal(vaultChoiceLabel(spoof), 'Кundеn (kv-b.vault.azure.net)');
  // The tag says the Key Vault's own name: nothing to tell apart.
  assert.equal(vaultChoiceLabel({ name: 'KV-B', tagName: 'kv-b', vaultUrl: KV_B }), 'KV-B');
  // A local name over the tag name: no longer the name from Azure.
  assert.equal(vaultChoiceLabel({ name: 'Mein Name', tagName: 'Kunden', vaultUrl: KV_B }), 'Mein Name');
  // Without a tag or metadata name, the host only for a name taken twice (unchanged).
  assert.equal(vaultChoiceLabel({ name: 'Kunden', vaultUrl: KV_B }), 'Kunden');
});

test('discovery marks the name that came from the tag; the resource name is no tag name', async () => {
  const az = new AzureClient({ getArmToken: async () => 't', getGraphToken: async () => 't', fetch: async () => { throw new Error('no network'); } });
  az.resourceGraph = async () => [
    { id: '/x/a', name: 'kv-a', vaultUri: 'https://kv-a.vault.azure.net/', displayName: 'Kunden', tagged: 'true' },
    { id: '/x/b', name: 'kv-b', vaultUri: `${KV_B}/`, displayName: '', tagged: 'true' },
  ];
  for (const list of [await az.discoverContainers(), await az.listVaults()]) {
    assert.deepEqual(list.map((v) => [v.name, v.tagName]), [['Kunden', 'Kunden'], ['kv-b', null]]);
  }
});

test('the tag name reaches the window and the extension', () => {
  const session = readFileSync(new URL('../extension/core/session.js', import.meta.url), 'utf8');
  assert.match(session, /tagName: cleanVaultName\(c\.tagName/);
  const browser = readFileSync(new URL('../desktop/main/browser.js', import.meta.url), 'utf8');
  assert.match(browser, /tagName: c\.tagName \|\| null/);
});

test('the MCP vault picker labels vaults with choiceName, not the bare name', () => {
  const src = readFileSync(new URL('../desktop/renderer/app/settings.js', import.meta.url), 'utf8');
  assert.ok(!/h\('option', \{ value: c\.id \}, c\.name\)/.test(src), 'no bare c.name in a vault option');
  assert.match(src, /h\('option', \{ value: c\.id \}, choiceName\(c\)\)/);
});
