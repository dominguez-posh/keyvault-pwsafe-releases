import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as kdbxweb from 'kdbxweb';
import { decryptKdbx, isKdbx, keyFileHash } from '../desktop/kdbx.js';
import { parseImport } from '../extension/core/importer.js';

// kdbxweb (KeeWeb's library, dev dependency only) writes real databases; Keevault's own reader must open them.
kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
  const tag = crypto.argon2Sync(type === kdbxweb.Consts.KdfId.Argon2id || type === 2 ? 'argon2id' : 'argon2d', {
    message: Buffer.from(password), nonce: Buffer.from(salt), memory, passes: iterations, tagLength: length, parallelism,
  });
  return tag.buffer.slice(tag.byteOffset, tag.byteOffset + tag.byteLength);
});

const PV = (s) => kdbxweb.ProtectedValue.fromString(s);

async function makeDb({ password = 'Master-Pass-1', keyFile = null, version = 4, kdf = kdbxweb.Consts.KdfId.Argon2id, cipher = kdbxweb.Consts.CipherId.Aes } = {}) {
  const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(password == null ? null : PV(password), keyFile), 'Test');
  db.setVersion(version);
  if (version === 4) db.setKdf(kdf);
  db.header.dataCipherUuid = new kdbxweb.KdbxUuid(cipher);
  const root = db.getDefaultGroup();
  const web = db.createGroup(root, 'Web');
  const e = db.createEntry(web);
  e.fields.set('Title', 'Contoso Portal');
  e.fields.set('UserName', 'alice@contoso.com');
  e.fields.set('Password', PV('S3cret & <sicher> äöü'));
  e.fields.set('URL', 'https://portal.contoso.com');
  e.fields.set('Notes', 'Notiz');
  e.fields.set('PIN', PV('1234'));
  const second = db.createEntry(root);
  second.fields.set('Title', 'Router');
  second.fields.set('UserName', 'admin');
  second.fields.set('Password', PV('r0uter!'));
  // A history version: its protected values come first in the stream order and must not shift the others.
  e.pushHistory();
  e.fields.set('Password', PV('S3cret & <sicher> äöü'));
  return new Uint8Array(await db.save());
}

async function importOf(bytes, creds) {
  const parsed = await parseImport({ name: 'x.xml', text: await decryptKdbx(bytes, creds) });
  return Object.fromEntries(parsed.items.map((i) => [i.title, i]));
}

for (const [name, opts] of [
  ['KDBX 4, Argon2id, AES', {}],
  ['KDBX 4, Argon2d, ChaCha20', { kdf: kdbxweb.Consts.KdfId.Argon2d, cipher: kdbxweb.Consts.CipherId.ChaCha20 }],
  ['KDBX 4, AES-KDF, AES', { kdf: kdbxweb.Consts.KdfId.Aes }],
  ['KDBX 3.1, AES-KDF, Salsa20', { version: 3 }],
]) {
  test(`kdbx import: ${name} with master password`, async () => {
    const bytes = await makeDb(opts);
    assert.ok(isKdbx(bytes));
    const items = await importOf(bytes, { password: 'Master-Pass-1' });
    assert.equal(items['Contoso Portal'].password, 'S3cret & <sicher> äöü');
    assert.equal(items['Contoso Portal'].username, 'alice@contoso.com');
    assert.equal(items['Contoso Portal'].folder, 'Web');
    assert.equal(items['Contoso Portal'].fields.find((f) => f.name === 'PIN')?.value, '1234');
    assert.equal(items.Router.password, 'r0uter!');
    await assert.rejects(decryptKdbx(bytes, { password: 'wrong' }), (e) => e.code === 'key');
  });
}

test('kdbx import: key file only, and master password + key file', async () => {
  const keyFile = await kdbxweb.Credentials.createRandomKeyFile(2);
  const onlyKey = await makeDb({ password: null, keyFile });
  assert.equal((await importOf(onlyKey, { keyFile })).Router.password, 'r0uter!');
  await assert.rejects(decryptKdbx(onlyKey, { password: 'Master-Pass-1' }), (e) => e.code === 'key');
  const both = await makeDb({ keyFile, version: 3 });
  assert.equal((await importOf(both, { password: 'Master-Pass-1', keyFile })).Router.password, 'r0uter!');
  await assert.rejects(decryptKdbx(both, { password: 'Master-Pass-1' }), (e) => e.code === 'key');
  await assert.rejects(decryptKdbx(both, { keyFile }), (e) => e.code === 'key');
  await assert.rejects(decryptKdbx(both, {}), (e) => e.code === 'key');
});

test('kdbx: key file formats (XML 1.0/2.0, 32 bytes, 64 hex, other files hashed)', () => {
  const key = crypto.randomBytes(32);
  const hash = crypto.createHash('sha256').update(key).digest().subarray(0, 4).toString('hex').toUpperCase();
  const v2 = `<?xml version="1.0" encoding="utf-8"?><KeyFile><Meta><Version>2.0</Version></Meta><Key><Data Hash="${hash}">${key.toString('hex').toUpperCase().replace(/(.{8})/g, '$1 ')}</Data></Key></KeyFile>`;
  assert.deepEqual(keyFileHash(Buffer.from(v2)), key);
  const v1 = `<KeyFile><Meta><Version>1.00</Version></Meta><Key><Data>${key.toString('base64')}</Data></Key></KeyFile>`;
  assert.deepEqual(keyFileHash(Buffer.from(v1)), key);
  assert.deepEqual(keyFileHash(key), key);
  assert.deepEqual(keyFileHash(Buffer.from(key.toString('hex'))), key);
  const other = Buffer.from('any picture or certificate file');
  assert.deepEqual(keyFileHash(other), crypto.createHash('sha256').update(other).digest());
  assert.throws(() => keyFileHash(Buffer.from(v2.replace(hash, '00000000'))), /Schlüsseldatei/);
});
