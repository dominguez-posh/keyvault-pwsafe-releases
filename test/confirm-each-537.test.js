// #537 2b "Immer bestätigen": sealed entries, one confirmation per use (entry and purpose), and the wiring of every way a
// secret leaves the main process (window, extension bridge, AI agents, auto-type, passkeys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasSealed, isSealed, sealItem, sealedPath, sealedValue, unsealItem } from '../extension/core/sealed.js';
import { AccessConfirm } from '../desktop/access-confirm.js';
import { PinGuard, inPinQueue } from '../desktop/pin.js';
import { PasskeyPinGate } from '../desktop/passkey-pin.js';
import { McpService } from '../desktop/mcp.js';
import { totpCode } from '../extension/core/totp.js';

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const ITEM = {
  id: 'i1', type: 'login', title: 'Bank', username: 'kim', password: 'geheim-123', totp: 'JBSWY3DPEHPK3PXP', notes: 'frei',
  fields: [{ name: 'Benutzer 2', value: 'sichtbar', type: 'text', hidden: false }, { name: 'API', value: 'api-geheim', type: 'hidden', hidden: true }],
  passkeys: [{ credentialId: 'cred1', rpId: 'bank.example', privateKey: 'PRIVATE' }],
};
const json = (x) => JSON.stringify(x);

test('sealItem: no secret value left, the rest as it was', () => {
  const s = sealItem(ITEM);
  for (const secret of ['geheim-123', 'JBSWY3DPEHPK3PXP', 'api-geheim', 'PRIVATE']) assert.ok(!json(s).includes(secret), secret);
  assert.equal(s.username, 'kim');
  assert.equal(s.notes, 'frei'); // a login's notes are no secret; a secure note's are
  assert.equal(s.fields[0].value, 'sichtbar');
  assert.ok(isSealed(s.password) && sealedPath(s.password) === 'password');
  assert.deepEqual(new Set(s.sealed), new Set(['password', 'totp', 'fields.1.value', 'pk:cred1']));
  const note = sealItem({ id: 'n', type: 'note', title: 'N', notes: 'pin 1234' });
  assert.ok(isSealed(note.notes) && !json(note).includes('1234'));
  const card = sealItem({ id: 'c', type: 'card', card: { holder: 'Kim', number: '4111111111111111', cvc: '123', pin: '9876' } });
  assert.ok(!json(card).includes('4111') && !json(card).includes('9876') && card.card.holder === 'Kim');
});

test('unsealItem: a sealed entry saved back keeps the stored secrets; a new value stays; a marker at another place is refused (Konrad H1)', () => {
  const s = sealItem(ITEM);
  const saved = unsealItem({ ...s, favorite: true }, ITEM);
  assert.equal(saved.password, 'geheim-123');
  assert.equal(saved.passkeys[0].privateKey, 'PRIVATE');
  assert.equal(saved.favorite, true);
  assert.equal(saved.sealed, undefined);
  assert.equal(unsealItem({ ...s, password: 'neu-456' }, ITEM).password, 'neu-456');
  assert.throws(() => unsealItem({ ...s, fields: [s.fields[1], s.fields[0]] }, ITEM), { name: 'SealedPlace' });
  assert.ok(!hasSealed(unsealItem(s, null)) && unsealItem(s, null).password === ''); // never a marker stored
  assert.equal(sealedValue(ITEM, 'pk:cred1'), 'PRIVATE');
});

function gate({ strict = true, now = () => 1000 } = {}) {
  const guard = new PinGuard();
  const hello = [];
  const g = new AccessConfirm({
    strict: async () => strict, settings: () => ({ appPin: 'x', unlockKeys: { blob: 'b', hello: true } }), guard, save: () => {},
    verify: async (p) => p === 'richtig', hello: async (purpose) => { hello.push(purpose); return true; }, now, queue: inPinQueue,
    readItem: async () => ITEM,
  });
  return { g, guard, hello };
}

test('AccessConfirm: without a confirmation no use; one confirmation opens exactly one use of that entry and purpose', async () => {
  const { g } = gate();
  await assert.rejects(g.require('v', 'i1', 'view'), (e) => e.name === 'AccessConfirmRequired' && e.access.itemId === 'i1' && e.access.purpose === 'view');
  await g.confirm('v', 'i1', 'view', 'richtig');
  await assert.rejects(g.require('v', 'i2', 'view'), /Bestätigung/); // another entry
  await assert.rejects(g.require('v', 'i1', 'copy'), /Bestätigung/); // another purpose
  assert.equal(await g.require('v', 'i1', 'view'), true);
  await assert.rejects(g.require('v', 'i1', 'view'), /Bestätigung/); // used up
});

test('AccessConfirm: a confirmation runs out, locking ends it, the option off asks nothing', async () => {
  let t = 1000;
  const { g } = gate({ now: () => t });
  await g.confirm('v', 'i1', 'copy', 'richtig');
  t += 61_000;
  await assert.rejects(g.require('v', 'i1', 'copy'), /Bestätigung/);
  await g.confirm('v', 'i1', 'copy', 'richtig');
  g.clear();
  await assert.rejects(g.require('v', 'i1', 'copy'), /Bestätigung/);
  assert.equal(await gate({ strict: false }).g.require('v', 'i1', 'copy'), false);
});

test('AccessConfirm: a wrong secret counts on the shared counter, Hello is asked for each use, an unknown purpose is refused', async () => {
  const { g, guard, hello } = gate();
  await assert.rejects(g.confirm('v', 'i1', 'view', 'falsch'), (e) => e.name === 'PinWrong');
  assert.equal(guard.failures, 1);
  await assert.rejects(g.confirm('v', 'i1', 'view', ''), (e) => e.name === 'PinRequired');
  await g.confirm('v', 'i1', 'view', { hello: true });
  await g.confirm('v', 'i1', 'copy', { hello: true });
  assert.deepEqual(hello, ['confirm', 'confirm']);
  await assert.rejects(g.confirm('v', 'i1', 'export', 'richtig'), (e) => e.name === 'AccessPurpose');
});

test('AccessConfirm: a secret shown after a confirmation needs its own for copying (also the current TOTP code)', async () => {
  const { g } = gate();
  g.noteRevealed('v', ITEM);
  await assert.rejects(g.requireCopy('geheim-123'), (e) => e.name === 'AccessConfirmRequired' && e.access.purpose === 'copy');
  await assert.rejects(g.requireCopy((await totpCode(ITEM.totp)).code), /Bestätigung/);
  await g.requireCopy('irgendein text'); // not from such an entry
  await g.confirm('v', 'i1', 'copy', 'richtig');
  await g.requireCopy('geheim-123');
});

test('passkeys: with the option on every use asks, also with the passkey PIN switched off', async () => {
  const mk = (forced) => new PasskeyPinGate({ settings: () => ({ appPin: 'x', passkeyPin: false }), guard: new PinGuard(), save: () => {}, verify: async (p) => p === 'richtig', forced: async () => forced, forcedSeen: () => forced });
  assert.equal(await mk(false).check(''), false);
  await assert.rejects(mk(true).check(''), (e) => e.name === 'PinRequired');
  assert.equal(await mk(true).check('richtig'), true);
  assert.equal(mk(true).state().required, true);
});

function mcp({ confirmEach }) {
  const reads = [];
  const s = new McpService({
    vault: () => ({ containers: async () => [{ id: 'p', name: 'Persönlich' }], getItem: async () => ITEM }),
    admitted: () => true, confirmRead: async () => { reads.push(1); return 'session'; }, confirmEach, audit: () => {},
  });
  return { s, reads };
}

test('MCP get_entry/get_totp: the option asks with proof every time – no session or "never ask" grant counts', async () => {
  let asked = 0;
  const { s, reads } = mcp({ confirmEach: async () => { asked++; return true; } });
  const client = { agent: 'claude' };
  s.grants.set(client, { until: Date.now() + 60_000 });
  assert.equal((await s.call(client, 'get_entry', { vaultId: 'p', entryId: 'i1' })).password, 'geheim-123');
  await s.call(client, 'get_totp', { vaultId: 'p', entryId: 'i1' });
  assert.equal(asked, 2);
  assert.equal(reads.length, 0);
  const refused = mcp({ confirmEach: async () => { throw new Error('Im Keevault-Fenster nicht bestätigt'); } });
  await assert.rejects(refused.s.call(client, 'get_entry', { vaultId: 'p', entryId: 'i1' }), /nicht bestätigt/);
  const off = mcp({ confirmEach: async () => false });
  await off.s.call({ agent: 'x' }, 'get_entry', { vaultId: 'p', entryId: 'i1' });
  assert.equal(off.reads.length, 1); // the usual read question
});

test('wiring: every way out of the main process goes through the rule', () => {
  const items = src('desktop/main/api/items.js');
  assert.match(items, /if \(opts\?\.reveal !== true\) return sealFor\(containerId, item\);/);
  assert.match(items, /await accessConfirm\.require\(containerId, id, 'view'\);/);
  assert.match(items, /item = await unsealForSave\(containerId, item\);/);
  assert.match(items, /version: async .*sealFor\(containerId/);
  assert.match(items, /await accessConfirm\.requireCopy\(String\(text\)\);/);
  assert.match(src('desktop/main/access.js'), /export async function secretFor[\s\S]*?accessConfirm\.require\(containerId, itemId, 'copy'\)/);
  assert.match(src('desktop/main/typing.js'), /if \(what !== 'u'\) await accessConfirm\.require\(key\.slice\(0, i\), key\.slice\(i \+ 1\), 'type'\);/);
  const admin = src('desktop/main/api/admin.js');
  assert.match(admin, /\['rdp', 'ssh', 'teamviewer', 'bastion'\]\.includes\(method\)\) await accessConfirm\.require\(containerId, id, 'fill'\)/);
  assert.match(admin, /await accessConfirm\.require\(\.\.\.splitEntryKey\(String\(key\)\), 'fill'\)/);
  const browser = src('desktop/main/browser.js');
  assert.match(browser, /withoutPasskeyKeys\(await sealFor\(containerId, await noteServed/);
  assert.match(browser, /itemReveal: async[\s\S]*?confirmInApp\(containerId, itemId, use, ''/);
  assert.match(browser, /await confirmBrowserCopy\(text\);/);
  assert.match(browser, /const unsealed = await unsealForSave\(containerId, item\);/);
  assert.match(browser, /version: async \(msg\) => sealFor\(/);
  assert.match(src('desktop/main.js'), /confirmEach: \(vaultId, entryId, agent\) => confirmInApp\(vaultId, entryId, 'agent', agent\)/);
  assert.match(src('desktop/main/guards.js'), /forced: async \(\) => \(await access\(\)\)\.anyStrictVault\(\)/);
  assert.match(src('desktop/main/agents.js'), /pin: passkeyPin\.state\(\)\.required \|\| \(await \(await import\('\.\/access\.js'\)\)\.anyStrictVault\(\)\)/);
  assert.match(src('desktop/main/vault-rules.js'), /accessConfirm\.clear\(\);/);
  // Never while only the extension is unlocked (#507), never over the pipe: none of these is a window-locked call.
  const index = src('desktop/main/api/index.js');
  const locked = /WINDOW_LOCKED_API = new Set\(\[([\s\S]*?)\]\)/.exec(index)[1];
  for (const name of ['item', 'confirmAccess', 'copySecret', 'setConfirmEach', 'confirmEachState', 'autoType', 'copy']) assert.ok(!locked.includes(`'${name}'`), name);
  // The option is stored in the personal vault (encrypted app settings), switched only with a proof.
  const access = src('desktop/main/access.js');
  assert.match(access, /await accessConfirm\.prove\(proof, 'confirmEach'\);\s+const want = on === true;\s+const \{ updated \} = await files\.updateAppSettings/);
  assert.ok(!/confirmEach/.test(src('desktop/config.js').split('SYNC_KEYS')[1].split(']')[0]), 'never a synced setting');
});
