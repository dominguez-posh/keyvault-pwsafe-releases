import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Auto-type into remote desktop/VM windows (#332): there every character is pressed as a real key of the keyboard
// layout instead of a Unicode packet. The helper checks its key plan for a fixed sample (types nothing).
const exe = fileURLToPath(new URL('../windows/out/Keevault-Update.exe', import.meta.url));

test('auto-type key plan for remote windows', { skip: process.platform !== 'win32' || !existsSync(exe) }, () => {
  let out = '';
  try { out = execFileSync(exe, ['--type-selftest'], { encoding: 'utf8', timeout: 30_000 }); } catch (e) { out = String(e.stdout || e.message); }
  assert.match(out, /type-selftest ok/, out);
});

test('auto-type detects remote desktop and VM windows, and logs the window but never the value', () => {
  const cs = readFileSync(fileURLToPath(new URL('../windows/Setup/Typing.cs', import.meta.url)), 'utf8');
  for (const name of ['"mstsc"', '"msrdc"', '"vmconnect"', '"TscShellContainerClass"']) assert.ok(cs.includes(name), name);
  const js = readFileSync(fileURLToPath(new URL('../desktop/main/typing.js', import.meta.url)), 'utf8');
  assert.match(js, /diag\(`AUTOTYPE \$\{window/);
  assert.doesNotMatch(js, /diag\([^)]*\btext\b/);
});

test("Windows' credential dialog: nothing typed, the value goes to the protected clipboard (#336)", () => {
  const cs = readFileSync(fileURLToPath(new URL('../windows/Setup/Typing.cs', import.meta.url)), 'utf8');
  // Checked before anything is sent: exit code 5, no SendInput for this window.
  const run = cs.slice(cs.indexOf('public static int Run('));
  assert.ok(run.indexOf('SecureDialogClass') > 0 && run.indexOf('SecureDialogClass') < run.indexOf('foreach (var c in text)'));
  assert.match(cs, /SecureDialogClass = "Credential Dialog Xaml Host"/);
  const js = readFileSync(fileURLToPath(new URL('../desktop/main/typing.js', import.meta.url)), 'utf8');
  assert.match(js, /code === 5\) reject\(Object\.assign\(new Error\('secure dialog'\), \{ code: SECURE_DIALOG \}\)\)/);
  assert.match(js, /if \(e\.code !== SECURE_DIALOG\) throw e;\s*await copyToClipboard\(text\);\s*showHint\(\{ kind: 'secure', what \}\);/);
  // RDP under Credential Guard: no typing attempt any more, the password is on the clipboard before mstsc starts.
  const dev = readFileSync(fileURLToPath(new URL('../desktop/main/devices.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(dev, /typeIntoCredentialDialog/);
  assert.match(dev, /credentialGuardRunning\(\)\)\) \{\s*(\/\/[^\n]*\s*)*await copyToClipboard\(password, \{ atLeastSeconds: RDP_CLIPBOARD_SECONDS \}\);/);
});
