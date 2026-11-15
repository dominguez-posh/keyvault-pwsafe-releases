// #537 2b "Immer bestätigen", Konrad's review of c13aed7: markers only at their own secret place (H1), moves out of a vault
// with the rule only confirmed (H2), write answers sealed centrally (M1), the app settings record bound to its time stamp
// (N1) and re-encrypted with a key change (N2), the extension's question held on a locked window and naming the page (N3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isSealed, sealItem, sealedValue, secretPlace, SEALED_PREFIX, totpPlace, unsealItem } from '../extension/core/sealed.js';
import { AccessConfirm, MOVE_MAX, VAULT_WIDE, WRITE_ANSWERS, answerHasItem, sealedAnswer, writeAnswerVault } from '../desktop/access-confirm.js';
import { PinGuard, inPinQueue } from '../desktop/pin.js';
import { browserItemHandlers } from '../desktop/browser-items.js';
import * as P from '../extension/core/protect.js';
import { FileVault } from '../extension/core/filevault.js';
import { b64uEncode, randomBytes } from '../extension/core/util.js';

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const mark = (place) => SEALED_PREFIX + place;
const ITEM = {
  id: 'i1', type: 'login', title: 'Bank', username: 'kim', password: 'geheim-123', notes: 'frei',
  fields: [{ name: 'Text', value: 'sichtbar', type: 'text', hidden: false }, { name: 'API', value: 'api-geheim', type: 'hidden', hidden: true }],
  passkeys: [{ credentialId: 'cred1', rpId: 'bank.example', privateKey: 'PRIVATE' }],
};
const refused = (item, stored = ITEM) => assert.throws(() => unsealItem(item, stored), { name: 'SealedPlace' });

test('H1: a marker only at exactly its own secret place – notes, a text field, another field, a passkey key, the title', () => {
  const s = sealItem(ITEM);
  // the entry as sealed comes back whole
  assert.equal(unsealItem({ ...s, title: 'Neu' }, ITEM).password, 'geheim-123');
  // the password's marker in the notes of a login (no secret there) → refused
  refused({ ...s, notes: mark('password') });
  // the notes marker in a login (its notes are no secret)
  refused({ ...s, notes: mark('notes') });
  // a secret field's marker in the text field, and the text field naming itself
  refused({ ...s, fields: [{ ...s.fields[0], value: mark('fields.1.value') }, s.fields[1]] });
  refused({ ...s, fields: [{ ...s.fields[0], value: mark('fields.0.value') }, s.fields[1]] });
  // the secret field turned into a text field, its marker kept → would leave unsealed
  refused({ ...s, fields: [s.fields[0], { ...s.fields[1], type: 'text', hidden: false }] });
  // another field's marker at a secret field
  refused({ ...s, fields: [s.fields[0], { ...s.fields[1], value: mark('password') }] });
  // passkeys.0.privateKey naming the password, or another passkey
  refused({ ...s, passkeys: [{ ...s.passkeys[0], privateKey: mark('password') }] });
  refused({ ...s, passkeys: [{ ...s.passkeys[0], credentialId: 'other', privateKey: mark('pk:cred1') }] });
  // markers in places that are never secret
  refused({ ...s, title: mark('password') });
  refused({ ...s, username: mark('fields.1.value') });
  refused({ ...s, urls: [mark('password')] });
  refused({ ...s, server: { host: mark('password') } });
  // a secure note's notes are its secret – but not once the entry becomes a login
  const note = { id: 'n', type: 'note', title: 'N', notes: 'pin 1234' };
  assert.equal(unsealItem(sealItem(note), note).notes, 'pin 1234');
  refused({ ...sealItem(note), type: 'login' }, note);
  // nothing is read from a place without a secret
  assert.equal(sealedValue(ITEM, 'notes'), '');
  assert.equal(sealedValue(ITEM, 'fields.0.value'), '');
  assert.equal(sealedValue(ITEM, 'username'), '');
  assert.equal(sealedValue(ITEM, 'passkeys.0.privateKey'), '');
  assert.equal(sealedValue(ITEM, 'pk:cred1'), 'PRIVATE');
  assert.ok(secretPlace(ITEM, 'fields.1.value') && !secretPlace(ITEM, 'fields.0.value'));
  assert.ok(totpPlace({ fields: [{ type: 'totp', value: 'x' }] }, 'fields.0.value') && !totpPlace(ITEM, 'fields.1.value'));
});

test('H1: the save paths of window and bridge unseal only where the rule holds, through unsealItem', () => {
  const access = src('desktop/main/access.js');
  const body = access.slice(access.indexOf('export async function unsealForSave'), access.indexOf('export async function revealed'));
  assert.match(body, /if \(!\(await strictVault\(containerId\)\)\) throw/);
  assert.match(body, /return unsealItem\(rest, stored\);/);
  assert.match(src('desktop/main/api/items.js'), /item = await unsealForSave\(containerId, item\);/);
  assert.match(src('desktop/main/browser.js'), /const unsealed = await unsealForSave\(containerId, item\);/);
  // copySecret reads only secret places (sealedValue), and TOTP by the field's type
  assert.match(access, /const value = sealedValue\(item, place\);[\s\S]*?if \(!totpPlace\(item, place\)\) return value;/);
});

function gate({ strict = true, now = () => 1000 } = {}) {
  return new AccessConfirm({
    strict: async () => strict, settings: () => ({ appPin: 'x' }), guard: new PinGuard(), save: () => {},
    verify: async (p) => p === 'richtig', now, queue: inPinQueue,
  });
}

test('H2: a move needs a confirmation for exactly that entry; a selection is confirmed once, each entry moves once', async () => {
  const g = gate();
  await assert.rejects(g.require('A', '1', 'move'), { name: 'AccessConfirmRequired' });
  await assert.rejects(g.confirm('A', ['1', '2'], 'move', 'falsch'), { name: 'PinWrong' });
  await g.confirm('A', ['1', '2'], 'move', 'richtig');
  assert.equal(await g.require('A', '1', 'move'), true);
  await assert.rejects(g.require('A', '1', 'move'), { name: 'AccessConfirmRequired' }, 'used up');
  await assert.rejects(g.require('A', '2', 'view'), { name: 'AccessConfirmRequired' }, 'only for moving');
  await assert.rejects(g.require('B', '2', 'move'), { name: 'AccessConfirmRequired' }, 'only in that vault');
  assert.equal(await g.require('A', '2', 'move'), true);
  // a list only for moving, and not without end
  await assert.rejects(g.confirm('A', ['1', '2'], 'view', 'richtig'), { name: 'AccessPurpose' });
  await assert.rejects(g.confirm('A', Array.from({ length: MOVE_MAX + 1 }, (_, i) => `x${i}`), 'move', 'richtig'), { name: 'AccessPurpose' });
  assert.equal(await gate({ strict: false }).require('A', '1', 'move'), false);
});

test('H2: the window API asks for the move confirmation on move, moveWithAssets and movePasskey', () => {
  const items = src('desktop/main/api/items.js');
  for (const name of ['move', 'moveWithAssets']) {
    const at = items.indexOf(`  ${name}: async (fromId, toId, id, opts) => {`);
    assert.ok(at > 0, name);
    assert.match(items.slice(at, items.indexOf('\n  },', at)), /await requireMove\(fromId, toId, id\);/, name);
  }
  assert.match(items, /await requireMove\(args\?\.from\?\.containerId, args\?\.to\?\.containerId, args\?\.from\?\.id\);/);
  assert.match(items, /\['view', 'copy', 'type', 'fill', 'move', 'backup', 'share'\]\.includes\(purpose\)/);
  assert.match(src('desktop/main/access.js'), /export async function requireMove\(fromId, toId, itemId\) \{\s+if \(fromId === toId\) return false;\s+return accessConfirm\.require\(fromId, itemId, 'move'\);/);
  // selection, folder and drag and drop all move through moveItemsTo, which asks once per source vault
  const multi = src('desktop/renderer/app/multi.js');
  assert.match(multi, /withMoveAccess\(list, targetId, asked, \(\) => call\('moveWithAssets'/);
  assert.match(multi, /withMoveAccess\(list, targetId, asked, \(\) => call\('move'/);
  assert.match(src('desktop/renderer/app/dragdrop.js'), /moveItemsTo\(/);
});

/** The extension's handlers with a small vault: A (with the rule) → B. */
function bridge({ proof = true } = {}) {
  const items = new Map([['A/1', { id: '1', title: 'Eins', type: 'login', password: 'geheim', version: 'v1' }]]);
  const moves = [];
  const asked = [];
  const vault = {
    container: async (id) => ({ id, name: id, access: { write: true } }),
    getItem: async (c, id) => structuredClone(items.get(`${c}/${id}`)),
    moveItem: async (from, to, id) => { moves.push([from, to, id]); return { ...items.get(`${from}/${id}`), id: '2' }; },
    linkedEntries: async () => [],
  };
  const h = browserItemHandlers({
    vault, requireOpen: () => {}, changed: () => {}, movePasskey: async () => true, confirm: async () => true,
    confirmMove: async (from, to, id) => {
      asked.push([from, to, id]);
      if (!proof) throw new Error('Im Keevault-Fenster nicht bestätigt');
      return true;
    },
  });
  return { h, moves, asked };
}

test('H2: the extension moves out of a vault with the rule only after the proof in the app; refused → nothing moves', async () => {
  const no = bridge({ proof: false });
  await assert.rejects(no.h.move({ fromId: 'A', toId: 'B', itemId: '1' }), /nicht bestätigt/);
  assert.deepEqual(no.moves, []);
  assert.deepEqual(no.asked, [['A', 'B', '1']]);
  const yes = bridge();
  await yes.h.move({ fromId: 'A', toId: 'B', itemId: '1' });
  assert.deepEqual(yes.moves, [['A', 'B', '1']]);
  assert.match(src('desktop/browser-items.js'), /await confirmed\(await cardInfo\(fromId, toId, plan\.members[\s\S]*?\)\);\s+await confirmMove\(fromId, toId, itemId\);/);
  assert.match(src('desktop/main/browser.js'), /confirmMove: confirmMoveInApp/);
});

test('M1: write answers of window and bridge are sealed for the vault they are in', () => {
  assert.equal(writeAnswerVault('window', 'save', ['A', {}]), 'A');
  assert.equal(writeAnswerVault('window', 'move', ['A', 'B', '1']), 'B', 'the target vault');
  assert.equal(writeAnswerVault('bridge', 'moveWithAssets', { fromId: 'A', toId: 'B' }), 'B');
  assert.equal(writeAnswerVault('bridge', 'save', { containerId: 'A' }), 'A');
  assert.equal(writeAnswerVault('window', 'item', ['A', '1']), null, 'reading has its own rule');
  for (const name of ['save', 'duplicate', 'restoreVersion', 'move', 'moveWithAssets']) assert.ok(Object.hasOwn(WRITE_ANSWERS.window, name), name);
  for (const name of ['save', 'move', 'moveWithAssets']) assert.ok(Object.hasOwn(WRITE_ANSWERS.bridge, name), name);
  const one = sealedAnswer(ITEM, sealItem);
  assert.ok(isSealed(one.password) && !JSON.stringify(one).includes('geheim-123'));
  const withAssets = sealedAnswer({ saved: ITEM, moved: ['i1'], dropped: [] }, sealItem);
  assert.ok(isSealed(withAssets.saved.password) && withAssets.moved[0] === 'i1');
  assert.ok(answerHasItem(ITEM) && answerHasItem({ saved: ITEM }) && !answerHasItem(true) && !answerHasItem([ITEM]));
  // wired in both dispatchers
  assert.match(src('desktop/main/api/index.js'), /answerFor\('window', method, list, await fn\(\.\.\.list\)\)/);
  assert.match(src('desktop/main/browser.js'), /return set === browserHandlers \? answerFor\('bridge', cmd, msg, result\) : result;/);
});

async function personalFile() {
  let text = null;
  const io = { read: async () => text, write: async (s) => { text = s; } };
  const { vault } = await FileVault.create(io, { name: 'Persönlich', actor: 'kim' });
  const setup = await P.setupKeyring(vault.id, { password: 'old-password-1', passkey: { credentialId: 'c', rpId: 'localhost', prfSalt: 's', prfOutput: b64uEncode(randomBytes(32)) } }, 'kim');
  vault.doc.keyring = setup.keyring;
  await vault.unlock(setup.ck);
  return { vault, io };
}

test('N1 (Konrad, second review): the stamp lives inside the encrypted value – it can\'t be changed, an older app keeps it', async () => {
  const { vault } = await personalFile();
  await vault.setAppSettings({ confirmEach: true }, 1000);
  assert.deepEqual(await vault.appSettings(), { updated: 1000, value: { confirmEach: true, recordAt: 1000 }, at: 1000 });
  vault.doc.appSettings.updated = 5000; // the stamp outside: no say on what counts
  assert.equal((await vault.appSettings()).at, 1000);
  // an older app's settings sync: reads the value and writes it back with its own fields on top (stamp and option kept)
  const old = (await vault.appSettings()).value;
  vault.doc.appSettings = { updated: 6000, data: await vault.ck.encrypt(JSON.stringify({ ...old, lang: 'en' }), vault.aad('app-settings')) };
  const rec = await vault.appSettings();
  assert.ok(rec.value.confirmEach === true && rec.at === 1000 && rec.value.lang === 'en');
  // a record without a stamp (before this version)
  vault.doc.appSettings = { updated: 7, data: await vault.ck.encrypt(JSON.stringify({ confirmEach: false }), vault.aad('app-settings')) };
  assert.equal((await vault.appSettings()).at, 0);
  // the app: a record without a stamp never carries the option, one older than seen before is a rollback
  const access = src('desktop/main/access.js');
  assert.match(access, /const usable = typeof value\?\.confirmEach === 'boolean' && rec\.at > 0;/);
  assert.match(access, /if \(usable && rec\.at < \(marks\(\)\[containerId\] \|\| 0\)\)/);
  assert.match(access, /noteMark\(containerId, rec\.at\);/);
  assert.match(access, /noteMark\(entry\.id, updated\);/);
  // the device's memory of the rule is not changed through the window's settings
  const { PIN_ONLY_SETTINGS } = await import('../desktop/pin.js');
  for (const k of ['confirmEachVaults', 'confirmEachPersonalOnly', 'appSettingsSeen']) assert.ok(PIN_ONLY_SETTINGS.includes(k), k);
});

test('N2: a key change writes the record again under the new key, the stamp inside unchanged; the reset log writes in one step', async () => {
  P.KEY_CHANGE.enabled = true;
  const { vault, io } = await personalFile();
  await vault.setAppSettings({ confirmEach: true, confirmEachScope: 'all' }, 7);
  await vault.rekey('new-password-2');
  const fresh = new FileVault(io);
  await fresh.load();
  await fresh.unlock((await P.unlockWithPassword(fresh.keyring, 'new-password-2')).ck);
  const rec = await fresh.appSettings();
  assert.deepEqual(rec.value, { confirmEach: true, confirmEachScope: 'all', recordAt: 7 });
  assert.ok(rec.updated > 7 && rec.at === 7);
  const reset = src('desktop/main/mp-reset.js');
  assert.match(reset, /async function logReset\(entry\) \{[\s\S]*?await files\.updateAppSettings\(entry\.id, \(value\) => withReset\(value/);
  assert.ok(!/files\.setAppSettings/.test(reset));
});

test('N-A (Konrad): backup and giving access need a vault-wide confirmation of their own', async () => {
  const g = gate();
  for (const purpose of ['backup', 'share']) {
    await assert.rejects(g.require('A', VAULT_WIDE, purpose), { name: 'AccessConfirmRequired' }, purpose);
    await g.confirm('A', VAULT_WIDE, purpose, 'richtig');
    await assert.rejects(g.require('B', VAULT_WIDE, purpose), { name: 'AccessConfirmRequired' }, 'only that vault');
    assert.equal(await g.require('A', VAULT_WIDE, purpose), true);
    await assert.rejects(g.require('A', VAULT_WIDE, purpose), { name: 'AccessConfirmRequired' }, 'used up');
  }
  await g.confirm('A', VAULT_WIDE, 'share', 'richtig');
  await assert.rejects(g.require('A', VAULT_WIDE, 'backup'), { name: 'AccessConfirmRequired' }, 'not for the other purpose');
  // never vault-wide for an entry's use, never an entry for a vault-wide use
  await assert.rejects(g.confirm('A', VAULT_WIDE, 'view', 'richtig'), { name: 'AccessPurpose' });
  await assert.rejects(g.confirm('A', 'i1', 'share', 'richtig'), { name: 'AccessPurpose' });
  await assert.rejects(g.confirm('A', [VAULT_WIDE], 'move', 'richtig'), { name: 'AccessPurpose' });
  assert.equal(await gate({ strict: false }).require('A', VAULT_WIDE, 'backup'), false);
  // wiring: backup, Key Vault members and guests, file vault members, invites, passkeys, protection off
  assert.match(src('desktop/main/api/backup.js'), /async createBackup\(containerId\) \{[\s\S]*?await requireVaultUse\(containerId, 'backup'\);[\s\S]*?showSaveDialog/);
  const vaults = src('desktop/main/api/vaults.js');
  assert.match(vaults, /addMember: async \(containerId, principal, level\) => \{\s+await requireVaultUse\(containerId, 'share'\);/);
  assert.match(vaults, /async inviteGuest\(containerId, email, level\) \{\s+await requireVaultUse\(containerId, 'share'\);/);
  const files = src('desktop/main/api/files.js');
  assert.match(files, /async fileMemberOp\(containerId, op\) \{[\s\S]*?'approve addCredential setRole replace addAppCredential breakGlass'\.split\(' '\)\.includes\(op\?\.type\) \|\| \(op\?\.type === 'sharing' && op\.enabled\)[\s\S]*?await requireVaultUse\(containerId, 'share'\);/);
  // updateProtection: allowlist – everything but removeEntry asks (Konrad, 22495e2)
  assert.match(files, /async updateProtection\(containerId, op\) \{[\s\S]*?if \(!PROTECTION_FREE_OPS\.has\(op\?\.type\)\) await requireVaultUse\(containerId, 'share'\);\s+return vault\.updateProtection/);
  const free = /PROTECTION_FREE_OPS = new Set\(\[([^\]]*)\]\)/.exec(files)[1];
  assert.equal(free.trim(), "'removeEntry'");
  for (const op of ['setPassword', 'rekey', 'addEscrow', 'createInvite', 'addPasskey', 'newRecovery', 'somethingNew']) assert.ok(!free.includes(`'${op}'`), op);
  assert.match(files, /async migrateFile\(containerId, \{ email, attachment, method \}\) \{\s+await requireVaultUse\(containerId, 'share'\);/);
  assert.match(files, /async addContainerPasskey[\s\S]*?await requireVaultUse\(containerId, 'share'\);[\s\S]*?registerPasskey/);
  assert.match(files, /disableProtection: async \(containerId\) => \{[\s\S]*?await requireVaultUse\(containerId, 'share'\);/);
  assert.match(src('desktop/main/access.js'), /export const requireVaultUse = \(containerId, purpose\) => accessConfirm\.require\(containerId, VAULT_WIDE, purpose\);/);
  assert.match(src('desktop/main/api/items.js'), /\['view', 'copy', 'type', 'fill', 'move', 'backup', 'share'\]\.includes\(purpose\)/);
  // not reachable from the extension, the Windows provider or agents
  for (const f of ['desktop/main/browser.js', 'desktop/browser-items.js', 'desktop/main/agents.js', 'desktop/mcp.js', 'desktop/main/windows-passkeys.js']) {
    assert.ok(!/createBackup|addMember|inviteGuest|fileMemberOp|disableProtection/.test(src(f)), f);
  }
});

test('move of a selection (Konrad, low): the confirmations it did not use end with it', async () => {
  const g = gate();
  await g.confirm('A', ['1', '2', '3'], 'move', 'richtig');
  await g.confirm('A', 'i1', 'view', 'richtig');
  assert.equal(await g.require('A', '1', 'move'), true);
  g.drop('move');
  await assert.rejects(g.require('A', '2', 'move'), { name: 'AccessConfirmRequired' });
  assert.equal(await g.require('A', 'i1', 'view'), true, 'other uses stay');
  assert.match(src('desktop/renderer/app/multi.js'), /if \(asked\.size\) await call\('endMoveAccess'\)/);
  assert.match(src('desktop/main/api/items.js'), /endMoveAccess: \(\) => \{\s+accessConfirm\.drop\('move'\);/);
});

test('N3: the extension\'s question is held on a locked window; filling names the page', () => {
  const agents = src('desktop/main/agents.js');
  assert.match(agents, /const isHeldQuestion = \(spec\) => isAgentQuestion\(spec\) \|\| spec\?\.kind === 'confirm-each';/);
  assert.match(agents, /const held = windowLocked && isHeldQuestion\(spec\);/);
  const access = src('desktop/main/access.js');
  assert.match(access, /purpose === 'fill' && page \? PURPOSE_TEXT\.fillSite/);
  assert.match(src('extension/lib/desktop.js'), /call\('itemReveal', \{ containerId, itemId, purpose: [^}]*\.\.\.\(site \? \{ site \} : \{\}\) \}/);
  assert.match(src('extension/background.js'), /usableItem\(containerId, id, 'fill', senderHost\(sender\) \|\| ''\)/);
});

test('scope (Lucas 13.11.2026): all vaults by default, or only the personal vault; switched only with a proof', () => {
  const access = src('desktop/main/access.js');
  assert.match(access, /export async function setConfirmEach\(containerId, on, proof, scope = 'all'\)/);
  assert.match(access, /await accessConfirm\.prove\(proof, 'confirmEach'\);[\s\S]*?confirmEach: want, confirmEachScope: scope/);
  assert.match(access, /if \(rule\.on && \(rule\.scope === 'all' \|\| entry\.id === containerId\)\) return true;/);
  assert.match(access, /const scopeOf = \(v\) => \(v === 'personal' \? 'personal' : 'all'\);/);
  assert.match(src('desktop/main/api/items.js'), /setConfirmEach\(containerId, on, proof, scope === 'personal' \? 'personal' : 'all'\)/);
});
