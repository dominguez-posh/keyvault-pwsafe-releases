// #349: remote desktop under Credential Guard copies the password before mstsc starts; a short clearing time could be
// over before Windows' dialog is ready. That case keeps the value at least RDP_CLIPBOARD_SECONDS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearAfterSeconds } from '../desktop/copy-in-time.js';

test('#349: clearing time – a short setting is lengthened, a longer one and "never" stay', () => {
  assert.equal(clearAfterSeconds(30, 120), 120);
  assert.equal(clearAfterSeconds(300, 120), 300);
  assert.equal(clearAfterSeconds(0, 120), 0, 'never cleared stays never cleared');
  assert.equal(clearAfterSeconds(30), 30, 'every other copy keeps the setting');
  assert.equal(clearAfterSeconds('15', 0), 15);
});

test('#349: the Credential Guard way copies with the longer time and the hint names it', () => {
  const devices = readFileSync(new URL('../desktop/main/devices.js', import.meta.url), 'utf8');
  const rdp = devices.slice(devices.indexOf('export async function launchRdp'), devices.indexOf('const exe = helperExe()'));
  assert.equal((rdp.match(/copyToClipboard\(password, \{ atLeastSeconds: RDP_CLIPBOARD_SECONDS \}\)/g) || []).length, 2, 'both copies (real and smoke) lengthen the time');
  assert.equal((rdp.match(/showHint\(\{ kind: 'rdp', user: username, atLeastSeconds: RDP_CLIPBOARD_SECONDS \}\)/g) || []).length, 2, 'both hints name it');
  assert.match(devices, /RDP_CLIPBOARD_SECONDS = 120;/);
  const clip = readFileSync(new URL('../desktop/main/clipboard.js', import.meta.url), 'utf8');
  assert.match(clip, /clearAfterSeconds\(config\.get\(\)\.clipboardSeconds, atLeastSeconds\)/);
  const hint = readFileSync(new URL('../desktop/main/hint-window.js', import.meta.url), 'utf8');
  assert.match(hint, /clearAfterSeconds\(config\.get\(\)\.clipboardSeconds, atLeastSeconds\)/);
});
