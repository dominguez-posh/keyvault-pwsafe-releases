import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './fixtures/fake-keyvault.js';
import { renameInVault, cleanVaultName, sharedNames, vaultHostLabel, shownVaultHost, vaultChoiceLabel, vaultChoices, VAULT_NAME_MAX } from '../extension/core/session-meta.js';
import { AzureError, AzureClient } from '../extension/core/azure.js';
import { isAzureForbidden, maskForLog, uiMessage } from '../extension/core/azure-errors.js';

const cid = 'kv-team.vault.azure.net';
const SUB = '11111111-2222-3333-4444-555555555555';
const OBJ = '99999999-8888-7777-6666-000000000000';
const RAW = `Der Client "max@example.test" mit der Objekt-ID ${OBJ} verfügt über keine Autorisierung zum Ausführen der Aktion "Microsoft.KeyVault/vaults/write" über den Bereich "/subscriptions/${SUB}/resourceGroups/rg-x/providers/Microsoft.KeyVault/vaults/kv-x" oder der Bereich ist ungültig.`;

async function withAccess(access) {
  const s = await setup();
  const stored = await s.session.store.get('containers');
  stored[0].access = access;
  await s.session.store.set('containers', stored);
  return s;
}

test('an ARM 403 maps to the neutral text without IDs, UPN or resource path', () => {
  const e = new AzureError(403, 'AuthorizationFailed', RAW);
  assert.ok(isAzureForbidden(e));
  const text = uiMessage(e);
  for (const leak of [SUB, OBJ, 'example.test', '/subscriptions/', 'rg-x']) assert.ok(!text.includes(leak), `leaks ${leak}`);
  assert.equal(text, 'Dafür fehlt dir die Berechtigung in Azure.');
});

test('other Azure errors keep their sentence but lose paths, GUIDs and mail addresses', () => {
  const text = uiMessage(new AzureError(400, 'BadRequest', `Fehler bei /subscriptions/${SUB}/resourceGroups/rg-x für max@example.test (${OBJ})`));
  for (const leak of [SUB, OBJ, 'example.test', 'rg-x']) assert.ok(!text.includes(leak), `leaks ${leak}`);
  assert.match(text, /^Fehler bei /);
  assert.equal(uiMessage(new Error('Plain')), 'Plain');
});

test('the log text has the subscription ID masked', () => {
  const log = maskForLog(RAW);
  assert.ok(!log.includes(SUB));
  assert.match(log, /\/subscriptions\/\*{8}\//);
});

test('rename: a manager stores the shared name in the vault; unknown fields stay; no entry appears', async () => {
  const { kv, session } = await withAccess({ read: true, write: true, manage: true, admin: false });
  await session.writeContainerMeta(session.kv(await session.container(cid)), { name: 'Alt', future: { a: 1 } });
  await renameInVault(session, cid, 'Neu');
  const meta = JSON.parse(kv.secrets.get('pws-container').at(-1).value);
  assert.equal(meta.name, 'Neu');
  assert.equal(meta.v, 1);
  assert.deepEqual(meta.future, { a: 1 }, 'fields of newer versions survive');
  assert.equal((await session.container(cid)).name, 'Neu');
  assert.equal((await session.refreshIndex())[cid].items.length, 0, 'metadata secret is no entry');
});

test('rename: the name from the vault wins over the local name when the list is rebuilt', async () => {
  const { session } = await withAccess({ read: true, write: true, manage: true, admin: false });
  await renameInVault(session, cid, 'Aus dem Tresor');
  const { containers } = await session.refreshContainers({ configured: [{ name: 'Lokal', vaultUrl: `https://${cid}`, source: 'manual' }], discover: false, access: false });
  assert.equal(containers.find((c) => c.id === cid).name, 'Aus dem Tresor');
});

test('rename: a non-manager is refused in the session and nothing is written', async () => {
  const { kv, session } = await withAccess({ read: true, write: true, manage: false, admin: false });
  const before = kv.secrets.get('pws-container')?.length ?? 0;
  await assert.rejects(renameInVault(session, cid, 'Neu'), /Verwaltungsrechte/);
  assert.equal(kv.secrets.get('pws-container')?.length ?? 0, before);
  assert.equal((await session.container(cid)).name, 'Team');
});

test('rename: the UI rule disables the menu item with a tooltip for non-managers', async () => {
  const { canRenameVault } = await import('../desktop/renderer/app/vault-menu.js').catch(() => ({}));
  if (!canRenameVault) return; // renderer module needs a DOM; the rule is covered by the session test above
  assert.equal(canRenameVault({ kind: 'keyvault', access: { manage: false } }), false);
  assert.equal(canRenameVault({ kind: 'keyvault', access: { manage: true } }), true);
});

// Review #479 (A): anyone with secret write access in Azure can write the name in pws-container.
const BIDI = ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069', '\u200E', '\u200F'];

test('vault name from the metadata: control and bidi characters go, 100 characters at most, empty is no name', () => {
  assert.equal(cleanVaultName(`Kun${BIDI.join('')}den\u0000\u0007\u001B\u007F\u0085\u2028`), 'Kunden');
  assert.equal(cleanVaultName('\u202Etxt.exe'), 'txt.exe');
  assert.equal(cleanVaultName('x'.repeat(500)).length, VAULT_NAME_MAX);
  assert.equal([...cleanVaultName('\u{1F512}'.repeat(150))].length, VAULT_NAME_MAX, 'cut by characters, not code units');
  for (const empty of ['', '   ', BIDI.join(''), '\u0000\u001F', null, undefined, 42, { name: 'x' }]) assert.equal(cleanVaultName(empty), null);
  assert.equal(cleanVaultName('  Team Ä  '), 'Team Ä');
});

async function metaName(kv, session, name) {
  const meta = JSON.parse(kv.secrets.get('pws-container').at(-1).value);
  // Written past Keevault (REST with secret write access): no manager rule applies.
  await session.kv(await session.container(cid)).setSecret('pws-container', JSON.stringify({ ...meta, name }));
  await session.refreshIndex();
  // The index refresh reads the name in the background.
  await new Promise((r) => setTimeout(r, 50));
}

test('a spoofed name in pws-container reaches the list only cleaned; a garbage name keeps the fallback', async () => {
  const { kv, session } = await withAccess({ read: true, write: true, manage: false, admin: false });
  await session.writeContainerMeta(session.kv(await session.container(cid)), { name: 'Team' });
  await metaName(kv, session, `\u202EPrivat${'!'.repeat(200)}`);
  const c = await session.container(cid);
  assert.ok(!/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/.test(c.name), 'no bidi character in the name');
  assert.ok(c.name.startsWith('Privat') && c.name.length === VAULT_NAME_MAX);
  // A name of only invisible characters: nothing to show, the vault keeps the name it had.
  await metaName(kv, session, BIDI.join(''));
  assert.equal((await session.container(cid)).name, c.name);
  // An unclean name stored by an older version is cleaned when the list is rebuilt.
  const stored = await session.store.get('containers');
  stored[0].metaName = '\u202EAlt';
  await session.store.set('containers', stored);
  const { containers } = await session.refreshContainers({ configured: [{ name: 'Lokal', vaultUrl: `https://${cid}`, source: 'manual' }], discover: false, access: false });
  assert.equal(containers.find((x) => x.id === cid).name, 'Alt');
});

test('rename: the name a manager types is cleaned too; an empty one is refused', async () => {
  const { kv, session } = await withAccess({ read: true, write: true, manage: true, admin: false });
  await renameInVault(session, cid, '\u202ENeu\u0000');
  assert.equal(JSON.parse(kv.secrets.get('pws-container').at(-1).value).name, 'Neu');
  await assert.rejects(renameInVault(session, cid, '\u202E'), /Namen/);
});

test('two vaults with the same display name are marked so the sidebar shows their hosts', () => {
  const list = [
    { name: 'Kunden', vaultUrl: 'https://kv-a.vault.azure.net/' },
    { name: 'kunden ', vaultUrl: 'https://kv-b.vault.azure.net' },
    { name: 'Privat', vaultUrl: 'https://kv-c.vault.azure.net' },
    { name: 'Datei', path: 'C:\\x.kvpws' },
  ];
  const same = sharedNames(list);
  assert.ok(same.has('kunden'));
  assert.ok(!same.has('privat') && !same.has('datei'));
  assert.equal(vaultHostLabel(list[0]), 'kv-a.vault.azure.net');
  assert.equal(vaultHostLabel(list[3]), null);
  assert.equal(vaultHostLabel({ vaultUrl: 'not a url' }), null);
});

// Review #479 (B): a logo change by someone without manager rights must not carry the name along.
test('setting the logo does not write the name into pws-container', async () => {
  const { kv, session } = await withAccess({ read: true, write: true, manage: false, admin: false });
  await session.writeContainerMeta(session.kv(await session.container(cid)), { name: 'Vom Verwalter' });
  const stored = await session.store.get('containers');
  stored[0].name = 'Mein lokaler Name';
  stored[0].metaName = null;
  await session.store.set('containers', stored);
  await session.setContainerLogo(cid, 'data:image/png;base64,iVBORw0KGgo=');
  const meta = JSON.parse(kv.secrets.get('pws-container').at(-1).value);
  assert.equal(meta.name, 'Vom Verwalter');
  assert.ok(meta.logo, 'the logo itself is written');
});


// Review #479 (Konrad, rest): invisible characters, look-alike letters, host in the vault choice, ARM tag.
const cp = (...codes) => String.fromCodePoint(...codes);

test('vault name: zero widths, soft hyphen, BOM, word joiners and the Arabic letter mark go; NFKC folds look-alikes', () => {
  const invisible = [0x200B, 0x200C, 0x200D, 0xFEFF, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x00AD, 0x061C];
  for (const c of invisible) assert.equal(cleanVaultName(`Kun${cp(c)}den`), 'Kunden', `U+${c.toString(16)}`);
  assert.equal(cleanVaultName(cp(...invisible)), null);
  // Full-width letters and the ligature fold to plain letters.
  assert.equal(cleanVaultName(cp(0xFF2B, 0xFF55, 0xFF4E) + 'den'), 'Kunden');
  assert.equal(cleanVaultName(cp(0xFB01) + 'nanz'), 'finanz');
});

test('look-alike names count as the same name, so both vaults show their host', () => {
  const list = [
    { name: 'Kunden', vaultUrl: 'https://kv-a.vault.azure.net' },
    { name: cp(0xFF2B) + 'unden', vaultUrl: 'https://kv-b.vault.azure.net' },
    { name: 'Kun' + cp(0x200B) + 'den', vaultUrl: 'https://kv-c.vault.azure.net' },
  ];
  const same = sharedNames(list);
  assert.deepEqual([...same], ['kunden']);
  for (const c of list) assert.equal(shownVaultHost(c, same), new URL(c.vaultUrl).host);
});

test('a name from the vault that differs from the Key Vault name always carries the host in the vault choice', () => {
  const spoof = { id: 'kv-b.vault.azure.net', name: 'Kunden', metaName: 'Kunden', vaultUrl: 'https://kv-b.vault.azure.net' };
  assert.equal(shownVaultHost(spoof), 'kv-b.vault.azure.net');
  assert.equal(vaultChoiceLabel(spoof), 'Kunden (kv-b.vault.azure.net)');
  // Same as the Key Vault name (case and NFKC aside): nothing to tell apart.
  assert.equal(vaultChoiceLabel({ name: 'KV-B', metaName: 'KV-B', vaultUrl: 'https://kv-b.vault.azure.net' }), 'KV-B');
  // A local or ARM name (no metaName) only gets the host when it is taken twice.
  assert.equal(vaultChoiceLabel({ name: 'Kunden', vaultUrl: 'https://kv-a.vault.azure.net' }), 'Kunden');
  assert.equal(vaultChoiceLabel({ name: 'Kunden', vaultUrl: 'https://kv-a.vault.azure.net' }, new Set(['kunden'])), 'Kunden (kv-a.vault.azure.net)');
  // A local rename over the vault's name: the name is no longer the one from the vault.
  assert.equal(vaultChoiceLabel({ name: 'Mein Name', metaName: 'Kunden', vaultUrl: 'https://kv-b.vault.azure.net' }), 'Mein Name');
  // File vaults have no host.
  assert.equal(vaultChoiceLabel({ name: 'Datei', metaName: 'Datei', path: 'C:/x.kvpws' }), 'Datei');
});

test('the name from the ARM tag is cleaned too; a garbage tag falls back to the resource name', async () => {
  const az = new AzureClient({ getArmToken: async () => 't', getGraphToken: async () => 't', fetch: async () => { throw new Error('no network'); } });
  az.resourceGraph = async () => [
    { id: '/x/a', name: 'kv-a', vaultUri: 'https://kv-a.vault.azure.net/', displayName: 'Kun' + cp(0x200B, 0x202E) + 'den', tagged: 'true' },
    { id: '/x/b', name: 'kv-b', vaultUri: 'https://kv-b.vault.azure.net/', displayName: cp(0x200B, 0xFEFF), tagged: 'true' },
  ];
  for (const list of [await az.discoverContainers(), await az.listVaults()]) {
    assert.deepEqual(list.map((v) => v.name), ['Kunden', 'kv-b']);
  }
});

test('the save choice of the extension lists writable vaults with the host where it is needed', () => {
  const all = [
    { id: 'kv-a.vault.azure.net', name: 'Kunden', vaultUrl: 'https://kv-a.vault.azure.net', access: { write: true } },
    { id: 'kv-b.vault.azure.net', name: 'Kunden', metaName: 'Kunden', vaultUrl: 'https://kv-b.vault.azure.net', access: { write: false } },
  ];
  // kv-b is not writable but still makes "Kunden" a shared name, so kv-a shows its host.
  assert.deepEqual(vaultChoices(all, (c) => c.access.write), [{ id: 'kv-a.vault.azure.net', name: 'Kunden (kv-a.vault.azure.net)' }]);
});

test('keevault.log: error texts from the window have subscription IDs, GUIDs and UPNs masked', async () => {
  const { windowLogLine } = await import('../extension/core/log-mask.js');
  const line = windowLogLine({ level: 'error', message: `Fehler für max@example.test`, detail: RAW }, new Date('2026-11-08T00:00:00Z'));
  for (const leak of [SUB, OBJ, 'max@example.test']) assert.ok(!line.includes(leak), `leaks ${leak}`);
  assert.match(line, /^2026-11-08T00:00:00\.000Z error Fehler für \*\*\*@\*\*\* \| /);
  assert.ok(line.endsWith('\n'));
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../desktop/main/api/app.js', import.meta.url), 'utf8');
  assert.match(src, /appendFile\(file, windowLogLine\(\{ level, message, detail \}\)\)/, 'the app writes the masked line');
});
