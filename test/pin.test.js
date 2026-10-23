import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, verifyPin, PinGuard } from '../desktop/pin.js';

test('app PIN: stored only as hash, verified, wrong attempts slow down', async () => {
  const record = await hashPin('2580');
  assert.equal(JSON.stringify(record).includes('2580'), false);
  assert.equal(await verifyPin('2580', record), true);
  assert.equal(await verifyPin('2581', record), false);
  assert.equal(await verifyPin('2580', null), false);

  const guard = new PinGuard();
  for (let i = 0; i < 4; i++) guard.failure();
  assert.equal(guard.waitSeconds(), 0, 'four mistakes are free');
  guard.failure();
  assert.ok(guard.waitSeconds() >= 29, 'the fifth one blocks for 30 s');
  guard.success();
  assert.equal(guard.waitSeconds(), 0);
  assert.equal(guard.consume(), true, 'a verified PIN allows one unlock');
  assert.equal(guard.consume(), false, '… and only one');
});
