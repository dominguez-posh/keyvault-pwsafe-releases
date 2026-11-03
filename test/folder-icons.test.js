import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFolderIcon, keepassIcon, moveFolderIcons, FOLDER_ICONS } from '../extension/core/folder-icons.js';
import { parseImport } from '../extension/core/importer.js';
import { FileVault, parseFile, mergeDocs } from '../extension/core/filevault.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function memoryFile() {
  let text = null;
  return { io: { read: async () => text, write: async (s) => { text = s; } }, get text() { return text; }, set text(v) { text = v; } };
}
const passkey = () => ({ credentialId: `cred-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: 'pk' });

test('folder symbols: own names, small raster images only, plain folder otherwise', () => {
  assert.equal(normalizeFolderIcon('server'), 'server');
  assert.equal(normalizeFolderIcon('folder'), '', 'the plain folder is no stored symbol');
  assert.equal(normalizeFolderIcon('nope'), '');
  assert.equal(normalizeFolderIcon(PNG), PNG);
  assert.equal(normalizeFolderIcon('data:image/svg+xml;base64,PHN2Zz4='), '', 'no SVG (could carry script)');
  assert.equal(normalizeFolderIcon(`data:image/png;base64,${'A'.repeat(7000)}`), '', 'too big for the folder list');
  // Every KeePass standard icon maps to a symbol the picker offers (or the plain folder).
  for (let id = 0; id <= 68; id++) assert.ok(!keepassIcon(id) || FOLDER_ICONS.includes(keepassIcon(id)), `IconID ${id}`);
  assert.equal(keepassIcon(48), '', 'KeePass folder icon = plain folder');
  assert.equal(keepassIcon(3), 'server');
  assert.deepEqual(moveFolderIcons({ Kunden: 'users', 'Kunden/Contoso': 'home', Intern: 'lock' }, 'Kunden', 'Partner'),
    { Kunden: '', Partner: 'users', 'Kunden/Contoso': '', 'Partner/Contoso': 'home' });
});

test('KeePass import takes the group symbols along: standard icons and own images, root and recycle bin left out', async () => {
  const data = PNG.split(',')[1];
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<KeePassFile><Meta><RecycleBinUUID>BIN</RecycleBinUUID><CustomIcons><Icon><UUID>CI1</UUID><Data>${data}</Data></Icon></CustomIcons></Meta>
<Root><Group><UUID>ROOT</UUID><Name>Datenbank</Name><IconID>49</IconID>
  <Group><UUID>G1</UUID><Name>Server</Name><IconID>3</IconID><Entry><String><Key>Title</Key><Value>Router</Value></String></Entry>
    <Group><UUID>G2</UUID><Name>Kunde</Name><IconID>0</IconID><CustomIconUUID>CI1</CustomIconUUID><Entry><String><Key>Title</Key><Value>VPN</Value></String></Entry></Group></Group>
  <Group><UUID>G3</UUID><Name>Ablage</Name><IconID>48</IconID><Entry><String><Key>Title</Key><Value>Notiz</Value></String></Entry></Group>
  <Group><UUID>BIN</UUID><Name>Papierkorb</Name><IconID>43</IconID></Group>
</Group></Root></KeePassFile>`;
  const r = await parseImport({ name: 'db.xml', text: xml });
  assert.deepEqual(r.folderIcons, { Server: 'server', 'Server/Kunde': PNG });
});

test('file vault: folder symbols and app settings encrypted, merged by time, symbols dropped with the folder', async () => {
  const file = memoryFile();
  const pk = passkey();
  const v = await FileVault.createSecure(file.io, { name: 'Persönlich', email: 'alice@contoso.com', passkey: pk });
  await v.persist();
  await v.addFolder('Kunden/Contoso');
  await v.setFolderIcons({ Kunden: 'users', 'Kunden/Contoso': PNG });
  assert.deepEqual(v.folderIcons(), { Kunden: 'users', 'Kunden/Contoso': PNG });
  await v.setFolderIcons({ Kunden: 'briefcase' });
  assert.equal(v.folderIcons().Kunden, 'briefcase', 'a new symbol replaces the old one');
  await v.setAppSettings({ theme: 'dark', containers: [{ name: 'Team', vaultUrl: 'https://kv-team.vault.azure.net' }] }, 1000);
  assert.equal(file.text.includes('briefcase') || file.text.includes('kv-team') || file.text.includes('dark'), false, 'symbols and settings are encrypted');

  // Another instance (other device) reads both.
  const other = new FileVault(file.io);
  await other.load();
  await other.unlockWithPasskey(pk.credentialId, pk.prfOutput);
  assert.equal(other.folderIcons().Kunden, 'briefcase');
  assert.deepEqual((await other.appSettings()).value.theme, 'dark');
  assert.equal((await other.appSettings()).updated, 1000);

  // Newer settings win the merge with the file on disk, older ones do not overwrite.
  await other.setAppSettings({ theme: 'light' }, 2000);
  const stale = parseFile(file.text);
  stale.appSettings = { ...stale.appSettings, updated: 500 };
  assert.equal(mergeDocs(parseFile(file.text), stale).appSettings.updated, 2000);

  await other.removeFolder('Kunden');
  assert.deepEqual(other.folderIcons(), {}, 'deleting the folder drops its symbols');
});
