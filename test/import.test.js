import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseImport, parseCsv, applyCsvMapping, duplicateKey } from '../extension/core/importer.js';
import { SAMPLE_CSV } from '../extension/core/import-sample.js';
import { writeZip, readZip } from '../extension/core/zip.js';
import { parseXml } from '../extension/core/xml.js';
import { b64uEncode, b64uDecode, utf8 } from '../extension/core/util.js';

const csv = (text) => parseImport({ name: 'x.csv', text });

test('sample CSV in the repository equals the one offered in the app and imports completely', async () => {
  assert.equal(readFileSync(new URL('../samples/kvpwsafe-import-sample.csv', import.meta.url), 'utf8'), SAMPLE_CSV);
  const r = await csv(SAMPLE_CSV);
  assert.equal(r.format, 'generic-csv');
  assert.equal(r.items.length, 4);
  const [github, m365, bank, wlan] = r.items;
  assert.equal(github.totp.startsWith('otpauth://'), true);
  assert.equal(github.favorite, true);
  assert.match(github.notes, /mehrere Zeilen/);
  assert.deepEqual(m365.urls, ['https://login.microsoftonline.com', 'https://www.office.com']);
  assert.deepEqual(bank.fields, [{ name: 'PIN', value: '4711', hidden: true }]);
  assert.equal(wlan.type, 'note');
});

test('CSV flavors are recognized and mapped', async () => {
  const edge = await csv('name,url,username,password,note\r\nGitHub,https://github.com/,octo,"p,w""1",hi\r\n');
  assert.equal(edge.format, 'browser-csv');
  assert.equal(edge.items[0].password, 'p,w"1');

  const bw = await csv('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n' +
    'Work,1,login,Jira,,"PIN: 1234\nTeam: Ops",0,https://jira.example.com,bob,secret,JBSWY3DP\nWork,,note,Memo,Text,,0,,,,\n');
  assert.equal(bw.format, 'bitwarden-csv');
  assert.deepEqual(bw.items[0].fields.map((f) => f.name), ['PIN', 'Team']);
  assert.equal(bw.items[1].type, 'note');

  const kpx = await csv('"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"\n"Root/IT","Router","admin","x","192.168.0.1","","","0","2025","2025"\n');
  assert.equal(kpx.format, 'keepassxc-csv');
  assert.equal(kpx.items[0].folder, 'IT');
  assert.equal(kpx.items[0].fields.length, 0, 'Icon/Last Modified/Created are ignored');

  const kp = await csv('"Account","Login Name","Password","Web Site","Comments"\n"Mail","me","pw","mail.example.com","c"\n');
  assert.equal(kp.format, 'keepass-csv');
  assert.equal(kp.items[0].title, 'Mail');

  const op = await csv('Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nSlack,https://slack.com,me,pw,,true,false,work,\n');
  assert.equal(op.format, '1password-csv');
  assert.equal(op.items[0].folder, 'work');

  const ff = await csv('"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://a.example.com","u","p","","","{x}","1","1","1"\n');
  assert.equal(ff.format, 'firefox-csv');
  assert.equal(ff.items[0].title, 'a.example.com');

  const semi = await csv('Titel;Benutzername;Passwort;Website;Kundennummer\nA;u;p;a.example.com;42\n');
  assert.equal(semi.items[0].username, 'u');
  assert.deepEqual(semi.items[0].fields, [{ name: 'Kundennummer', value: '42', hidden: false }]);
  assert.equal(parseCsv('a;b\n1;2\n')[1][1], '2');
});

test('column mapping can be changed', async () => {
  const r = await csv('Bezeichnung,Login,Geheim,Sonstiges\nA,u,p,x\n');
  const mapping = [...r.csv.mapping];
  assert.deepEqual(mapping, ['title', 'username', 'field', 'field']);
  mapping[2] = 'password';
  mapping[3] = 'ignore';
  const [item] = applyCsvMapping(r.csv.columns, r.csv.rows, mapping);
  assert.equal(item.password, 'p');
  assert.equal(item.fields.length, 0);
});

test('KeePass XML incl. groups, recycle bin, protected fields, TOTP and KeePassXC passkeys', async () => {
  const xml = `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<KeePassFile><Meta><RecycleBinUUID>BIN</RecycleBinUUID></Meta><Root><Group><UUID>ROOT</UUID><Name>Datenbank</Name>
  <Entry><String><Key>Title</Key><Value>Mail &amp; Kalender</Value></String><String><Key>UserName</Key><Value>me</Value></String>
    <String><Key>Password</Key><Value Protected="True"> pw with spaces </Value></String><String><Key>URL</Key><Value>https://mail.example.com</Value></String>
    <String><Key>otp</Key><Value>otpauth://totp/x?secret=JBSWY3DP</Value></String><String><Key>PIN</Key><Value Protected="True">0815</Value></String>
    <History><Entry><String><Key>Title</Key><Value>old</Value></String></Entry></History></Entry>
  <Group><UUID>G1</UUID><Name>Server</Name><Entry><String><Key>Title</Key><Value>Router</Value></String><String><Key>Password</Key><Value>r</Value></String>
    <String><Key>TimeOtp-Secret-Base32</Key><Value>JBSWY3DP</Value></String></Entry>
    <Entry><String><Key>Title</Key><Value>Passkey-Site</Value></String><String><Key>KPEX_PASSKEY_CREDENTIAL_ID</Key><Value>${b64uEncode(utf8('cred'))}</Value></String>
    <String><Key>KPEX_PASSKEY_PRIVATE_KEY_PEM</Key><Value>-----BEGIN PRIVATE KEY-----
${btoa('pkcs8-bytes')}
-----END PRIVATE KEY-----</Value></String><String><Key>KPEX_PASSKEY_RELYING_PARTY</Key><Value>example.com</Value></String>
    <String><Key>KPEX_PASSKEY_USERNAME</Key><Value>me</Value></String></Entry></Group>
  <Group><UUID>BIN</UUID><Name>Papierkorb</Name><Entry><String><Key>Title</Key><Value>Deleted</Value></String></Entry></Group>
</Group></Root></KeePassFile>`;
  const r = await parseImport({ name: 'db.xml', text: xml });
  assert.equal(r.format, 'keepass-xml');
  assert.deepEqual(r.items.map((i) => i.title), ['Mail & Kalender', 'Router', 'Passkey-Site']);
  const [mail, router, pk] = r.items;
  assert.equal(mail.password, ' pw with spaces ');
  assert.deepEqual(mail.fields, [{ name: 'PIN', value: '0815', hidden: true }]);
  assert.equal(mail.totp, 'otpauth://totp/x?secret=JBSWY3DP');
  assert.equal(router.folder, 'Server');
  assert.match(router.totp, /^otpauth:\/\/totp\/Router\?secret=JBSWY3DP/);
  assert.equal(pk.passkeys[0].rpId, 'example.com');
  assert.equal(new TextDecoder().decode(b64uDecode(pk.passkeys[0].privateKey)), 'pkcs8-bytes');
  assert.throws(() => parseXml('<a><b></a>'), /XML/);
});

test('1Password 1PUX (ZIP) with login fields, TOTP, sections and archived items', async () => {
  const data = { accounts: [{ vaults: [{ attrs: { name: 'Privat' }, items: [
    { item: { categoryUuid: '001', favIndex: 1, state: 'active',
      overview: { title: 'Dropbox', url: 'https://dropbox.com', urls: [{ url: 'https://www.dropbox.com/login' }], tags: [] },
      details: { loginFields: [{ designation: 'username', value: 'me' }, { designation: 'password', value: 'pw' }], notesPlain: 'n',
        sections: [{ title: '', fields: [{ title: 'one-time password', value: { totp: 'otpauth://totp/d?secret=JBSWY3DP' } }, { title: 'PIN', value: { concealed: '1234' } }, { title: 'Mail', value: { email: { email_address: 'me@example.com' } } }] }] } } },
    { item: { categoryUuid: '003', state: 'active', overview: { title: 'Notiz' }, details: { notesPlain: 'geheim' } } },
    { item: { categoryUuid: '001', state: 'archived', overview: { title: 'Alt' }, details: {} } },
  ] }] }] };
  const zip = await writeZip([{ name: 'export.attributes', data: '{}' }, { name: 'export.data', data: JSON.stringify(data) }]);
  assert.equal((await readZip(zip)).size, 2);
  const r = await parseImport({ name: 'export.1pux', bytes: zip });
  assert.equal(r.format, '1password-1pux');
  assert.deepEqual(r.items.map((i) => i.title), ['Dropbox', 'Notiz']);
  const [dropbox, note] = r.items;
  assert.equal(dropbox.username, 'me');
  assert.equal(dropbox.totp, 'otpauth://totp/d?secret=JBSWY3DP');
  assert.deepEqual(dropbox.fields, [{ name: 'PIN', value: '1234', hidden: true }, { name: 'Mail', value: 'me@example.com', hidden: false }]);
  assert.equal(dropbox.favorite, true);
  assert.equal(dropbox.folder, 'Privat');
  assert.equal(note.type, 'note');
});

test('Bitwarden JSON with passkeys, card and collections', async () => {
  const data = {
    encrypted: false, folders: [], collections: [{ id: 'c1', name: 'Team' }],
    items: [
      { type: 1, name: 'Example', collectionIds: ['c1'], login: { username: 'alice', password: 'pw', uris: [{ uri: 'https://example.com' }],
        fido2Credentials: [{ credentialId: '7f6e5d4c-3b2a-1908-a7b6-c5d4e3f2a1b0', keyAlgorithm: 'ECDSA', keyCurve: 'P-256', keyValue: b64uEncode(utf8('k')), rpId: 'example.com', userHandle: b64uEncode(utf8('u')), counter: '0', discoverable: 'true' }] },
        fields: [{ name: 'Hidden', value: 'x', type: 1 }, { name: 'Linked', value: null, type: 3 }] },
      { type: 3, name: 'Visa', card: { cardholderName: 'A', number: '4111111111111111', code: '123' } },
      { type: 1, name: 'Gelöscht', deletedDate: '2025-01-01', login: {} },
    ],
  };
  const r = await parseImport({ name: 'bw.json', text: JSON.stringify(data) });
  assert.deepEqual(r.items.map((i) => i.title), ['Example', 'Visa']);
  assert.equal(r.items[0].folder, 'Team');
  assert.equal(b64uDecode(r.items[0].passkeys[0].credentialId).length, 16);
  assert.deepEqual(r.items[0].fields, [{ name: 'Hidden', value: 'x', hidden: true }]);
  assert.equal(r.items[1].type, 'note');
  assert.equal(r.items[1].fields.find((f) => f.name === 'Kartennummer').hidden, true);
  await assert.rejects(parseImport({ name: 'bw.json', text: JSON.stringify({ encrypted: true, items: [] }) }), /Verschlüsselte/);
});

test('duplicate key', () => {
  assert.equal(duplicateKey({ title: 'GitHub ', username: 'Octo', urls: ['https://www.github.com/login'] }), duplicateKey({ title: 'github', username: 'octo', hosts: ['github.com'] }));
});
