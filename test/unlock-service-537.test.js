import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { UnlockService } from '../desktop/unlock-service.js';
import { PinGuard, hashPin, verifyPin, inPinQueue } from '../desktop/pin.js';
import * as U from '../desktop/unlock-keys.js';
import { rekeyKeyring, setupKeyring } from '../extension/core/protect.js';
import { PasskeyPinGate } from '../desktop/passkey-pin.js';
import { CopyPinGate } from '../desktop/copy-pin.js';
import { ExportPinGate } from '../desktop/export-pin.js';

// #537 stage 2: the master password replaces the PIN hash (desktop/unlock-service.js) – with stand-ins for the settings,
// DPAPI, the personal vault and the offline mirror. Konrad's conditions each have a counter-test here.

const MP = 'correct horse battery';
const OLD_PIN = '246813';

function harness({ appPin = null, personal = [], offlineMirror = false } = {}) {
  let settings = { appPin, unlockKeys: null, personalDeviceKeys: {}, pinGuard: null, offlineMirror };
  const writes = [];
  const config = { get: () => settings, update: (patch) => { writes.push(Object.keys(patch)); settings = { ...settings, ...patch }; return settings; } };
  const dpapi = { available: async () => true, protect: async (text) => Buffer.from(`D:${text}`).toString('base64'), unprotect: async (b) => Buffer.from(b, 'base64').toString().slice(2) };
  const mirror = { factors: [], switched: [], wanted: () => offlineMirror, unlockFactor: async (f) => mirror.factors.push(f), switchFactor: async (f) => mirror.switched.push(f), remove: async () => {} };
  const unlocked = [];
  const h = { stale: [], pinForgotten: 0 };
  const svc = new UnlockService({
    config, dpapi, guard: new PinGuard(), queue: inPinQueue, mirror, recentPin: () => null, forgetPin: () => { h.pinForgotten++; },
    personal: {
      entries: () => personal,
      binding: async (id, raw, dk) => JSON.stringify({ id, ct: U.sealWith(U.subKey(dk, 'personal', id), Buffer.from(raw), id) }),
      unlockWithDk: async (dk) => { unlocked.push(dk); return { stale: h.stale }; },
    },
  });
  return Object.assign(h, { svc, config, writes, mirror, unlocked, settings: () => settings });
}

async function personalVault(password = MP) {
  const { keyring, ck } = await setupKeyring('personal-1', { password });
  const vault = { keyring, ck, locked: true, unlock: async () => { vault.locked = false; } };
  return { entry: { id: 'personal-1', path: 'C:/OneDrive/Keevault-Persoenlich.kvpws', vault }, ck };
}

test('#537 (Konrad): the move is ONE settings write; appPin keeps the old PIN hash, never the MP', async () => {
  const appPin = await hashPin(OLD_PIN);
  const { entry } = await personalVault();
  const h = harness({ appPin, personal: [entry], offlineMirror: true });
  const r = await h.svc.migrate({ password: MP, pin: OLD_PIN });
  assert.equal(r.pinKept, true);
  const big = h.writes.filter((keys) => keys.includes('unlockKeys'));
  assert.equal(big.length, 1, 'one write carries the record');
  assert.deepEqual(big[0].sort(), ['appPin', 'personalDeviceKeys', 'pinGuard', 'unlockKeys']);
  assert.equal(h.settings().appPin, appPin, 'E3: an older app keeps asking the old PIN');
  assert.equal(await verifyPin(MP, h.settings().appPin), false, 'appPin is never a hash of the MP');
  assert.ok(h.settings().personalDeviceKeys[entry.path], 'the personal vault is bound to the new DK in the same write');
  assert.equal(entry.vault.locked, false);
  assert.equal(h.mirror.switched.length, 1, 'the mirror moves to DK');
  assert.ok(h.svc.isMigrated());
});

test('#537 (Konrad): an error before the write leaves the old state as it was', async () => {
  const appPin = await hashPin(OLD_PIN);
  const { entry } = await personalVault();
  const h = harness({ appPin, personal: [entry] });
  const before = JSON.stringify(h.settings());
  await assert.rejects(h.svc.migrate({ password: 'not the vault password', pin: OLD_PIN }), /nicht das Masterpasswort/);
  await assert.rejects(h.svc.migrate({ password: MP, pin: '999999' }), /Falsche PIN/);
  await assert.rejects(h.svc.migrate({ password: MP }), { name: 'PinRequired' }, 'without the old PIN nothing moves');
  const after = { ...h.settings(), pinGuard: null };
  assert.equal(JSON.stringify(after), before, 'nothing but the counter changed');
});

test('#537 E3/N1: without a PIN, appPin is a random hash; with the new PIN, its hash – never the MP', async () => {
  const none = harness();
  await assert.rejects(none.svc.migrate({ password: 'too short' }), /mindestens 12/);
  await none.svc.migrate({ password: MP });
  assert.ok(none.settings().appPin?.hash && none.settings().appPin.random, 'no PIN: random – an older app never opens unchecked');
  assert.equal(await verifyPin(MP, none.settings().appPin), false);
  const h = harness();
  await h.svc.migrate({ password: MP, newPin: '135790' });
  const ap = h.settings().appPin;
  assert.equal(await verifyPin(MP, ap), false);
  assert.equal(await verifyPin('135790', ap), true, 'N1: the PIN that unlocks here');
  assert.equal(h.svc.info().pin, true);
});

test('#537 N1: appPin follows the PIN wrapper – changed, removed, deleted by E6, ended by a new MP', async () => {
  const h = harness();
  await h.svc.migrate({ password: MP, newPin: '135790' });
  await h.svc.setPinWrapWithPassword(MP, '111111');
  assert.equal(await verifyPin('111111', h.settings().appPin), true);
  assert.equal(await verifyPin('135790', h.settings().appPin), false, 'the old PIN no longer opens an older app');
  await h.svc.setPinWrapWithPassword(MP, null);
  assert.ok(h.settings().appPin.random && !(await verifyPin('111111', h.settings().appPin)));
  await h.svc.setPinWrapWithPassword(MP, '222222');
  h.svc.guard.waitSeconds = () => 0;
  for (let i = 0; i < 10; i++) await assert.rejects(h.svc.verifyUnlock('000000', { kind: 'pin' }));
  assert.ok(h.settings().appPin.random && !(await verifyPin('222222', h.settings().appPin)), 'E6 takes the hash along');
  // Moving with keepPin false: the old PIN does not stay in appPin either.
  const old = harness({ appPin: await hashPin(OLD_PIN) });
  await old.svc.migrate({ password: MP, pin: OLD_PIN, keepPin: false });
  assert.equal(await verifyPin(OLD_PIN, old.settings().appPin), false);
});

test('#537 M1: the move checks the MP first and counted; a right PIN never resets it; the old PIN is forgotten', async () => {
  const appPin = await hashPin(OLD_PIN);
  const { entry } = await personalVault();
  const h = harness({ appPin, personal: [entry] });
  await assert.rejects(h.svc.migrate({ password: 'wrong master password', pin: OLD_PIN }), { name: 'WrongSecret' });
  assert.equal(h.svc.guard.failures, 1, 'a wrong MP counts');
  await assert.rejects(h.svc.migrate({ password: MP, pin: '999999' }), /Falsche PIN/);
  assert.equal(h.svc.guard.failures, 2);
  await h.svc.migrate({ password: MP, pin: OLD_PIN });
  assert.equal(h.svc.guard.failures, 2, 'the right PIN did not reset the count');
  assert.equal(h.pinForgotten, 1, 'setRecentPin(null) after the move');
});

test('#537 M2: after a key change on another device the old MP or the PIN no longer unlock – the new MP is asked', async () => {
  const { entry, ck } = await personalVault();
  const h = harness({ personal: [entry] });
  await h.svc.migrate({ password: MP, newPin: '135790' });
  entry.vault.keyring = (await rekeyKeyring(entry.vault.keyring, ck, { password: 'a brand new master password' })).keyring;
  h.stale = [entry]; // the binding holds the old key: the vault refuses it
  h.svc.forget(); // locked in between
  await assert.rejects(h.svc.verifyUnlock(MP), { name: 'MasterPasswordChanged' });
  await assert.rejects(h.svc.verifyUnlock('135790', { kind: 'pin' }), { name: 'MasterPasswordChanged' });
  assert.equal(h.svc.guard.consume(), false, 'no unlock was allowed');
  assert.equal(h.svc.recentDk(), null);
  h.stale = [];
  assert.ok(await h.svc.verifyUnlock('a brand new master password'), 'the new MP (successor of the bound vault) unlocks');
});

test('#537: unlocking takes MP or PIN, opens with DK, allows exactly one unlock; the window gets no key material', async () => {
  const h = harness({ offlineMirror: true });
  await h.svc.migrate({ password: MP, newPin: '135790' });
  assert.ok(await h.svc.verifyUnlock(MP));
  assert.ok(await h.svc.verifyUnlock('135790', { kind: 'pin' }));
  await assert.rejects(h.svc.verifyUnlock('135790', { kind: 'password' }), { name: 'WrongSecret' }, 'kind password never tries the PIN');
  await assert.rejects(h.svc.verifyUnlock(MP, { kind: 'pin' }), { name: 'WrongSecret' });
  assert.equal(h.unlocked.length, 2);
  assert.equal(h.mirror.factors.length, 2);
  assert.deepEqual(Object.keys(h.svc.info()).sort(), ['hello', 'helloOffer', 'migrated', 'minLength', 'pin']); // helloOffer: null | 'hello' | 'hello-or-pin' (no key material)
  assert.ok(!JSON.stringify(h.settings().unlockKeys).includes(MP));
});

test('#537 E6: wrong PINs count in the shared lock AND their own counter; 10 delete the PIN wrapper, the MP still opens', async () => {
  const h = harness();
  await h.svc.migrate({ password: MP, newPin: '135790' });
  h.svc.guard.waitSeconds = () => 0; // the shared lock's waits are tested in pin tests; here the PIN's own counter
  for (let i = 0; i < 10; i++) await assert.rejects(h.svc.verifyUnlock('000000', { kind: 'pin' }), { name: 'WrongSecret' });
  assert.equal(h.svc.info().pin, false, 'PIN wrapper gone');
  await assert.rejects(h.svc.verifyUnlock('135790', { kind: 'pin' }), { name: 'WrongSecret' });
  assert.ok(await h.svc.verifyUnlock(MP));
});

test('#537 (Konrad): a new MP gets a new DK – old PIN wrapper, old bindings and the old DK end', async () => {
  const { entry } = await personalVault();
  const h = harness({ personal: [entry], offlineMirror: true });
  await h.svc.migrate({ password: MP, newPin: '135790' });
  const oldRecord = await h.svc.readRecord();
  const oldDk = await U.openWithPassword(oldRecord, MP);
  // The MP changed on another device (#402 key change there): the keyring now takes only the new one.
  const NEW = 'a brand new master password';
  const first = await rekeyKeyring(entry.vault.keyring, entry.vault.ck, { password: 'an intermediate password' });
  entry.vault.keyring = (await rekeyKeyring(first.keyring, first.ck, { password: NEW })).keyring; // two changes: the lineage holds
  assert.ok(await h.svc.verifyUnlock(NEW), 'the new MP of the vault becomes the app MP');
  const rec = await h.svc.readRecord();
  assert.equal(rec.pin, undefined, 'the PIN wrapper of the old DK is gone');
  assert.equal(U.dkMatches(rec, oldDk), false, 'a new DK');
  assert.equal(await U.openWithPassword(rec, MP), null, 'the old MP opens nothing on this device');
  await assert.rejects(h.svc.verifyUnlock(MP), { name: 'WrongSecret' });
  assert.equal(h.mirror.switched.length, 2, 'the mirror moved again');
});

test('#537 (Konrad): changing the personal vault keys needs a fresh MP or recovery key – purpose-bound and used once', async () => {
  const rk = await setupKeyring('personal-1', { password: MP });
  const entry = { id: 'personal-1', path: 'p', vault: { keyring: rk.keyring, locked: false, unlock: async () => {} } };
  const h = harness({ personal: [entry] });
  await h.svc.migrate({ password: MP });
  assert.throws(() => h.svc.consumeFresh('personal-keyring'), { name: 'FreshProofRequired' });
  await h.svc.verifyUnlock(MP);
  assert.throws(() => h.svc.consumeFresh('personal-keyring'), { name: 'FreshProofRequired' }, 'an unlock is no fresh proof');
  await h.svc.confirmFresh({ password: MP }, 'personal-keyring');
  h.svc.consumeFresh('personal-keyring');
  assert.throws(() => h.svc.consumeFresh('personal-keyring'), { name: 'FreshProofRequired' }, 'used once');
  await assert.rejects(h.svc.confirmFresh({ password: MP }, 'export'), /unknown purpose/);
  await h.svc.confirmFresh({ code: rk.recoveryKey }, 'personal-keyring');
  h.svc.consumeFresh('personal-keyring');
  await assert.rejects(h.svc.confirmFresh({ code: 'RK-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA' }, 'personal-keyring'), { name: 'WrongSecret' });
  await assert.rejects(h.svc.confirmFresh({ password: '135790' }, 'personal-keyring'), { name: 'WrongSecret' });
  await h.svc.confirmFresh({ password: MP }, 'personal-keyring');
  h.svc.forget();
  assert.throws(() => h.svc.consumeFresh('personal-keyring'), { name: 'FreshProofRequired' }, 'locking ends it');
});

test('#537: the PIN wrapper is set, changed or removed only with the MP', async () => {
  const h = harness();
  await h.svc.migrate({ password: MP, newPin: '135790' });
  await assert.rejects(h.svc.setPinWrapWithPassword('135790', '111111'), { name: 'WrongSecret' }, 'the PIN cannot replace itself');
  await assert.rejects(h.svc.setPinWrapWithPassword(MP, '123'), /mindestens 6/);
  await h.svc.setPinWrapWithPassword(MP, '111111');
  assert.ok(await h.svc.verifyUnlock('111111', { kind: 'pin' }));
  await h.svc.setPinWrapWithPassword(MP, null);
  assert.equal(h.svc.info().pin, false);
});

test('#537: the PIN gates (passkey, copy, export) accept the MP or the PIN wrapper once set up', async () => {
  const h = harness();
  await h.svc.migrate({ password: MP, newPin: '135790' });
  const settings = () => ({ ...h.settings(), passkeyPin: true });
  const verify = (p) => h.svc.secretMatches(p);
  const guard = new PinGuard();
  const gate = new PasskeyPinGate({ settings, guard, save: () => {}, verify });
  assert.equal(await gate.check(MP), true);
  assert.equal(await gate.check('135790'), true);
  await assert.rejects(gate.check(OLD_PIN), { name: 'PinWrong' });
  const copy = new CopyPinGate({ settings, guard, save: () => {}, verify });
  assert.equal(await copy.confirm('v1', MP), true);
  const exp = new ExportPinGate({ settings, guard, save: () => {}, verify });
  assert.ok(await exp.confirm('v1', '135790'));
  // Without the move they keep the old PIN hash.
  const legacy = harness({ appPin: await hashPin(OLD_PIN) });
  assert.equal(await legacy.svc.secretMatches(OLD_PIN), true);
  assert.equal(await legacy.svc.secretMatches(MP), false);
});

test('#537: wiring – unlockKeys is settings the window cannot write, the gates and api.verifyPin go through the service', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  assert.match(read('desktop/pin.js'), /'unlockKeys', 'personalVaults',/);
  assert.match(read('desktop/main/guards.js'), /verify: \(pin\) => secretMatches\(pin\)/);
  assert.match(read('desktop/main/api/app.js'), /verifyPin: \(pin, kind\) => \(isMigrated\(\) \? verifyUnlock\(/);
  assert.match(read('desktop/main/session.js'), /forgetDk\(\);/);
  // Personal vault keyring changes take the fresh proof.
  assert.match(read('desktop/main/api/files.js'), /const FRESH_OPS = new Set\(\['setPassword', 'rekey', 'newRecovery', 'addPasskey', 'addEscrow', 'removeEntry'\]\)/);
});

test('#537 H2: a vault that is not the bound one (or its successor) never makes its password the app MP', async () => {
  const { entry } = await personalVault();
  const h = harness({ personal: [entry] });
  await h.svc.migrate({ password: MP });
  // Someone with write access to the file, or an adopted foreign vault: same id, a new keyring of their own.
  const ATTACKER = 'attacker chosen password';
  const foreign = await setupKeyring('personal-1', { password: ATTACKER });
  const original = entry.vault.keyring;
  entry.vault.keyring = foreign.keyring;
  await assert.rejects(h.svc.verifyUnlock(ATTACKER), { name: 'WrongSecret' });
  assert.ok(await U.openWithPassword(await h.svc.readRecord(), MP), 'the app MP stays');
  assert.equal(await h.svc.mayBind(entry, foreign.ck), false, 'its key is not bound to this device');
  entry.vault.keyring = original;
  assert.equal(await h.svc.mayBind(entry, entry.vault.ck), true);
  // The adoption path takes a fresh current MP, for its own purpose only.
  assert.throws(() => h.svc.consumeFresh('personal-adopt'), (e) => e.name === 'FreshProofRequired' && e.purpose === 'personal-adopt');
  await h.svc.confirmFresh({ password: MP }, 'personal-keyring');
  assert.throws(() => h.svc.consumeFresh('personal-adopt'), { name: 'FreshProofRequired' }, 'a confirmation for another purpose does not count');
  await assert.rejects(h.svc.confirmFresh({ code: 'RK-AAAA' }, 'personal-adopt'), /Masterpasswort/);
  await h.svc.confirmFresh({ password: MP }, 'personal-adopt');
  h.svc.consumeFresh('personal-adopt');
});

test('#537 H2: wiring – adopting checks before the vault opens; binding needs the lineage; personalVaults is PIN-only', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const files = read('desktop/main/api/files.js');
  assert.ok(files.indexOf("consumeFresh('personal-adopt')") > 0 && files.indexOf("consumeFresh('personal-adopt')") < files.indexOf('await vault.unlockContainer(containerId, params)'));
  assert.match(read('desktop/main/personal.js'), /if \(!dk \|\| !\(await mayBind\(entry, entry\.vault\.ck\)\)\) return;/);
  assert.match(read('desktop/pin.js'), /'unlockKeys', 'personalVaults',/);
});

test('#537 (Konrad, check of 11001ce): wiring – no race on the personal vault file; a refused unlock leaves nothing open', () => {
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const files = read('desktop/main/api/files.js');
  const unlockAt = files.indexOf('await vault.unlockContainer(containerId, params)');
  assert.ok(files.indexOf('await entry.vault.load()') > 0 && files.indexOf('await entry.vault.load()') < unlockAt, 'the file is read again before the check');
  assert.ok(files.indexOf('!== checkedFp') > unlockAt, 'the opened key must be the checked one');
  assert.match(files, /else if \(known && entry\.vault\.ck\) await adoptLineage\(entry, entry\.vault\.ck\);/, 'the lineage follows only the app MP');
  assert.match(read('desktop/main/personal.js'), /if \(stale\.length && openedNow\.length\) \{\s*for \(const entry of openedNow\) entry\.vault\.lock\(\);/);
  const ui = read('extension/core/ui-protect.js');
  assert.match(ui, /escrowList\(methods\.escrows, true\)/);
  assert.match(ui, /\(e\.valid === true\) === valid/);
  assert.match(read('desktop/files.js'), /withEscrowValidity\(describeKeyring\(vault\.keyring, rpId\), vault\.keyring, vault\.ck\)/);
  assert.match(read('extension/core/session.js'), /withEscrowValidity\(describeKeyring\(keyring, rpId\), keyring, key\)/);
});

test('#537 live test: "Windows Hello aktivieren?" once per device after the move – only Hello when a PIN was kept', async () => {
  const kept = harness();
  assert.equal(kept.svc.helloOfferDue(), null, 'no master password yet: nothing to ask');
  await kept.svc.migrate({ password: MP, newPin: '135790' });
  assert.equal(kept.svc.helloOfferDue(), 'hello', 'a PIN from before counts as the chosen alternative');
  assert.equal(kept.svc.info().helloOffer, 'hello', 'the window learns it through unlockInfo');
  kept.svc.helloOffered();
  assert.equal(kept.svc.helloOfferDue(), null, 'asked once: never again');
  assert.equal(kept.settings().helloOffered, true, 'remembered in the settings (DEFAULTS, device only)');
  const none = harness();
  await none.svc.migrate({ password: MP });
  assert.equal(none.svc.helloOfferDue(), 'hello-or-pin', 'without a PIN: Hello or the app PIN');
  none.config.update({ unlockKeys: { ...none.settings().unlockKeys, hello: { name: 'Keevault-x' } } });
  assert.equal(none.svc.helloOfferDue(), null, 'Hello on already: nothing');
  const { DEVICE_KEYS } = await import('../desktop/window-lock-settings.js');
  const { DEVICE_ONLY } = await import('../desktop/settings-sealed.js');
  const { PIN_ONLY_SETTINGS } = await import('../desktop/pin.js');
  for (const list of [DEVICE_KEYS, DEVICE_ONLY, PIN_ONLY_SETTINGS]) assert.ok(list.includes('helloOffered'));
  assert.match(readFileSync('desktop/config.js', 'utf8'), /\n {2}helloOffered: false,/);
});
