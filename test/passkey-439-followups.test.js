import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, PinGuard, inPinQueue } from '../desktop/pin.js';
import { PasskeyPinGate } from '../desktop/passkey-pin.js';
import { restoreStoredKeys, withoutPasskeyKeys, withStoredKeys } from '../desktop/passkey-keys.js';
import { showPinProblem } from '../extension/core/dom.js';

test('#439: parallel PIN guesses cannot get past the attempt lock', async () => {
  const s = { appPin: await hashPin('2580') };
  const guard = new PinGuard();
  const gate = new PasskeyPinGate({ settings: () => s, guard, save: () => {} });
  const results = await Promise.all(Array.from({ length: 20 }, () => gate.check('0000').then(() => 'ok', (e) => e.name)));
  assert.equal(results.filter((x) => x === 'PinWrong').length, 5, 'exactly the five guesses the lock allows');
  assert.equal(results.filter((x) => x === 'PinBlocked').length, 15, 'all others are refused while blocked');
  assert.ok(guard.waitSeconds() > 0);
});

test('#439: the PIN queue runs one task at a time, in order, and survives a failing task', async () => {
  const log = [];
  const slow = inPinQueue(async () => { log.push('a start'); await new Promise((r) => setTimeout(r, 20)); log.push('a end'); throw new Error('x'); });
  const next = inPinQueue(async () => { log.push('b'); return 7; });
  await assert.rejects(slow, /x/);
  assert.equal(await next, 7);
  assert.deepEqual(log, ['a start', 'a end', 'b']);
});

test('#439: items for the browser carry no private key; saving puts the stored ones back by credentialId', () => {
  const stored = { id: 'i', title: 'T', passkeys: [{ credentialId: 'A', privateKey: 'KEY-A' }, { credentialId: 'B', privateKey: 'KEY-B' }] };
  const seen = withoutPasskeyKeys(stored);
  assert.deepEqual(seen.passkeys.map((k) => k.privateKey), ['', '']);
  assert.equal(stored.passkeys[0].privateKey, 'KEY-A', 'the stored item is not changed');
  // Edited in the browser, passkeys reordered, one removed, one new, one with a forged key.
  const edited = { ...seen, title: 'T2', passkeys: [{ credentialId: 'C', privateKey: 'NEW' }, { credentialId: 'A', privateKey: 'FORGED' }] };
  const saved = withStoredKeys(edited, stored);
  assert.equal(saved.title, 'T2');
  assert.deepEqual(saved.passkeys, [{ credentialId: 'C', privateKey: 'NEW' }, { credentialId: 'A', privateKey: 'KEY-A' }]);
  assert.deepEqual(withStoredKeys({ passkeys: [{ credentialId: 'A', privateKey: '' }] }, null).passkeys, [{ credentialId: 'A', privateKey: '' }]);
  assert.equal(withoutPasskeyKeys({ id: 'x' }).id, 'x');
});

test('#439: a PIN message with a waiting time counts down and then disappears', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const box = { hidden: true, textContent: '', isConnected: true };
    showPinProblem(box, 'Falsche PIN – bitte 3 Sekunden warten');
    assert.equal(box.hidden, false);
    assert.equal(box.textContent, 'Falsche PIN – bitte 3 Sekunden warten');
    mock.timers.tick(1000);
    assert.equal(box.textContent, 'Falsche PIN – bitte 2 Sekunden warten');
    mock.timers.tick(2000);
    assert.equal(box.hidden, true);
    showPinProblem(box, 'Falsche PIN');
    assert.equal(box.hidden, false);
    assert.equal(box.textContent, 'Falsche PIN');
  } finally {
    mock.timers.reset();
  }
});

test('#439: a read error stops the browser save; only a missing entry counts as new', async () => {
  const item = { id: 'i', passkeys: [{ credentialId: 'A', privateKey: 'NEW' }] };
  const stored = { passkeys: [{ credentialId: 'A', privateKey: 'KEY-A' }] };
  assert.equal((await restoreStoredKeys(item, async () => stored)).passkeys[0].privateKey, 'KEY-A');
  for (const err of [Object.assign(new Error('x'), { status: 500 }), new Error('Netzwerkfehler'), Object.assign(new Error('Keine Berechtigung'), { status: 403 })]) {
    await assert.rejects(restoreStoredKeys(item, async () => { throw err; }), /konnte nicht gelesen|could not be read/);
  }
  const fresh = await restoreStoredKeys(item, async () => { throw Object.assign(new Error('Nicht gefunden'), { status: 404 }); });
  assert.equal(fresh.passkeys[0].privateKey, 'NEW', 'a new entry keeps the key it was created with');
  assert.equal((await restoreStoredKeys(item, async () => { throw new Error('Nicht gefunden'); })).passkeys[0].privateKey, 'NEW');
});
