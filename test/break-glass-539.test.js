// #539 Etappe 10: break-glass stick required for secured files, approval only with the typed code – counter-tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FileVault, parseFile } from '../extension/core/filevault.js';
import { safetyCode } from '../extension/core/members.js';
import { codeMatches, isBreakGlass, requestReplacement } from '../extension/core/members-mp.js';
import { floorOf, repairFromFloor } from '../extension/core/rollback.js';
import { deviceKind } from '../extension/core/prf.js';
import { breakGlassExclude, isSecurityKey } from '../desktop/member-keys-logic.js';
import { newMemberKey } from '../extension/core/member-app.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

const passkey = (name) => ({ credentialId: `cred-${name}-${b64uEncode(randomBytes(4))}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: b64uEncode(randomBytes(32)), label: name });
function memoryFile() {
  let text = null;
  return { io: { read: async () => text, write: async (s) => { text = s; } }, get text() { return text; }, set text(v) { text = v; } };
}
const src = (p) => readFileSync(p, 'utf8');

async function team() {
  const file = memoryFile();
  const stick = passkey('safe');
  const alice = await FileVault.createSecure(file.io, { name: 'T', email: 'a@contoso.com', mk: newMemberKey(), breakGlass: stick });
  await alice.persist();
  return { file, alice, stick };
}

test('created with the break-glass stick: an admin member of its own that opens the file alone', async () => {
  const { file, alice, stick } = await team();
  const doc = parseFile(file.text);
  const bg = doc.keyring.members.find(isBreakGlass);
  assert.ok(bg, 'break-glass member');
  assert.equal(doc.keyring.members.length, 2);
  const view = await alice.describeMembers('localhost');
  const m = view.members.find((x) => x.breakGlass);
  assert.equal(m.role, 'admin');
  assert.equal(m.status, 'active');
  assert.ok(doc.log.length >= 2, 'creation and break-glass logged');
  // All admins gone (their keys lost): the stick alone opens the data.
  const v = new FileVault(file.io);
  await v.load();
  const r = await v.unlockWithPasskey(stick.credentialId, stick.prfOutput);
  assert.equal(r.role, 'admin');
  // A wrong PRF output (another stick) opens nothing.
  await assert.rejects(new FileVault(file.io).load().then((x) => x.unlockWithPasskey(stick.credentialId, b64uEncode(randomBytes(32)))));
});

test('the last break-glass access cannot be removed, rejected or lose its admin role; a second one makes it removable', async () => {
  const { alice } = await team();
  const bgId = alice.doc.keyring.members.find(isBreakGlass).id;
  await assert.rejects(alice.memberOp({ type: 'remove', memberId: bgId }), /letzte Notfall-Zugang/);
  await assert.rejects(alice.memberOp({ type: 'setRole', memberId: bgId, role: 'reader' }), /letzte Notfall-Zugang/);
  await assert.rejects(alice.memberOp({ type: 'reject', memberId: bgId }), /letzte Notfall-Zugang/);
  await alice.memberOp({ type: 'breakGlass', stick: passkey('safe-2') });
  await alice.memberOp({ type: 'remove', memberId: bgId });
  assert.equal(alice.doc.keyring.members.filter(isBreakGlass).length, 2, 'removed, kept hidden or listed as removed');
  const active = (await alice.describeMembers('localhost')).members.filter((m) => m.breakGlass && m.status === 'active');
  assert.equal(active.length, 1);
});

test('a stick already registered with a member is refused as break-glass', async () => {
  const file = memoryFile();
  const pk = passkey('alice');
  await assert.rejects(FileVault.createSecure(file.io, { name: 'T', email: 'a@contoso.com', passkey: pk, breakGlass: pk }), /schon bei einem Mitglied/);
});

test('approval only with the typed code: digits of the requester\'s own code, all 16', async () => {
  const { file, alice } = await team();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const bv = new FileVault(file.io);
  await bv.load();
  const req = await bv.requestAccess({ email: 'b@contoso.com', mk: newMemberKey() });
  await alice.load();
  const m = alice.doc.keyring.members.find((x) => x.id === req.memberId);
  assert.equal(await codeMatches(m, req.safetyCode), true);
  assert.equal(await codeMatches(m, req.safetyCode.replace(/ /g, '')), true, 'spaces do not matter');
  assert.equal(await codeMatches(m, ''), false);
  assert.equal(await codeMatches(m, req.safetyCode.slice(0, 14)), false, 'not a part of it');
  const other = alice.doc.keyring.members.find((x) => x.id !== req.memberId);
  assert.equal(await codeMatches(m, await safetyCode(other)), false, 'another member\'s code');
  assert.equal(await codeMatches(null, req.safetyCode), false);
});

test('wiring: required before creating and converting, test unlock in a second ceremony, code typed, codes hidden', () => {
  const api = src('desktop/main/api/files.js');
  assert.match(api, /const breakGlass = await registerBreakGlass\(name, passkey \? \[passkey\.credentialId\] : \[\]\);\s+const r = await files\.createSecure\(filePath, name, \{ email: cleanEmail\(email\), passkey, mk, breakGlass \}\);/);
  assert.match(api, /const breakGlass = await registerBreakGlass\(c\.name, passkey \? \[passkey\.credentialId\] : \[\]\);[\s\S]*?files\.migrate\(containerId, \{ email: cleanEmail\(email\), passkey, mk, breakGlass \}\)/);
  assert.match(api, /if \(op\?\.type === 'approve'\) return files\.memberOp\(containerId, \{ type: 'approve', memberId: String\(op\.memberId \|\| ''\), role: op\.role, code, requireCode: true \}\);/);
  assert.match(api, /fileMembers: async \(containerId\) => withoutForeignCodes\(/);
  const files = src('desktop/files.js');
  assert.equal((files.match(/if \(!creator\?\.breakGlass\) throw/g) || []).length, 2, 'createSecure and migrate refuse without it');
  const bg = src('desktop/main/break-glass.js');
  assert.match(bg, /mode: 'evaluate'[\s\S]*?if \(check\?\.credentialId !== stick\.credentialId \|\| check\.prfOutput !== stick\.prfOutput\) \{/);
  assert.match(bg, /if \(!isSecurityKey\(stick\)\) throw/);
  assert.match(bg, /m\.me \? m : \{ \.\.\.m, safetyCode: null/);
});

// ---------------------------------------------------------------- Konrad's review of Etappe 10 (7ef7ee2..079f012)

async function teamWithRequest() {
  const t0 = await team();
  await t0.alice.memberOp({ type: 'sharing', enabled: true });
  const bv = new FileVault(t0.file.io);
  await bv.load();
  const bobMk = newMemberKey();
  const req = await bv.requestAccess({ email: 'b@contoso.com', mk: bobMk });
  await t0.alice.load();
  return { ...t0, req, bobMk };
}

test('M1: setRole never makes a request active – the code is the only way in', async () => {
  const { alice, req, file, bobMk } = await teamWithRequest();
  await assert.rejects(alice.memberOp({ type: 'setRole', memberId: req.memberId, role: 'editor' }), /Nur aktive Mitglieder/);
  const v = new FileVault(file.io);
  await v.load();
  assert.equal((await v.unlockWithPasskey(null, null, { mk: bobMk })).pending, true, 'still a request');
  // An active member's role still changes.
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'reader', code: req.safetyCode, requireCode: true });
  await alice.memberOp({ type: 'setRole', memberId: req.memberId, role: 'editor' });
  assert.equal(alice.roster.current(req.memberId).role, 'editor');
});

test('N2d: the core checks the typed code against exactly the member it approves', async () => {
  const { alice, req } = await teamWithRequest();
  const other = alice.doc.keyring.members.find((m) => m.id !== req.memberId);
  await assert.rejects(alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'reader', requireCode: true }), { code: 'WrongSafetyCode' });
  await assert.rejects(alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'reader', code: '1234 5678 9012 3456', requireCode: true }), { code: 'WrongSafetyCode' });
  await assert.rejects(alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'reader', code: await safetyCode(other), requireCode: true }), { code: 'WrongSafetyCode' });
  assert.equal(alice.roster.current(req.memberId).status, 'pending');
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'reader', code: req.safetyCode, requireCode: true });
  assert.equal(alice.roster.current(req.memberId).status, 'active');
});

test('N1: the break-glass mark is signed – set on another member it voids their grants, taken off the stick too', async () => {
  const { alice, req, file } = await teamWithRequest();
  await alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'editor', code: req.safetyCode, requireCode: true });
  const forged = parseFile(file.text);
  forged.keyring.members.find((m) => m.id === req.memberId).breakGlass = true;
  const fresh = new FileVault({ read: async () => JSON.stringify(forged), write: async () => {} });
  await fresh.load();
  assert.notEqual(fresh.roster.current(req.memberId).status, 'active', 'without a floor: the forged member counts nowhere');
  const seen = new FileVault({ read: async () => JSON.stringify(forged), write: async () => {} });
  seen.floor = floorOf(alice.doc, alice.roster);
  await assert.rejects(seen.load(), /manipuliert/, 'with the floor: refused as changed');
  const off = parseFile(file.text);
  delete off.keyring.members.find(isBreakGlass).breakGlass;
  const v = new FileVault({ read: async () => JSON.stringify(off), write: async () => {} });
  await v.load();
  assert.equal([...v.roster.members.values()].filter((x) => x.status === 'active').length, 2, 'the stick without its mark is no admin any more (alice, bob)');
});

test('N1: repairing from the floor puts the signed mark back', async () => {
  const { alice, file } = await team();
  const floor = floorOf(alice.doc, alice.roster);
  assert.equal(floor.members.find((m) => m.breakGlass)?.breakGlass, true);
  const doc = parseFile(file.text);
  delete doc.keyring.members.find(isBreakGlass).breakGlass;
  const repaired = await repairFromFloor(doc, floor);
  assert.equal(repaired.keyring.members.filter(isBreakGlass).length, 1);
});

test('N2c: the last break-glass member is not removed through a replacement either', async () => {
  const { alice, file, stick } = await team();
  const bgv = new FileVault(file.io);
  await bgv.load();
  await bgv.unlockWithPasskey(stick.credentialId, stick.prfOutput);
  const r = await requestReplacement(bgv.doc.keyring, { oldMemberId: bgv.memberId, oldIdentity: bgv.identity, mk: newMemberKey() });
  file.text = JSON.stringify({ ...parseFile(file.text), keyring: r.keyring });
  await alice.load();
  const code = alice.doc.keyring.members.find((m) => m.id === r.memberId);
  await assert.rejects(alice.memberOp({ type: 'replace', memberId: r.memberId, code: await safetyCode(code), requireCode: true }), /letzte Notfall-Zugang/);
  assert.equal(alice.roster.current(r.memberId).status, 'pending', 'nothing approved either');
});

test('N2a/N2b: the stick exception only in a smoke run of a not installed app; only a security key counts', () => {
  assert.deepEqual(breakGlassExclude(['a'], { smokeTest: true, packaged: false }), []);
  assert.deepEqual(breakGlassExclude(['a'], { smokeTest: true, packaged: true }), ['a'], 'installed: never');
  assert.deepEqual(breakGlassExclude(['a'], { smokeTest: false, packaged: false }), ['a']);
  const kind = (k) => ({ ...k, device: deviceKind(k) });
  assert.equal(isSecurityKey(kind({ attachment: 'cross-platform', transports: ['usb'] })), true);
  assert.equal(isSecurityKey(kind({ attachment: 'cross-platform', transports: ['nfc', 'usb'] })), true);
  assert.equal(isSecurityKey(kind({ attachment: 'cross-platform', transports: ['hybrid', 'internal'] })), false, 'a phone over hybrid');
  assert.equal(isSecurityKey(kind({ platform: true, attachment: 'platform' })), false, 'Windows Hello');
  assert.equal(isSecurityKey(kind({ attachment: '' })), false, 'unknown');
});

test('only addBreakGlass approves a member with the break-glass mark – not the everyday approve, not a replacement', async () => {
  const { alice, file } = await team();
  await alice.memberOp({ type: 'sharing', enabled: true });
  const bv = new FileVault(file.io);
  await bv.load();
  const req = await bv.requestAccess({ email: 'b@contoso.com', mk: newMemberKey() });
  // A writer marks their own request as break-glass, hoping to become an unremovable admin.
  const doc = parseFile(file.text);
  doc.keyring.members.find((m) => m.id === req.memberId).breakGlass = true;
  file.text = JSON.stringify(doc);
  await alice.load();
  const target = alice.doc.keyring.members.find((m) => m.id === req.memberId);
  await assert.rejects(alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'admin', code: await safetyCode(target), requireCode: true }), /Notfall-Stick hinzufügen/);
  await assert.rejects(alice.memberOp({ type: 'approve', memberId: req.memberId, role: 'reader' }), /Notfall-Stick hinzufügen/, 'any role');
  assert.equal(alice.roster.current(req.memberId).status, 'pending');
  // The real path still works.
  await alice.memberOp({ type: 'breakGlass', stick: passkey('safe-2') });
  assert.equal((await alice.describeMembers('localhost')).members.filter((m) => m.breakGlass && m.status === 'active').length, 2);
});
