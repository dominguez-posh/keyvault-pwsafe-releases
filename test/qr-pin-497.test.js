// #497: the screen QR scan only in the unlocked app and at most once every 2 s; the delayed PIN field takes the keyboard
// only if the user typed nothing on the page since the click on "Use passkey".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanThrottle, SCAN_INTERVAL_MS } from '../desktop/qr-decode.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('screen QR scan: one screenshot per interval, a loop gets nothing', () => {
  let clock = 1_000_000;
  const th = scanThrottle(SCAN_INTERVAL_MS, () => clock);
  assert.equal(th.take(), true);
  for (let i = 0; i < 50; i++) assert.equal(th.take(), false);
  clock += SCAN_INTERVAL_MS - 1;
  assert.equal(th.take(), false);
  clock += 1;
  assert.equal(th.take(), true);
});

test('screen QR scan: the main process checks the app is open and throttles before any screenshot', () => {
  const src = read('desktop/main/qr-scan.js');
  const body = src.slice(src.indexOf('export async function scanScreenQr'));
  const open = body.indexOf('requireOpen()');
  const take = body.indexOf('throttle.take()');
  const capture = body.indexOf('capture()');
  assert.ok(open > 0 && take > open && capture > take, 'requireOpen and the throttle come before the capture');
});

test('screen QR scan: the "no one-time code" message names the screen in the desktop app', () => {
  const src = read('extension/core/ui-totp.js');
  assert.match(src, /screen \? t\('Der QR-Code auf dem Bildschirm enthält keinen Einmalcode/);
});

test('PIN field in the tag: focus only when no key was pressed on the page since the click', () => {
  const src = read('extension/content/content.js');
  assert.match(src, /addEventListener\('keydown', \(e\) => \{ if \(e\.isTrusted\) pageKeys\+\+; \}, true\)/);
  assert.ok(!/^\s*frame\.focus\(\);/m.test(src), 'no unconditional focus of the PIN frame');
  assert.match(src, /if \(pageKeys === keysAtClick\) frame\.focus\(\)/);
  const seen = src.slice(src.indexOf('function openPinWhenSeen'), src.indexOf('function pinFallback'));
  assert.match(seen, /const keysAtClick = pageKeys;/, 'counted at the click, not when the field appears');
  assert.equal((seen.match(/openPinFrame\(use, sw, list, keysAtClick\)/g) || []).length, 2, 'both paths pass the count from the click');
});
