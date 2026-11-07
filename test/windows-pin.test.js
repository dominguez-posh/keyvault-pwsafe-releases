import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowsProvider } from '../desktop/windows-provider.js';
import { PasskeyPinGate } from '../desktop/passkey-pin.js';
import { hashPin, PinGuard } from '../desktop/pin.js';
import { encode, decode } from '../extension/core/cbor.js';
import { makeCredentialData } from '../extension/core/webauthn.js';
import { b64uEncode, randomBytes, sha256, utf8 } from '../extension/core/util.js';

// #439: the Windows passkey provider signs only with the app PIN, once per use.

async function setup(settings = {}) {
  const { passkey } = await makeCredentialData({ rpId: 'example.com', rpName: 'Example', user: { id: b64uEncode(randomBytes(16)), name: 'win@example.com', displayName: 'Win' }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] });
  const items = [{ containerId: 'kv', itemId: 'e1', title: 'Example', passkey }];
  const vault = {
    passkeyCandidates: async () => items,
    getItem: async () => ({ version: 'v1', passkeys: [passkey] }),
    saveItem: async () => ({}),
    containers: async () => [{ id: 'kv', name: 'Team' }],
    summaries: async () => [],
  };
  const s = { appPin: await hashPin('2580'), ...settings };
  const guard = new PinGuard();
  const pin = new PasskeyPinGate({ settings: () => s, guard, save: () => {} });
  const provider = new WindowsProvider({ vault: () => vault, isOpen: () => true, actor: () => 'test', show: () => {}, notify: () => {}, pin });
  const hash = await sha256(utf8('{"type":"webauthn.get"}'));
  const req = Buffer.from(encode(new Map([[1, 'example.com'], [2, hash]]))).toString('base64');
  const ask = (id) => provider.request('get', { request: req, transactionId: id });
  const choice = { containerId: 'kv', itemId: 'e1', credentialId: passkey.credentialId };
  return { provider, ask, choice, s, guard };
}

const settle = (promise) => Promise.race([promise.then(() => 'answered', () => 'failed'), new Promise((r) => setTimeout(() => r('open'), 50))]);

test('windows provider: no PIN, wrong PIN or missing PIN sign nothing and leave the request open', async () => {
  const { provider, ask, choice, s } = await setup({ appPin: null });
  const first = ask('t1');
  await assert.rejects(provider.decide('t1', { ...choice, pin: '2580' }), (e) => e.name === 'PinNotSet');
  assert.equal(await settle(first), 'open');
  assert.equal(provider.pending.size, 1, 'the request waits for a PIN being set');
  s.appPin = await hashPin('2580');
  await assert.rejects(provider.decide('t1', choice), (e) => e.name === 'PinRequired');
  await assert.rejects(provider.decide('t1', { ...choice, pin: '1111' }), (e) => e.name === 'PinWrong');
  assert.equal(await settle(first), 'open', 'still not signed');
  await provider.decide('t1', { ...choice, pin: '2580' });
  const response = decode(Buffer.from((await first).response, 'base64'));
  assert.ok(response.get(3)?.length > 0, 'a signature');
});

test('windows provider: the PIN counts for one use', async () => {
  const { provider, ask, choice } = await setup();
  const one = ask('a');
  await provider.decide('a', { ...choice, pin: '2580' });
  await one;
  const two = ask('b');
  await assert.rejects(provider.decide('b', choice), (e) => e.name === 'PinRequired');
  assert.equal(await settle(two), 'open');
  provider.cancel('b');
  await assert.rejects(two, /abgebrochen/i);
});

test('windows provider: wrong PINs add up and block like when unlocking', async () => {
  const { provider, ask, choice } = await setup();
  const pending = ask('c');
  for (let i = 0; i < 5; i++) await assert.rejects(provider.decide('c', { ...choice, pin: '0000' }), (e) => e.name === 'PinWrong');
  await assert.rejects(provider.decide('c', { ...choice, pin: '2580' }), (e) => e.name === 'PinBlocked');
  provider.cancel('c');
  await assert.rejects(pending);
});

test('windows provider: list tells the dialog whether a PIN is needed', async () => {
  const on = await setup();
  on.ask('d').catch(() => {});
  assert.deepEqual((await on.provider.list())[0].pin, { required: true, pinSet: true });
  on.provider.cancel('d');
  const off = await setup({ passkeyPin: false });
  off.ask('e').catch(() => {});
  assert.deepEqual((await off.provider.list())[0].pin, { required: false, pinSet: true });
  off.provider.cancel('e');
});

test('windows provider: with the setting off it signs as before, without a PIN', async () => {
  const { provider, ask, choice } = await setup({ passkeyPin: false });
  const one = ask('f');
  await provider.decide('f', choice);
  assert.ok((await one).response);
});

test('windows provider: the policy RequirePin keeps the PIN on although the user switched it off', async () => {
  const { provider, ask, choice } = await setup({ passkeyPin: false, requirePin: true });
  const one = ask('g');
  await assert.rejects(provider.decide('g', choice), (e) => e.name === 'PinRequired');
  provider.cancel('g');
  await assert.rejects(one);
});
