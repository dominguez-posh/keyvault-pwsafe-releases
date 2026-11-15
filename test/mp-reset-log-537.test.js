import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_RESETS, resetsOf, unseenResets, withReset } from '../desktop/mp-reset-log.js';

// #537 stage 6: the reset log in the personal vault, shown once per device.

test('the log keeps the other app settings, at most MAX_RESETS entries, only valid ones', () => {
  let v = { theme: 'dark', containers: [] };
  for (let i = 0; i < MAX_RESETS + 3; i++) v = withReset(v, { at: new Date(2026, 10, 1, 0, i).toISOString(), device: 'PC', kv: i + 2 });
  assert.equal(v.theme, 'dark');
  assert.equal(resetsOf(v).length, MAX_RESETS);
  const bad = { mpResets: [{ at: 'nonsense' }, { at: '2026-11-13T10:00:00.000Z', device: 'x\u0000y' }, null, { at: '2026-11-13T11:00:00.000Z', device: 'OK' }] };
  assert.deepEqual(resetsOf(bad).map((r) => r.device), ['OK']);
  assert.deepEqual(resetsOf({ mpResets: 'x' }), []);
  assert.equal(withReset(null, { at: '2026-11-13T10:00:00.000Z', device: 'a\nb' }).mpResets[0].device, '');
});

test('each device shows each entry once', () => {
  const v = withReset(withReset({}, { at: '2026-11-13T10:00:00.000Z', device: 'A' }), { at: '2026-11-13T12:00:00.000Z', device: 'B' });
  assert.equal(unseenResets(v, []).length, 2);
  assert.deepEqual(unseenResets(v, ['2026-11-13T10:00:00.000Z']).map((r) => r.device), ['B']);
  assert.equal(unseenResets(v, ['2026-11-13T10:00:00.000Z', '2026-11-13T12:00:00.000Z']).length, 0);
});

test('wiring: the log goes into the vault right after the key change; the resetting device has seen it; device only', () => {
  const src = readFileSync(new URL('../desktop/main/mp-reset.js', import.meta.url), 'utf8');
  assert.match(src, /markRecoveryRenewed\(entry\.id\);[^\n]*\n\s+await logReset\(entry\)/);
  assert.match(src, /config\.update\(\{ mpResetsSeen: \[\.\.\.seen\(\), at\]/);
  const cfg = readFileSync(new URL('../desktop/config.js', import.meta.url), 'utf8');
  const sync = cfg.slice(cfg.indexOf('export const SYNC_KEYS'), cfg.indexOf('const ORG_KEYS'));
  assert.doesNotMatch(sync, /mpReset/, 'the seen list stays on the device');
});
