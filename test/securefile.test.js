import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault, parseFile } from '../extension/core/filevault.js';
import * as P from '../extension/core/protect.js';
import { canonical, verifyRoster } from '../extension/core/members.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

const prf = () => b64uEncode(randomBytes(32));
const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: prf(), label: name });

function memoryFile() {
  let text = null;
  return { io: { read: async () => text, write: async (s) => { text = s; } }, get text() { return text; }, set text(v) { text = v; } };
}

async function open(file, pk) {
  const v = new FileVault(file.io);
  await v.load();
  const r = await v.unlockWithPasskey(pk.credentialId, pk.prfOutput);
  return { v, r };
}

test('secured file: creator is admin, passkey only, request + approve, roles, signed changelog', async () => {
  const file = memoryFile();
  const alicePk = passkey('alice');
  const alice = await FileVault.createSecure(file.io, { name: 'Team', email: 'alice@contoso.com', passkey: alicePk });
  await alice.persist();
  assert.match(alice.id, /^file-[\w-]{22}$/);
  assert.equal(alice.role, 'admin');
  const doc = parseFile(file.text);
  assert.equal(doc.version, 2);
  assert.equal(JSON.stringify(doc.keyring).includes('"password"'), false, 'no password or recovery entries');

  await alice.addFolder(' Kunden / Contoso ');
  await alice.saveItem({ title: 'Contoso Admin', username: 'adm', password: 'pw1', folder: 'Kunden/Contoso' });
  assert.deepEqual(alice.folders(), ['Kunden/Contoso']);
  assert.equal(file.text.includes('Contoso'), false, 'folders and entries are encrypted');

  // Wrong passkey output: no access.
  await assert.rejects(open(file, { ...alicePk, prfOutput: prf() }), P.UnlockError);

  // Bob cannot request access while sharing is off.
  const bobPk = passkey('bob');
  const bobVault = new FileVault(file.io);
  await bobVault.load();
  await assert.rejects(bobVault.requestAccess({ email: 'bob@contoso.com', passkey: bobPk }), /Freigabe/);
  await alice.memberOp({ type: 'sharing', enabled: true });
  const req = await bobVault.requestAccess({ email: 'bob@contoso.com', passkey: bobPk });
  assert.match(req.safetyCode, /^\d{4} \d{4} \d{4} \d{4}$/);

  // Pending until an admin approves; both sides see the same safety code.
  const pending = await open(file, bobPk);
  assert.equal(pending.r.pending, true);
  assert.equal(pending.r.safetyCode, req.safetyCode);
  await alice.load();
  const view = await alice.describeMembers('localhost');
  const bobEntry = view.members.find((m) => m.email === 'bob@contoso.com');
  assert.equal(bobEntry.status, 'pending');
  assert.equal(bobEntry.safetyCode, req.safetyCode);
  await alice.memberOp({ type: 'approve', memberId: bobEntry.id, role: 'reader' });

  // Bob as reader: can read, cannot write.
  const bob = (await open(file, bobPk)).v;
  assert.equal(bob.role, 'reader');
  assert.equal(bob.summaries()[0].title, 'Contoso Admin');
  await assert.rejects(bob.saveItem({ title: 'Hack' }), /Leserechte/);

  // A forged edit by a reader (bypassing the app) is ignored by everybody.
  bob.role; // eslint-disable-line no-unused-expressions
  const forged = Object.create(bob);
  Object.defineProperty(forged, 'role', { value: 'editor' });
  await FileVault.prototype.saveItem.call(forged, { ...bob.getItem(bob.summaries()[0].id), password: 'evil' });
  await alice.load();
  assert.equal(alice.getItem(alice.summaries()[0].id).password, 'pw1', 'unauthorized version is skipped');
  assert.ok(alice.ignored >= 1);

  // Promote Bob to editor; his edits now count and are logged with changed fields.
  await alice.memberOp({ type: 'setRole', memberId: bobEntry.id, role: 'editor' });
  await bob.load();
  const item = bob.getItem(bob.summaries()[0].id);
  await bob.saveItem({ ...item, password: 'Zweites-Passwort-2' }, { expectedVersion: item.version });
  await alice.load();
  assert.equal(alice.getItem(item.id).password, 'Zweites-Passwort-2');
  assert.equal(alice.getItem(item.id).updatedBy, 'bob@contoso.com');
  const log = await alice.changelog();
  const update = log.find((e) => e.action === 'item-update' && e.email === 'bob@contoso.com' && e.trusted);
  assert.deepEqual(update.fields, ['password']);
  assert.ok(log.some((e) => e.action === 'member-approve' && e.target === 'bob@contoso.com'));
  assert.ok(log.some((e) => e.action === 'folder-create' && e.folder === 'Kunden/Contoso'));
  assert.equal(JSON.stringify(parseFile(file.text).log).includes('Zweites-Passwort-2'), false);

  // Tampering with a grant (Bob makes himself admin in the file) is rejected by the roster.
  const tampered = parseFile(file.text);
  const bobMember = tampered.keyring.members.find((m) => m.email === 'bob@contoso.com');
  bobMember.grants.push({ ...bobMember.grants.at(-1), role: 'admin', at: new Date().toISOString() });
  assert.equal((await verifyRoster(tampered.keyring)).current(bobMember.id).role, 'editor');

  // Replacing the creator key changes the file ID check.
  const swapped = parseFile(file.text);
  swapped.keyring.root = bobMember.sign;
  const copy = memoryFile();
  copy.text = JSON.stringify(swapped);
  await assert.rejects(new FileVault(copy.io).load(), /manipuliert/);

  // Second passkey (e.g. Windows Hello on this device) for Alice.
  const helloPk = { ...passkey('alice-hello'), platform: true };
  await alice.memberOp({ type: 'addCredential', passkey: helloPk });
  assert.equal((await open(file, helloPk)).v.role, 'admin');
  const mine = (await alice.describeMembers('localhost')).members.find((m) => m.me);
  assert.equal(mine.credentials.length, 2);

  // The last admin cannot leave, removing Bob rotates the key.
  await assert.rejects(alice.memberOp({ type: 'setRole', memberId: alice.memberId, role: 'editor' }), /mindestens einen Admin/);
  const kvBefore = parseFile(file.text).keyring.keyVersion;
  await alice.memberOp({ type: 'remove', memberId: bobEntry.id });
  assert.equal(parseFile(file.text).keyring.keyVersion, kvBefore + 1);
  await assert.rejects(open(file, bobPk), /entfernt/);
  // Bob's old session can no longer write.
  await assert.rejects(bob.saveItem({ title: 'after removal' }), /neu verschlüsselt|gesperrt|Leserechte/);
  // Alice (and her other passkey) still see everything after the key change, history included.
  const again = (await open(file, helloPk)).v;
  assert.equal(again.getItem(item.id).password, 'Zweites-Passwort-2');
  // History lists the forged version too, but it does not open.
  const versions = again.history(item.id);
  assert.equal(versions.length, 3);
  await assert.rejects(again.getVersion(item.id, versions[1].version), /Signatur/);
  assert.equal((await again.getVersion(item.id, versions[2].version)).password, 'pw1');
  assert.deepEqual(again.folders(), ['Kunden/Contoso']);
  assert.ok((await again.changelog()).some((e) => e.action === 'member-remove'));
  assert.ok((await again.changelog(item.id)).every((e) => e.itemId === item.id));
});

test('secured file: concurrent requests and edits merge; migration from format 1', async () => {
  const file = memoryFile();
  const adminPk = passkey('admin');
  const admin = await FileVault.createSecure(file.io, { name: 'Ops', email: 'admin@contoso.com', passkey: adminPk });
  await admin.persist();
  await admin.memberOp({ type: 'sharing', enabled: true });
  const a = new FileVault(file.io);
  const b = new FileVault(file.io);
  await a.load();
  await b.load();
  await a.requestAccess({ email: 'a@contoso.com', passkey: passkey('a') });
  await b.requestAccess({ email: 'b@contoso.com', passkey: passkey('b') });
  await admin.load();
  const pending = (await admin.describeMembers('localhost')).members.filter((m) => m.status === 'pending').map((m) => m.email).sort();
  assert.deepEqual(pending, ['a@contoso.com', 'b@contoso.com']);
  await admin.memberOp({ type: 'reject', memberId: (await admin.describeMembers('localhost')).members.find((m) => m.email === 'a@contoso.com').id });
  assert.equal((await admin.describeMembers('localhost')).members.some((m) => m.email === 'a@contoso.com'), false);

  // Format 1 → secured: password and recovery key stop working.
  const legacy = memoryFile();
  const { vault } = await FileVault.create(legacy.io, { name: 'Alt' });
  const setup = await P.setupKeyring(vault.id, { password: 'altes-passwort' });
  vault.doc.keyring = setup.keyring;
  await vault.unlock(setup.ck);
  await vault.saveItem({ title: 'Router', password: 'r1', folder: 'Netz' });
  await vault.addFolder('Leer');
  const pk = passkey('owner');
  const newId = await vault.migrateToSecure({ email: 'owner@contoso.com', passkey: pk });
  assert.notEqual(newId, setup.keyring.scope);
  const doc = parseFile(legacy.text);
  assert.equal(doc.version, 2);
  await assert.rejects(P.unlockWithPassword(doc.keyring, 'altes-passwort'));
  const reopened = (await open(legacy, pk)).v;
  assert.equal(reopened.summaries()[0].title, 'Router');
  assert.deepEqual(reopened.folders(), ['Leer']);
  assert.ok((await reopened.changelog()).some((e) => e.action === 'file-migrate'));
});

test('canonical JSON is key-order independent', () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
});

test('saving with a stale view of the file reports the conflict instead of overwriting', async () => {
  const file = memoryFile();
  const pk = passkey('alice');
  const a = await FileVault.createSecure(file.io, { name: 'Team', email: 'alice@contoso.com', passkey: pk });
  await a.persist();
  const item = await a.saveItem({ title: 'VPN', password: 'Erste-Version-1' });
  const b = (await open(file, pk)).v;
  const seenByB = b.getItem(item.id);
  // A changes the entry; B has not re-read the file since.
  await a.saveItem({ ...a.getItem(item.id), password: 'Zweite-Version-2' }, { expectedVersion: item.version });
  await assert.rejects(b.saveItem({ ...seenByB, password: 'Dritte-Version-3' }, { expectedVersion: seenByB.version }), (e) => e.name === 'ConflictError');
  assert.equal(b.getItem(item.id).password, 'Zweite-Version-2', 'B now sees the current version');
});

test('file logo is encrypted, survives key rotation and is logged', async () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const file = memoryFile();
  const pk = passkey('alice');
  const a = await FileVault.createSecure(file.io, { name: 'Kunde', email: 'alice@contoso.com', passkey: pk });
  await a.persist();
  await a.setLogo(PNG);
  assert.equal(file.text.includes('iVBOR'), false);
  assert.equal(await (await open(file, pk)).v.logo(), PNG);
  await a.rotateKey();
  await a.persist();
  assert.equal(await (await open(file, pk)).v.logo(), PNG);
  assert.ok((await a.changelog()).some((e) => e.action === 'logo-set'));
});
