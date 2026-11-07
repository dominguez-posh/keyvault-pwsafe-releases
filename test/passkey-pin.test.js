import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, PinGuard } from '../desktop/pin.js';
import { PasskeyPinGate, passkeyPinOn } from '../desktop/passkey-pin.js';

async function gate(settings = {}) {
  const s = { appPin: await hashPin('2580'), ...settings };
  const saved = [];
  const guard = new PinGuard();
  return { gate: new PasskeyPinGate({ settings: () => s, guard, save: (x) => saved.push(x) }), guard, saved, s };
}

const fails = (promise, name) => assert.rejects(promise, (e) => e.name === name);

test('passkey PIN: on by default, off only by the user, fixed on by the policy RequirePin', () => {
  assert.equal(passkeyPinOn({}), true);
  assert.equal(passkeyPinOn({ passkeyPin: true }), true);
  assert.equal(passkeyPinOn({ passkeyPin: false }), false);
  assert.equal(passkeyPinOn({ passkeyPin: false, requirePin: true }), true, 'the organization wins');
});

test('passkey PIN: no PIN set → nothing is used, whatever is sent', async () => {
  const { gate: g } = await gate({ appPin: null });
  assert.throws(() => g.assertUsable(), (e) => e.name === 'PinNotSet');
  await fails(g.check('2580'), 'PinNotSet');
  await fails(g.check(''), 'PinNotSet');
});

test('passkey PIN: wrong, empty or missing PIN is refused, the right one passes once', async () => {
  const { gate: g } = await gate();
  await fails(g.check('0000'), 'PinWrong');
  await fails(g.check(''), 'PinRequired');
  await fails(g.check(undefined), 'PinRequired');
  await fails(g.check(2580), 'PinRequired', 'a number is not a PIN typed in a dialog');
  assert.equal(await g.check('2580'), true);
  // No grace period: the next use asks again.
  await fails(g.check(''), 'PinRequired');
});

test('passkey PIN: wrong attempts add up like when unlocking and survive a restart', async () => {
  const { gate: g, guard, saved } = await gate();
  for (let i = 0; i < 5; i++) await fails(g.check('1111'), 'PinWrong');
  assert.ok(guard.waitSeconds() >= 29, 'blocked after the fifth mistake');
  await fails(g.check('2580'), 'PinBlocked'); // the right PIN does not help while blocked
  assert.deepEqual(Object.keys(saved.at(-1)), ['failures', 'blockedUntil'], 'the counter is persisted');
  const restarted = new PinGuard(saved.at(-1));
  assert.ok(restarted.waitSeconds() >= 29, 'a restart does not reset the counter');
});

test('passkey PIN: a verified PIN opens no unlock and no further passkey use', async () => {
  const { gate: g, guard } = await gate();
  await g.check('2580');
  assert.equal(guard.consume(), false, 'not the one unlock that a verified PIN allows');
  await fails(g.check(' '), 'PinWrong');
});

test('passkey PIN: switched off → no PIN is asked and nothing is counted', async () => {
  const { gate: g, guard } = await gate({ passkeyPin: false });
  assert.equal(await g.check(''), false);
  assert.equal(await g.check('9999'), false);
  assert.equal(guard.failures, 0);
  assert.deepEqual(g.state(), { required: false, pinSet: true });
});

test('passkey PIN: switched off but the policy requires a PIN → still asked', async () => {
  const { gate: g } = await gate({ passkeyPin: false, requirePin: true });
  await fails(g.check(''), 'PinRequired');
  assert.equal(await g.check('2580'), true);
});
