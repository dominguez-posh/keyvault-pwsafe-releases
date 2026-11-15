// #539 Etappe 8 – Konrad's findings on 0a81bd5 (H1, M1–M4, low): counter-tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FileVault, parseFile, mergeDocs } from '../extension/core/filevault.js';
import { newMemberKey, isAppCredential, removedAppCredential, uniteKeys, currentKey, openMemberKeys } from '../extension/core/member-app.js';
import { settlePasskeyOnly } from '../extension/core/members-mp.js';
import { readMemberKeys, writeMemberKeys, memberKeyCount, replaceOwnIdentity } from '../extension/core/filevault-mp.js';
import { planMemberKeys, mayLink, RenewGate } from '../desktop/member-keys-logic.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
function memoryFile() {
  let text = null;
  return { io: { read: async () => text, write: async (s) => { text = s; } }, get text() { return text; }, set text(v) { text = v; } };
}
const src = (p) => readFileSync(p, 'utf8');

async function personal() {
  const file = memoryFile();
  const { vault } = await FileVault.create(file.io, { name: 'Persönlich' });
  await vault.persist();
  return { file, vault };
}

test('member keys in the personal vault: a key change keeps them, a forged generation or fingerprint opens nothing', async () => {
  const { file, vault } = await personal();
  assert.deepEqual(await readMemberKeys(vault), []);
  const mk = newMemberKey();
  await writeMemberKeys(vault, [{ mk, gen: 1 }]);
  assert.deepEqual((await readMemberKeys(vault))[0].mk, mk);
  assert.equal(file.text.includes(b64uEncode(mk)), false);
  const old = vault.ck;
  await vault.rekey('Neues-Masterpasswort-123');
  assert.deepEqual((await readMemberKeys(vault))[0].mk, mk, 'identity kept, only wrapped anew');
  assert.deepEqual(await openMemberKeys(old, vault.doc.memberKeys, (x) => vault.aad(x)), []);
  const e = vault.doc.memberKeys[0];
  assert.deepEqual(await openMemberKeys(vault.ck, [{ ...e, gen: 2 }], (x) => vault.aad(x)), [], 'generation in the AAD');
  assert.deepEqual(await openMemberKeys(vault.ck, [{ ...e, fp: 'x'.repeat(22) }], (x) => vault.aad(x)), [], 'fingerprint in the AAD');
});

test('H1: a key change by an older app leaves the entries unreadable – they count, so no first key is created over them', async () => {
  const { vault } = await personal();
  await writeMemberKeys(vault, [{ mk: newMemberKey(), gen: 1 }]);
  // An app of 0.9.34 changes the key without knowing memberKeys: the entries stay under the old key.
  const keep = vault.doc.memberKeys;
  await vault.rekey('Neues-Masterpasswort-456');
  vault.doc.memberKeys = keep;
  assert.deepEqual(await readMemberKeys(vault), [], 'not readable under the new key');
  assert.equal(memberKeyCount(vault), 1, 'but there – member-key.js never creates a first key over it');
  // H1: a key this device saw comes back from its copy; a stranger's key from the configuration does not.
  const seenKey = { gen: 1, fp: 'seen', mk: newMemberKey(), compromised: false };
  const stranger = { gen: 9, fp: 'stranger', mk: newMemberKey(), compromised: false };
  const plan = planMemberKeys({ inVault: [], extra: [seenKey, stranger], seen: { fps: ['seen'], gen: 1 }, count: 1, create: true });
  assert.deepEqual(plan.back.map((k) => k.fp), ['seen']);
  assert.deepEqual(plan.keys.map((k) => k.fp), ['seen']);
  assert.equal(plan.createGen, null, 'a usable key came back: nothing new');
});

test('H1: re-sealing a key under the current key makes it readable again', async () => {
  const { vault } = await personal();
  const mk = newMemberKey();
  await writeMemberKeys(vault, [{ mk, gen: 1 }]);
  const keep = vault.doc.memberKeys;
  await vault.rekey('Neues-Masterpasswort-789');
  vault.doc.memberKeys = keep;
  await writeMemberKeys(vault, [{ mk, gen: 1 }]); // what memberKeys() does with the device copy
  const keys = await readMemberKeys(vault);
  assert.equal(keys.length, 1);
  assert.deepEqual(keys[0].mk, mk);
  assert.equal(vault.doc.memberKeys.length, 1, 'the unreadable entry of the same key is replaced');
});

test('M1: two devices creating the first key at once keep both; opening tries every key', async () => {
  const { file, vault } = await personal();
  const other = new FileVault(file.io);
  await other.load();
  await other.unlock(vault.ck);
  const a = newMemberKey();
  const b = newMemberKey();
  await writeMemberKeys(vault, [{ mk: a, gen: 1 }]);
  await writeMemberKeys(other, [{ mk: b, gen: 1 }]); // wrote without seeing a
  await vault.load();
  const keys = await readMemberKeys(vault);
  assert.equal(keys.length, 2, 'both kept by the merge');
  // The app credential sealed with either key opens its file.
  const team = memoryFile();
  await (await FileVault.createSecure(team.io, { name: 'T', email: 'a@contoso.com', mk: b })).persist();
  const v = new FileVault(team.io);
  await v.load();
  let opened = null;
  for (const k of keys) opened ||= await v.unlockWithPasskey(null, null, { mk: k.mk }).catch(() => null);
  assert.equal(opened?.role, 'admin');
  assert.equal(mergeDocs({ ...vault.doc, memberKeys: undefined }, { ...vault.doc }).memberKeys.length, 2);
});

test('M2: compromised keys stay listed, the new one is current; marked once means marked', () => {
  const k1 = { gen: 1, fp: 'a', mk: newMemberKey(), compromised: false };
  const k2 = { gen: 2, fp: 'b', mk: newMemberKey(), compromised: false };
  const keys = uniteKeys([k1, { ...k1, compromised: true }], [k2]);
  assert.equal(keys.length, 2);
  assert.equal(keys.find((k) => k.fp === 'a').compromised, true);
  assert.equal(currentKey(keys).fp, 'b');
  assert.equal(currentKey(uniteKeys([{ ...k1, compromised: true }])), null, 'no current key: nothing new is sealed with a compromised one');
  const mk = src('desktop/main/member-key.js');
  assert.match(mk, /if \(!r\.pending && hit\.key\.compromised && rec\.current && !e\.vault\.locked\) \{\s+const x = await files\.serial\(e\.id, \(\) => replaceOwnIdentity\(e\.vault, rec\.current\.mk\)\);/);
  assert.match(mk, /rec\.keys\.map\(\(k\) => \(\{ \.\.\.k, compromised: true \}\)\)/);
});

test('M3: renewing only right after a key change with a NEW password, once, at that generation, within ten minutes', () => {
  let now = 1000;
  const gate = new RenewGate(() => now);
  assert.equal(gate.consume('p', 2), false, 'no key change: refused');
  gate.afterRekey('p', 2, false);
  assert.equal(gate.consume('p', 2), false, 'same password (stick removed, MP kept): refused');
  gate.afterRekey('p', 2, true);
  assert.equal(gate.consume('other', 2), false, 'another vault');
  gate.afterRekey('p', 2, true);
  assert.equal(gate.consume('p', 3), false, 'another key change since');
  gate.afterRekey('p', 2, true);
  now += 10 * 60_000 + 1;
  assert.equal(gate.consume('p', 2), false, 'too late');
  gate.afterRekey('p', 2, true);
  assert.equal(gate.consume('p', 2), true);
  assert.equal(gate.consume('p', 2), false, 'only once');
});

test('M3: the key change reports whether the password is new (FileContainers.updateKeyring → onRekey)', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { FileContainers } = await import('../desktop/files.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kv-539-m3-'));
  const file = path.join(dir, 'Keevault-Persoenlich.kvpws');
  const seen = [];
  const state = { paths: [], pins: {}, notes: {} };
  const files = new FileContainers({
    paths: () => state.paths, setPaths: (p) => { state.paths = p; }, onChange: () => {},
    pins: () => state.pins, setPins: (p) => { state.pins = p; }, pinNotes: () => state.notes, setPinNotes: (n) => { state.notes = n; },
    onRekey: (entry, password, info) => { seen.push(info); },
  });
  try {
    const { id } = await files.create(file, 'P', { password: 'Erstes-Masterpasswort-1' }, 'me');
    await files.updateKeyring(id, { type: 'rekey', password: 'Erstes-Masterpasswort-1' }, 'me');
    await files.updateKeyring(id, { type: 'rekey', password: 'Zweites-Masterpasswort-2' }, 'me');
    assert.deepEqual(seen, [{ changed: false }, { changed: true }]);
  } finally {
    files.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test('M4: no automatic link after a removed app credential, nor under "Immer bestätigen"', async () => {
  const file = memoryFile();
  const v = await FileVault.createSecure(file.io, { name: 'T', email: 'a@contoso.com', passkey: passkey('a'), mk: newMemberKey() });
  await v.persist();
  const me = v.doc.keyring.members[0];
  const app = me.credentials.find(isAppCredential);
  assert.match(app.id, /^app-/);
  assert.equal(removedAppCredential(me), false);
  await v.memberOp({ type: 'removeCredential', credentialEntryId: app.id });
  assert.equal(removedAppCredential(v.doc.keyring.members[0]), true);
  assert.equal(mayLink({ member: v.doc.keyring.members[0], hasKey: true }), false, 'removed on purpose stays removed');
  const fresh = { ...me, removedCredentials: [] };
  assert.equal(mayLink({ member: fresh, hasKey: true }), true);
  assert.equal(mayLink({ member: fresh, hasKey: true, strict: true }), false, 'not under "Immer bestätigen"');
  assert.equal(mayLink({ member: fresh, hasKey: true, passkeyOnly: true }), false, 'not with "passkeys only"');
  assert.equal(mayLink({ member: fresh, hasKey: true, linked: true }), false, 'not twice');
  assert.equal(mayLink({ member: fresh, hasKey: false }), false, 'not without a member key');
  assert.equal(mayLink({ member: { ...fresh, breakGlass: true }, hasKey: true }), false, 'never the break-glass member (Etappe 10)');
});

test('low: only active members are replaced, not under "passkeys only"; switching it off asks under "Immer bestätigen"', async () => {
  const file = memoryFile();
  const alice = await FileVault.createSecure(file.io, { name: 'T', email: 'a@contoso.com', passkey: passkey('a'), mk: newMemberKey() });
  await alice.persist();
  await alice.memberOp({ type: 'passkeyOnly', enabled: true });
  await assert.rejects(replaceOwnIdentity(alice, newMemberKey()), /nur mit Passkey/);
  assert.match(src('desktop/main/api/files.js'), /\|\| \(op\?\.type === 'passkeyOnly' && op\.enabled !== true\)\) await requireVaultUse\(containerId, 'share'\);/);
  assert.match(src('extension/core/members-mp.js'), /if \(prev\?\.status !== 'active' \|\| !FILE_ROLES\.includes\(prev\.role\)\) throw/);
});

test('low: a removed member\'s replacement request is refused', async () => {
  const file = memoryFile();
  const aliceMk = newMemberKey();
  const alice = await FileVault.createSecure(file.io, { name: 'T', email: 'a@contoso.com', mk: aliceMk });
  await alice.persist();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const bobMk = newMemberKey();
  const bv = new FileVault(file.io);
  await bv.load();
  const req = await bv.requestAccess({ email: 'b@contoso.com', mk: bobMk });
  await alice.load();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'editor' });
  const bob = new FileVault(file.io);
  await bob.load();
  await bob.unlockWithPasskey(null, null, { mk: bobMk });
  const r = await replaceOwnIdentity(bob, newMemberKey());
  await alice.load();
  await alice.memberOp({ type: 'remove', memberId: req.memberId });
  await assert.rejects(alice.memberOp({ type: 'replace', memberId: r.memberId }), /ersetzt kein Mitglied/);
});

test('low: merging keeps the newest valid "passkeys only" – a forged later one does not push it out', async () => {
  const file = memoryFile();
  const alice = await FileVault.createSecure(file.io, { name: 'T', email: 'a@contoso.com', passkey: passkey('a') });
  await alice.persist();
  await alice.memberOp({ type: 'passkeyOnly', enabled: true });
  const valid = alice.doc.keyring.passkeyOnly;
  const forged = { enabled: false, at: new Date(Date.now() + 60_000).toISOString(), by: valid.by, sig: 'AAAA' };
  const settled = await settlePasskeyOnly({ ...alice.doc.keyring, passkeyOnly: forged }, [forged, valid], alice.known);
  assert.equal(settled.passkeyOnly.sig, valid.sig);
  // Through persist: the disk carries the forged one, ours the valid one.
  const doc = parseFile(file.text);
  doc.keyring.passkeyOnly = forged;
  file.text = JSON.stringify(doc);
  await alice.saveItem({ title: 'x', password: 'y' });
  assert.equal(parseFile(file.text).keyring.passkeyOnly.sig, valid.sig);
});

test('Lucas 13.11.2026: no new shared file vault in the old format; the personal vault keeps its own path', () => {
  const api = src('desktop/main/api/files.js');
  assert.match(api, /async createFile\(\{ path: filePath, name, password, passkeyLabel, legacy \}\) \{\s+if \(!\(smokeTest && !app\.isPackaged && legacy === true\)\) throw/); // hardening: never in an installed app
  assert.match(src('desktop/renderer/app/file-vaults.js'), /call\('createSecureFile'/);
  assert.doesNotMatch(src('desktop/renderer/app/file-vaults.js'), /call\('createFile'/);
  assert.match(src('desktop/main/personal.js'), /files\.create\(info\.path, t\('Persönlich'\), \{ password \}/);
});
/** May the user rename this container for everyone? Key Vault: only managers (role assignments) and admins. */
export const canRename = (c) => c.kind !== 'keyvault' || !!(c.access?.manage || c.access?.admin);

/** Shared display name of a Key Vault container: field "name" of the metadata secret. */
export async function renameInVault(session, containerId, name) {
  const c = await session.container(containerId);
  if (c.kind !== 'keyvault') throw new Error(t('Nur für Tresore in Azure Key Vault'));
  if (!canRename(c)) throw new Error(t('Du brauchst Verwaltungsrechte auf dem Tresor.'));
  const clean = cleanVaultName(name);
  if (!clean) throw new Error(t('Bitte einen Namen eingeben'));
  await session.writeContainerMeta(session.kv(c), { name: clean });
  await rememberMetaName(session, containerId, clean);
}

/** Remembers the name from the vault's metadata; it takes precedence over the ARM tag and the local name. */
export async function rememberMetaName(session, containerId, raw) {
  const name = cleanVaultName(raw);
  const stored = (await session.store.get('containers')) || [];
  const own = stored.find((x) => x.id === containerId);
  if (!own || !name || (own.metaName === name && own.name === name)) return;
  own.metaName = name;
  own.name = name;
  await session.store.set('containers', stored);
}
