// #539 Etappe 8: member identity at the app's master password (member key MK) – core counter-tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileVault, parseFile } from '../extension/core/filevault.js';
import { mergeSecureKeyrings, secureCredentials, unlockSecure } from '../extension/core/members.js';
import { newMemberKey, appTag, isAppCredential } from '../extension/core/member-app.js';
import { replacedBy } from '../extension/core/members-mp.js';
import { replaceOwnIdentity } from '../extension/core/filevault-mp.js';
import { floorOf, mergeFloors } from '../extension/core/rollback.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

const prf = () => b64uEncode(randomBytes(32));
const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: prf(), label: name });

function memoryFile() {
  let text = null;
  return { io: { read: async () => text, write: async (s) => { text = s; } }, get text() { return text; }, set text(v) { text = v; } };
}

async function openApp(file, mk) {
  const v = new FileVault(file.io);
  await v.load();
  const r = await v.unlockWithPasskey(null, null, { mk });
  return { v, r };
}

async function teamWithBob() {
  const file = memoryFile();
  const aliceMk = newMemberKey();
  const alice = await FileVault.createSecure(file.io, { name: 'Team', email: 'alice@contoso.com', mk: aliceMk });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const bobMk = newMemberKey();
  const bobV = new FileVault(file.io);
  await bobV.load();
  const req = await bobV.requestAccess({ email: 'bob@contoso.com', mk: bobMk });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'editor' });
  return { file, alice, aliceMk, bobMk, bobId: req.memberId };
}

test('create and open a secured file with the member key only (no passkey)', async () => {
  const file = memoryFile();
  const mk = newMemberKey();
  const v = await FileVault.createSecure(file.io, { name: 'Team', email: 'alice@contoso.com', mk });
  await v.saveItem({ title: 'Router', password: 'geheim-1' });
  await v.persist();
  const doc = parseFile(file.text);
  const cred = doc.keyring.members[0].credentials[0];
  assert.equal(cred.kind, 'app');
  assert.equal(cred.credentialId, undefined, 'no credential ID: older apps skip it');
  assert.equal(cred.rpId, undefined);
  assert.equal(cred.tag, await appTag(mk, doc.id));
  assert.equal(file.text.includes('geheim-1'), false);
  const { v: again, r } = await openApp(file, mk);
  assert.equal(r.role, 'admin');
  assert.equal(r.via, 'app');
  assert.equal(again.locked, false);
  // Counter-tests: another member key, or none, opens nothing.
  await assert.rejects(openApp(file, newMemberKey()), /nicht mit deinem Masterpasswort/);
  assert.deepEqual(secureCredentials(doc.keyring, 'localhost'), [], 'app credentials are never offered as passkeys');
});

test('the app credential is bound to its file: copied into another file it opens nothing', async () => {
  const mk = newMemberKey();
  const a = memoryFile();
  const b = memoryFile();
  await (await FileVault.createSecure(a.io, { name: 'A', email: 'x@contoso.com', mk })).persist();
  await (await FileVault.createSecure(b.io, { name: 'B', email: 'x@contoso.com', mk })).persist();
  const da = parseFile(a.text);
  const db = parseFile(b.text);
  assert.notEqual(da.keyring.members[0].credentials[0].tag, db.keyring.members[0].credentials[0].tag, 'tags do not link files');
  // B's member gets A's sealed identity under B's tag: the key and AAD carry the file ID – it does not open.
  const ca = da.keyring.members[0].credentials[0];
  db.keyring.members[0].credentials[0] = { ...ca, tag: db.keyring.members[0].credentials[0].tag };
  b.text = JSON.stringify(db);
  await assert.rejects(openApp(b, mk), /nicht mit deinem Masterpasswort/);
});

test('access request with the member key; pending until approved, then opens', async () => {
  const { file, bobMk } = await teamWithBob();
  const { r } = await openApp(file, bobMk);
  assert.equal(r.role, 'editor');
});

test('older app versions: app credentials skipped by passkey unlock and kept by merge', async () => {
  const { file, alice } = await teamWithBob();
  const pk = passkey('alice');
  // Alice adds a passkey (as an older app could); the app credential stays.
  const ctxDoc = parseFile(file.text);
  await assert.rejects(unlockSecure(ctxDoc.keyring, 'nope', prf()), /passt nicht/);
  await alice.memberOp({ type: 'addCredential', passkey: pk });
  const doc = parseFile(file.text);
  const me = doc.keyring.members.find((m) => m.email === 'alice@contoso.com');
  assert.equal(me.credentials.filter(isAppCredential).length, 1);
  assert.equal(secureCredentials(doc.keyring, 'localhost').length, 1, 'only the passkey');
  // An app credential without credentialId never matches a passkey lookup (also undefined).
  await assert.rejects(unlockSecure(doc.keyring, undefined, prf()), /passt nicht/);
  const merged = mergeSecureKeyrings(doc.keyring, { ...doc.keyring, members: doc.keyring.members.map((m) => ({ ...m, credentials: m.credentials.filter((c) => !isAppCredential(c)) })) });
  assert.equal(merged.members.find((m) => m.id === me.id).credentials.some(isAppCredential), true, 'union keeps the app credential');
});

test('migration of a passkey member: addAppCredential for the same identity', async () => {
  const file = memoryFile();
  const pk = passkey('alice');
  const v = await FileVault.createSecure(file.io, { name: 'Team', email: 'alice@contoso.com', passkey: pk });
  await v.persist();
  const mk = newMemberKey();
  await v.memberOp({ type: 'addAppCredential', mk });
  await v.memberOp({ type: 'addAppCredential', mk }); // twice: no second one
  const doc = parseFile(file.text);
  assert.equal(doc.keyring.members.length, 1, 'no new identity');
  assert.equal(doc.keyring.members[0].credentials.filter(isAppCredential).length, 1);
  const { r } = await openApp(file, mk);
  assert.equal(r.memberId, v.memberId);
  assert.equal(doc.log.some((e) => e.id), true);
});

test('passkeys only: needs a passkey for every active member, drops app credentials, refuses MK unlock and new app credentials', async () => {
  const { file, alice, aliceMk, bobMk } = await teamWithBob();
  await assert.rejects(alice.memberOp({ type: 'passkeyOnly', enabled: true }), (e) => e.code === 'no-passkey' && e.missing.length === 2);
  await alice.memberOp({ type: 'addCredential', passkey: passkey('alice') });
  // Bob adds a passkey himself.
  const { v: bob } = await openApp(file, bobMk);
  await bob.memberOp({ type: 'addCredential', passkey: passkey('bob') });
  await alice.load();
  await alice.memberOp({ type: 'passkeyOnly', enabled: true });
  const doc = parseFile(file.text);
  assert.equal(doc.keyring.members.some((m) => m.credentials.some(isAppCredential)), false, 'every app credential is gone');
  await assert.rejects(openApp(file, aliceMk), /nur mit Passkey/);
  await assert.rejects(alice.memberOp({ type: 'addAppCredential', mk: aliceMk }), /nur mit Passkey/);
  const view = await alice.describeMembers('localhost');
  assert.equal(view.passkeyOnly, true);
  // A non-admin cannot switch it off.
  await bob.load();
  await assert.rejects(bob.memberOp({ type: 'passkeyOnly', enabled: false }), /Nur Admins/);
});

test('passkeys only: an unsigned or forged setting does not count; the floor keeps it on when the file drops it', async () => {
  const { file, alice } = await teamWithBob();
  const doc = parseFile(file.text);
  doc.keyring.passkeyOnly = { enabled: true, at: new Date().toISOString(), by: doc.keyring.members[1].id, sig: 'AAAA' };
  file.text = JSON.stringify(doc);
  await alice.load();
  assert.equal((await alice.describeMembers('localhost')).passkeyOnly, false, 'forged by a non-admin: off');
  // Real one by the admin (passkeys first).
  delete doc.keyring.passkeyOnly;
  file.text = JSON.stringify(doc);
  await alice.load();
  await alice.memberOp({ type: 'addCredential', passkey: passkey('alice') });
  const bobId = alice.doc.keyring.members.find((m) => m.email === 'bob@contoso.com').id;
  await alice.memberOp({ type: 'remove', memberId: bobId });
  await alice.memberOp({ type: 'passkeyOnly', enabled: true });
  const floor = mergeFloors(null, floorOf(alice.doc, alice.roster));
  assert.equal(floor.passkeyOnly.enabled, true);
  // Somebody puts the file back without the setting: the floor still says on.
  const dropped = parseFile(file.text);
  delete dropped.keyring.passkeyOnly;
  const v = new FileVault({ read: async () => JSON.stringify(dropped), write: async () => {} });
  v.floor = floor;
  await v.load();
  await assert.rejects(v.unlockWithPasskey(null, null, { mk: newMemberKey() }), /nur mit Passkey/);
});

test('master password compromised: a non-admin leaves a signed replacement request, the admin approves it in one step', async () => {
  const { file, alice, bobMk } = await teamWithBob();
  const { v: bob } = await openApp(file, bobMk);
  const oldBobId = bob.memberId;
  const newMk = newMemberKey();
  const r = await replaceOwnIdentity(bob, newMk);
  assert.equal(r.replaced, false);
  let doc = parseFile(file.text);
  const fresh = doc.keyring.members.find((m) => m.id === r.memberId);
  assert.equal((await replacedBy(doc.keyring, fresh)).id, oldBobId, 'signed by the old identity');
  assert.equal(doc.keyring.members.find((m) => m.id === oldBobId).credentials.some(isAppCredential), false, 'old MK opens nothing any more');
  await assert.rejects(openApp(file, bobMk), /nicht mit deinem Masterpasswort/);
  assert.equal((await openApp(file, newMk)).r.pending, true);
  // A forged replacement (signature of someone else) is not shown as one.
  const forged = structuredClone(doc.keyring);
  forged.members.find((m) => m.id === r.memberId).replaces.id = forged.members.find((m) => m.email === 'alice@contoso.com').id;
  assert.equal(await replacedBy(forged, forged.members.find((m) => m.id === r.memberId)), null);
  // The admin approves: new identity gets the old role, the old one is removed, the key changes.
  await alice.load();
  const kvBefore = alice.doc.keyring.keyVersion;
  const view = await alice.describeMembers('localhost');
  assert.equal(view.replaces[r.memberId].id, oldBobId);
  await alice.memberOp({ type: 'replace', memberId: r.memberId });
  doc = parseFile(file.text);
  assert.equal(doc.keyring.keyVersion, kvBefore + 1);
  const { r: opened } = await openApp(file, newMk);
  assert.equal(opened.role, 'editor');
  await bob.load();
  assert.equal(bob.locked, true, 'the old identity is out');
});

test('a replace without a verified request is refused', async () => {
  const { alice, bobId } = await teamWithBob();
  await assert.rejects(alice.memberOp({ type: 'replace', memberId: bobId }), /ersetzt kein Mitglied/);
});

test('master password compromised: an admin replaces themselves at once', async () => {
  const { file, aliceMk } = await teamWithBob();
  const { v: alice } = await openApp(file, aliceMk);
  const oldId = alice.memberId;
  const newMk = newMemberKey();
  const r = await replaceOwnIdentity(alice, newMk);
  assert.equal(r.replaced, true);
  assert.equal(alice.memberId, r.memberId);
  assert.equal(alice.role, 'admin');
  await assert.rejects(openApp(file, aliceMk), /nicht mit deinem Masterpasswort|entfernt/);
  const { r: again } = await openApp(file, newMk);
  assert.equal(again.role, 'admin');
  const doc = parseFile(file.text);
  assert.equal(doc.keyring.members.find((m) => m.id === oldId).grants.at(-1).status, 'removed');
});

test('wiring: the member key never comes from the window; renewing only after a key change', async () => {
  const { readFileSync } = await import('node:fs');
  const api = readFileSync('desktop/main/api/files.js', 'utf8');
  assert.match(api, /type: 'addAppCredential', mk: await memberKeyForNew\(\)/);
  assert.doesNotMatch(api, /op\.mk|params\.mk/);
  const files = readFileSync('desktop/files.js', 'utf8');
  assert.match(files, /vault\.unlockWithPasskey\(params\.credentialId, params\.prfOutput\);/, 'the window path never passes a member key');
  const mk = readFileSync('desktop/main/member-key.js', 'utf8');
  const body = mk.slice(mk.indexOf('export async function renewMemberIdentity'));
  assert.ok(body.indexOf('consumeRenew(rec.entry)') > 0 && body.indexOf('consumeRenew(rec.entry)') < body.indexOf('writeMemberKeys'), 'checked before the new key is written');
  const settings = readFileSync('desktop/settings-sealed.js', 'utf8');
  assert.match(settings, /DEVICE_ONLY = \[[^\]]*'memberKeySeen'/);
});
