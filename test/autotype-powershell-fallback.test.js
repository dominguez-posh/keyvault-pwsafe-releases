import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SOURCE } from '../desktop/autotype.js';

// The PowerShell fallback of auto-type (only without Keevault-Update.exe) must do what the helper does (#352):
// real keys with scan codes in remote desktop/VM windows (#332), nothing typed into Windows' credential dialog (#336).
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('fallback source: same remote programs, classes and secure dialog class as the helper', () => {
  const cs = read('../windows/Setup/Typing.cs');
  const list = (src, name) => new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`).exec(src)[1].replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
  assert.equal(list(SOURCE, 'RemotePrograms'), list(cs, 'RemotePrograms'));
  assert.equal(list(SOURCE, 'RemoteClasses'), list(cs, 'RemoteClasses'));
  assert.match(SOURCE, /SecureDialogClass = "Credential Dialog Xaml Host"/);
  // The secure-dialog check comes before any key is sent.
  const type = SOURCE.slice(SOURCE.indexOf('public static string Type('));
  assert.ok(type.indexOf('SecureDialogClass') > 0 && type.indexOf('SecureDialogClass') < type.indexOf('foreach (char c in text)'));
});

test('fallback protocol: "secure" reaches the caller as SECURE_DIALOG, the app then uses the protected clipboard', () => {
  const js = read('../desktop/autotype.js');
  assert.match(js, /line === 'secure'\) state\.waiting\.shift\(\)\?\.reject\(Object\.assign\(new Error\('secure dialog'\), \{ code: 'SECURE_DIALOG' \}\)\)/);
  const typing = read('../desktop/main/typing.js');
  const fn = typing.slice(typing.indexOf('export async function autoTypeText'), typing.indexOf('export const autoTypeCalls'));
  // The PowerShell fallback sits inside the same try as the helper, so its secure answer is handled too.
  assert.ok(fn.indexOf('await typeText(text)') > 0 && fn.indexOf('await typeText(text)') < fn.indexOf('catch (e)'));
  assert.match(fn, /if \(e\.code !== SECURE_DIALOG\) throw e;\s*await copyToClipboard\(text\);\s*showHint\(\{ kind: 'secure', what \}\);/);
});

test('fallback source compiles and its key plan is right (types nothing)', { skip: process.platform !== 'win32' }, (t) => {
  const script = `Add-Type -TypeDefinition @'\n${SOURCE}\n'@\n[Console]::Out.WriteLine('selftest ' + [KvAutoType]::SelfTest())`;
  let out = '';
  try {
    out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  } catch (e) {
    // App Control puts PowerShell into Constrained Language Mode: no Add-Type, nothing to test here.
    if (/language mode|Cannot add type/i.test(String(e.stdout) + String(e.stderr))) return t.skip('Constrained Language Mode');
    throw e;
  }
  assert.match(out, /selftest ok/, out);
});
