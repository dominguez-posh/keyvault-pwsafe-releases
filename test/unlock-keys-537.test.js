import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as U from '../desktop/unlock-keys.js';
import { hashPin, verifyPin } from '../desktop/pin.js';

// #537: the device key DK and its wrappers (MP, optional PIN, Windows Hello) – desktop/unlock-keys.js.

const MP = 'correct horse battery';

test('#537: the MP opens DK; a wrong MP, a short MP or another record do not', async () => {
  const dk = U.newDk();
  const rec = await U.createRecord(dk, MP);
  assert.ok((await U.openWithPassword(rec, MP)).equals(dk));
  assert.equal(await U.openWithPassword(rec, 'correct horse batterz'), null);
  await assert.rejects(U.createRecord(dk, 'eleven char'), /MP_TOO_SHORT:12/);
  await assert.rejects(U.createRecord(dk, 'thirteen char', { minLength: 16 }), /MP_TOO_SHORT:16/, 'a policy raises the minimum');
  const other = await U.createRecord(U.newDk(), MP);
  assert.equal(await U.openWithPassword({ ...rec, pw: other.pw }, MP), null, 'a wrapper of another record opens nothing (AAD, check)');
  assert.ok(!JSON.stringify(rec).includes(dk.toString('base64')), 'DK is never stored in clear');
});

test('#537: sub keys are purpose-bound and differ per context', () => {
  const dk = U.newDk();
  assert.notDeepEqual(U.subKey(dk, 'personal', 'a'), U.subKey(dk, 'personal', 'b'));
  assert.notDeepEqual(U.subKey(dk, 'personal', ''), U.subKey(dk, 'offline', ''));
  assert.throws(() => U.subKey(dk, 'other'));
});

test('#537 E6: the PIN wrapper has its own counter – reset only by a correct PIN, gone after 10 wrong ones', async () => {
  const dk = U.newDk();
  let rec = await U.setPinWrap(await U.createRecord(dk, MP), dk, '123456');
  await assert.rejects(U.setPinWrap(rec, dk, '12345'), /PIN_TOO_SHORT/);
  await assert.rejects(U.setPinWrap(rec, U.newDk(), '123456'), /DK_MISMATCH/, 'only the real DK gets a PIN wrapper');
  for (let i = 1; i <= 9; i++) {
    const r = await U.openWithPin(rec, '000000');
    assert.equal(r.dk, null);
    rec = r.record;
    assert.equal(rec.pin.failures, i);
  }
  // A correct MP in between does not reset the PIN's counter.
  assert.ok(await U.openWithPassword(rec, MP));
  assert.equal(rec.pin.failures, 9);
  const ok = await U.openWithPin(rec, '123456');
  assert.ok(ok.dk.equals(dk));
  assert.equal(ok.record.pin.failures, 0, 'a correct PIN resets it');
  rec = ok.record;
  for (let i = 0; i < 10; i++) rec = (await U.openWithPin(rec, '999999')).record;
  assert.equal(rec.pin, undefined, 'the 10th wrong PIN deletes the wrapper');
  assert.equal((await U.openWithPin(rec, '123456')).dk, null, 'then the right PIN opens nothing any more');
  assert.ok((await U.openWithPassword(rec, MP)).equals(dk), 'the MP still opens');
  assert.throws(() => U.dropWrap(rec, 'pw'));
});

test('#537 E3: appPin after the move – the old PIN hash stays, else a random hash; never a hash of the MP', async () => {
  const old = await hashPin('123456');
  assert.equal(await U.legacyAppPin(old), old);
  const random = await U.legacyAppPin(null);
  assert.ok(random.hash && random.random);
  assert.equal(await verifyPin(MP, random), false);
  assert.equal(await verifyPin('', random), false);
  const patch = await U.migrationPatch({ previousAppPin: null, unlockKeys: { v: 1, blob: 'x' }, personalDeviceKeys: { p: 'b' } });
  assert.equal(await verifyPin(MP, patch.appPin), false, 'appPin is never the MP');
  assert.deepEqual(Object.keys(patch).sort(), ['appPin', 'personalDeviceKeys', 'pinGuard', 'unlockKeys'], 'one patch, one write');
  await assert.rejects(U.migrationPatch({ previousAppPin: old, unlockKeys: null }), /no record/);
});

test('#537 (Konrad): Hello only with a valid PKCS#1 v1.5 signature of the stored key – no yes/no, key material', async () => {
  const dk = U.newDk();
  const rec0 = await U.createRecord(dk, MP);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const challenge = crypto.randomBytes(32);
  const sign = (data, key = privateKey) => crypto.sign('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PADDING });
  const rec = U.setHelloWrap(rec0, dk, { name: 'Keevault-x', publicKey: spki, signature: sign(challenge), challenge });
  assert.ok(U.helloChallenge(rec).equals(challenge));
  assert.ok(U.openWithHello(rec, sign(challenge)).equals(dk));
  assert.equal(U.openWithHello(rec, Buffer.alloc(256, 1)), null, 'garbage is no signature');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  assert.equal(U.openWithHello(rec, sign(challenge, other)), null, 'a reset Hello container (new key) opens nothing');
  // PSS is randomised and no PKCS#1 v1.5 signature: refused at set-up.
  const pss = crypto.sign('sha256', challenge, { key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING });
  assert.throws(() => U.setHelloWrap(rec0, dk, { name: 'x', publicKey: spki, signature: pss, challenge }), /HELLO_SIGNATURE/);
  const small = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => U.setHelloWrap(rec0, dk, {
    name: 'x', publicKey: small.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), signature: sign(challenge, small.privateKey), challenge,
  }), /HELLO_SIGNATURE/, 'RSA below 2048 bit is refused');
  assert.equal(U.dropWrap(rec, 'hello').hello, undefined);
});
