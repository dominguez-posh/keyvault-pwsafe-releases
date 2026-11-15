import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnlockService } from '../desktop/unlock-service.js';
import { PinGuard, inPinQueue } from '../desktop/pin.js';
import * as P from '../extension/core/protect.js';
import { b64uEncode } from '../extension/core/util.js';

// #537 stage 6 (2a, E1): the master password reset with the recovery stick – a real key change, the stick stays.

const MP = 'correct horse battery';
const NEW = 'brand new master pass';
const prf = (n) => b64uEncode(new Uint8Array(32).fill(n));
const stick = (n, role = 'recovery') => ({ credentialId: `cred-${n}`, rpId: 'localhost', prfSalt: 'salt', prfOutput: prf(n), label: `Stick ${n}`, device: 'key', role });

async function setup() {
  const r = await P.setupKeyring('personal-1', { password: MP });
  const keyring = await P.addEscrow(r.keyring, r.ck, stick(1));
  const vault = { keyring, ck: r.ck, locked: true, unlock: async () => { vault.locked = false; } };
  const entry = { id: 'personal-1', path: 'C:/OneDrive/Keevault-Persoenlich.kvpws', vault };
  let settings = { appPin: null, unlockKeys: null, personalDeviceKeys: {}, pinGuard: null };
  const config = { get: () => settings, update: (patch) => { settings = { ...settings, ...patch }; return settings; } };
  const dpapi = { available: async () => true, protect: async (text) => Buffer.from(`D:${text}`).toString('base64'), unprotect: async (b) => Buffer.from(b, 'base64').toString().slice(2) };
  const svc = new UnlockService({
    config, dpapi, guard: new PinGuard(), queue: inPinQueue, mirror: { wanted: () => false, unlockFactor: async () => {}, switchFactor: async () => {}, remove: async () => {} },
    personal: { entries: () => [entry], binding: async (id) => `bound:${id}`, unlockWithDk: async () => ({ stale: [] }) },
  });
  await svc.migrate({ password: MP });
  // What the main process does: open with the stick, key change (#402) with the new MP, onRekey → rotate.
  const open = (n) => async () => P.unlockWithEscrow(entry.vault.keyring, `cred-${n}`, prf(n), { role: 'recovery' });
  const rekey = async (ck, password) => {
    const r2 = await P.rekeyKeyring(entry.vault.keyring, ck, { password });
    entry.vault.keyring = r2.keyring;
    entry.vault.ck = r2.ck;
    await svc.rotate(password, [{ entry, ck: r2.ck }]);
    return { recoveryKey: r2.recoveryKey };
  };
  return { svc, entry, open, rekey, settings: () => settings };
}

test('reset with the recovery stick: real key change, old MP opens nothing, the stick still opens, new DK', async () => {
  const s = await setup();
  const before = s.settings().unlockKeys.blob;
  const r = await s.svc.resetWithStick(s.entry, NEW, { open: s.open(1), rekey: s.rekey });
  assert.match(r.recoveryKey, /^RK-/);
  assert.ok(r.dk);
  assert.notEqual(s.settings().unlockKeys.blob, before, 'a new record (new DK)');
  assert.equal(P.keyVersionOf(s.entry.vault.keyring), 2, 'a new key generation');
  await assert.rejects(P.unlockWithPassword(s.entry.vault.keyring, MP), { name: 'UnlockError' }, 'the old MP opens nothing');
  await P.unlockWithPassword(s.entry.vault.keyring, NEW);
  await P.unlockWithEscrow(s.entry.vault.keyring, 'cred-1', prf(1), { role: 'recovery' });
  assert.equal(await s.svc.checkSecret(MP), null, 'the old MP is not the app MP any more');
  assert.ok(await s.svc.checkSecret(NEW));
});

test('a stick that does not fit counts; a cancelled ceremony does not; too short changes nothing', async () => {
  const s = await setup();
  const blob = s.settings().unlockKeys.blob;
  await assert.rejects(s.svc.resetWithStick(s.entry, 'short', { open: s.open(1), rekey: s.rekey }), /mindestens 12/);
  await assert.rejects(s.svc.resetWithStick(s.entry, NEW, { open: s.open(2), rekey: s.rekey }), { name: 'WrongSecret' });
  assert.ok(s.settings().pinGuard, 'a wrong stick is counted');
  const counted = JSON.stringify(s.settings().pinGuard);
  const cancel = async () => { throw Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }); };
  await assert.rejects(s.svc.resetWithStick(s.entry, NEW, { open: cancel, rekey: s.rekey }), /cancelled/);
  assert.equal(JSON.stringify(s.settings().pinGuard), counted, 'a cancel is not counted');
  assert.equal(s.settings().unlockKeys.blob, blob, 'nothing changed');
  assert.equal(P.keyVersionOf(s.entry.vault.keyring), 1);
});

test('a break-glass stick is no recovery stick, and a vault outside the lineage is refused', async () => {
  const s = await setup();
  s.entry.vault.keyring = await P.addEscrow(s.entry.vault.keyring, s.entry.vault.ck, stick(3, 'breakglass'));
  await assert.rejects(s.svc.resetWithStick(s.entry, NEW, { open: s.open(3), rekey: s.rekey }), { name: 'WrongSecret' });
  const other = await P.setupKeyring('personal-2', { password: 'another password!' });
  const foreign = { id: 'personal-2', path: 'x', vault: { keyring: other.keyring } };
  let rekeyed = false;
  await assert.rejects(s.svc.resetWithStick(foreign, NEW, { open: async () => ({ ck: other.ck }), rekey: async () => { rekeyed = true; } }), { name: 'NotBound' });
  assert.equal(rekeyed, false, 'no key change for a vault this device is not bound to');
});

test('wiring: the stick resets only with role recovery; adding one needs the fresh master password', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../desktop/main/mp-reset.js', import.meta.url), 'utf8');
  assert.match(src, /unlockWithEscrow\(entry\.vault\.keyring, prf\.credentialId, prf\.prfOutput, \{ role: 'recovery' \}\)/);
  assert.match(src, /if \(isMigrated\(\)\) consumeFresh\('personal-keyring'\);\n\s+const keyring/, 'a fresh MP or RK before the stick is registered');
  assert.match(src, /markRecoveryRenewed\(entry\.id\)/, 'the new recovery key has to be confirmed (#399)');
  assert.match(src, /await unlockService\.unlockWithDk\(dk\);/, 'exactly one unlock after the reset');
  const files = readFileSync(new URL('../desktop/main/api/files.js', import.meta.url), 'utf8');
  assert.match(files, /const FRESH_OPS = new Set\(\[[^\]]*'removeEntry'/, 'removing a stick needs the fresh MP too');
});

test('Konrad M1/N1/N2/N3: stick removal only by a key change, vault locked again on failure, queued, the record\'s vault', async () => {
  const { readFileSync } = await import('node:fs');
  // M1: removing the entry alone is refused; the key change with dropEscrow ends it, the old copy opens no more with it.
  const r = await P.setupKeyring('personal-9', { password: MP });
  const keyring = await P.addEscrow(r.keyring, r.ck, stick(5));
  const id = keyring.entries.find((e) => e.type === 'escrow').id;
  await assert.rejects(P.applyKeyringOp(keyring, r.ck, { type: 'removeEntry', entryId: id }), /Schlüsselwechsel/);
  const next = await P.rekeyKeyring(keyring, r.ck, { password: MP, dropEscrow: [id] });
  await assert.rejects(P.unlockWithEscrow(next.keyring, 'cred-5', prf(5)), { name: 'UnlockError' }, 'the new keyring knows the stick no more');
  const src = readFileSync(new URL('../desktop/main/mp-reset.js', import.meta.url), 'utf8');
  assert.match(src, /type: 'rekey', password: next, dropEscrow: \[entryId\]/); // #539 M3: next = the current or a new password
  assert.match(src, /const next = newPassword == null \|\| newPassword === '' \? text : String\(newPassword\);/);
  assert.match(src, /await verifyPasswordCounted\(text\)/, 'the current MP (counted) proves the removal');
  assert.match(src, /if \(wasLocked && !entry\.vault\.locked\) entry\.vault\.lock\(\);/, 'N1');
  assert.match(src, /record\?\.lineage\?\.vault/, 'N3');
  const svc = readFileSync(new URL('../desktop/unlock-service.js', import.meta.url), 'utf8');
  assert.match(svc, /return this\.queue\(\(\) => this\.resetWithStickNow\(entry, password, ops\)\);/, 'N2');
  const files = readFileSync(new URL('../desktop/files.js', import.meta.url), 'utf8');
  assert.match(files, /vault\.rekey\(op\.password, actor, \{ dropEscrow:/);
});
