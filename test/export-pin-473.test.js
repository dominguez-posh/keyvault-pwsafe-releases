import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hashPin, PinGuard } from '../desktop/pin.js';
import { ExportPinGate, EXPORT_PIN_TTL_MS } from '../desktop/export-pin.js';

async function gate(settings = {}) {
  const s = { appPin: await hashPin('2580'), ...settings };
  const saved = [];
  const guard = new PinGuard();
  let clock = 1_000_000;
  const g = new ExportPinGate({ settings: () => s, guard, save: (x) => saved.push(x), now: () => clock });
  return { gate: g, guard, saved, s, tick: (ms) => { clock += ms; } };
}

const refused = (fn, name = 'ExportPinRequired') => assert.throws(fn, (e) => e.name === name);
const fails = (promise, name) => assert.rejects(promise, (e) => e.name === name);

test('export PIN: with a PIN set, no confirmation means no export', async () => {
  const { gate: g } = await gate();
  refused(() => g.consume('c1', undefined));
  refused(() => g.consume('c1', null));
  refused(() => g.consume('c1', ''));
  refused(() => g.consume('c1', 'made-up-token'));
});

test('export PIN: a wrong PIN gives no confirmation and counts like the other PIN prompts', async () => {
  const { gate: g, guard, saved } = await gate();
  await fails(g.confirm('c1', '0000'), 'PinWrong');
  assert.equal(guard.failures, 1);
  assert.deepEqual(saved.at(-1), guard.toJSON(), 'the counter is persisted');
  await fails(g.confirm('c1', ''), 'PinRequired');
  await fails(g.confirm('c1', 2580), 'PinRequired');
  refused(() => g.consume('c1', undefined));
  for (let i = 0; i < 4; i++) await g.confirm('c1', '1111').catch(() => {});
  assert.ok(guard.waitSeconds() > 0, 'locked after five wrong attempts');
  await fails(g.confirm('c1', '2580'), 'PinBlocked');
});

test('export PIN: the right PIN gives one confirmation for one export of that vault', async () => {
  const { gate: g, guard } = await gate();
  guard.failure();
  const token = await g.confirm('c1', '2580');
  assert.equal(typeof token, 'string');
  assert.equal(guard.failures, 0, 'success resets the counter');
  assert.equal(guard.consume(), false, 'confirming an export does not allow an unlock');
  g.consume('c1', token);
  refused(() => g.consume('c1', token), 'ExportPinRequired');
  // Another vault, or a refused try, uses the confirmation up.
  const other = await g.confirm('c1', '2580');
  refused(() => g.consume('c2', other));
  refused(() => g.consume('c1', other));
  // A new confirmation replaces the older one.
  const first = await g.confirm('c1', '2580');
  const second = await g.confirm('c1', '2580');
  refused(() => g.consume('c1', first));
  const third = await g.confirm('c1', '2580');
  assert.notEqual(second, third);
  g.consume('c1', third);
});

test('export PIN: an expired confirmation is refused', async () => {
  const { gate: g, tick } = await gate();
  const token = await g.confirm('c1', '2580');
  tick(EXPORT_PIN_TTL_MS);
  refused(() => g.consume('c1', token));
  const fresh = await g.confirm('c1', '2580');
  tick(EXPORT_PIN_TTL_MS - 1);
  g.consume('c1', fresh);
});

test('export PIN: no PIN set – only the warning, nothing to confirm', async () => {
  const { gate: g } = await gate({ appPin: null });
  assert.equal(await g.confirm('c1', ''), null);
  g.consume('c1', undefined);
  g.consume('c1', null);
});

test('export PIN: exportItems checks the confirmation in the main process before anything else', () => {
  const src = readFileSync(new URL('../desktop/main/api/items.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async exportItems('), src.indexOf('async changelog('));
  assert.match(body, /^async exportItems\(containerId, pinToken\) \{\s*requireOpen\(\);\s*exportPin\.consume\(containerId, pinToken\);/);
  assert.ok(body.indexOf('exportPin.consume') < body.indexOf('showSaveDialog'), 'checked before the save dialog');
  assert.match(src, /confirmExportPin: \(containerId, pin\) => \{\s*requireOpen\(\);[^\n]*\n\s*return exportPin\.confirm\(containerId, pin\);/, '#477: only in the unlocked app');
  const guards = readFileSync(new URL('../desktop/main/guards.js', import.meta.url), 'utf8');
  assert.match(guards, /new ExportPinGate\(\{ settings: \(\) => config\.get\(\), guard: pinGuard,/, 'the same counter as unlocking');
  const backup = readFileSync(new URL('../desktop/main/api/backup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(backup, /exportPin/, 'the encrypted backup is not affected');
});
