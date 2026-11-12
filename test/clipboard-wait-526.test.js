import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { holdClipboard } from '../desktop/smoke-clipboard-held.js';

// #526: another program (clipboard monitor, Windows clipboard history, its sync) may hold the clipboard for a moment.
// Both helpers wait up to ~5 s with growing pauses before giving up; the callers wait long enough for that.
const read = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), 'utf8');

test('Keevault-Update.exe: up to 5 s, pauses doubling from 25 to 250 ms, closed in finally', () => {
  const clip = read('windows/Setup/Clip.cs');
  assert.match(clip, /internal const int OpenWaitMs = 5000;/);
  assert.match(clip, /for \(var pause = 25; ; pause = Math\.Min\(pause \* 2, 250\)\)/);
  assert.match(clip, /if \(watch\.ElapsedMilliseconds >= OpenWaitMs\) return false;/);
  assert.doesNotMatch(clip, /i < 40/, 'the old 1 s wait is gone');
  assert.equal((clip.match(/if \(!Open\(\)\) return 2;/g) || []).length, 2);
  assert.equal((clip.match(/if \(!Open\(\)\) return WrittenUnverified;/g) || []).length, 1, 'the read-back has its own code');
  assert.equal((clip.match(/finally\s*\{\s*CloseClipboard\(\);/g) || []).length, 3, 'every open is closed in finally');
});

test('PowerShell helper: the same wait, and the error names another program', () => {
  const at = read('desktop/autotype.js');
  assert.match(at, /pause = 25; !\(open = OpenClipboard\(IntPtr\.Zero\)\) && watch\.ElapsedMilliseconds < 5000; pause = Math\.Min\(pause \* 2, 250\)/);
  assert.match(at, /throw new Exception\("clipboard held by another program"\)/);
});

test('callers: the helper may run two waits, the PowerShell copy one; busy says so', async () => {
  const typing = read('desktop/main/typing.js');
  const timeout = Number(typing.match(/HELPER_EXE_TIMEOUT_MS = ([\d_]+);/)[1].replace(/_/g, ''));
  assert.ok(timeout >= 2 * 5000 + 1000, `runHelperExe waits ${timeout} ms`);
  assert.match(typing, /setTimeout\(\(\) => \{ child\.kill\(\); resolve\(null\); \}, HELPER_EXE_TIMEOUT_MS\)/);
  const clip = read('desktop/main/clipboard.js');
  assert.match(clip, /copyInTime\(\(\) => copySecret\(text\), 6000,/);
  assert.match(clip, /if \(code === CLIPBOARD_BUSY\) \{[\s\S]*?von einem anderen Programm belegt/);
  const en = read('extension/core/i18n-en.js');
  assert.match(en, /'Kopieren nicht möglich: Die geschützte Zwischenablage ist gerade von einem anderen Programm belegt\. Bitte noch einmal versuchen\.': 'Copying not possible: another program/);
});

test('smoke: the clipboard area copies while another process holds the clipboard', async () => {
  assert.match(read('desktop/smoke-features.js'), /heldClipboardCheck\(\{ copyViaHelperExe: ctx\.copyViaHelperExe, clipboardHas, fail \}\); \/\/ #526/);
  if (process.platform !== 'win32') assert.deepEqual((await holdClipboard(10)).held, false);
});

// Review of 7c6fe95: when only the read-back met a held clipboard, the helper said 2 ("busy") although the secret was
// written; the app reported "not copied" and never started the clear timer – the secret stayed on the clipboard.
test('written but read-back held: own exit code 4, copied, the clear timer runs; busy still clears what may have landed', () => {
  const clip = read('windows/Setup/Clip.cs');
  assert.match(clip, /private const int WrittenUnverified = 4;/);
  // Write first, then the read-back: the open before writing alone may answer 2.
  assert.ok(clip.indexOf('SetClipboardData(CF_UNICODETEXT') < clip.indexOf('return WrittenUnverified'));
  assert.match(read('desktop/main/typing.js'), /export const CLIPBOARD_UNVERIFIED = 4;/);
  const js = read('desktop/main/clipboard.js');
  const fn = js.slice(js.indexOf('export async function copyToClipboard'), js.indexOf('async function clearCopied'));
  assert.match(fn, /verified = code === 0 \|\| code === CLIPBOARD_UNVERIFIED;/);
  // Code 4 never reaches a throw before the timer.
  assert.ok(fn.indexOf('if (code === CLIPBOARD_BUSY)') < fn.indexOf('clipboardTimer = setTimeout'));
  const busy = fn.slice(fn.indexOf('if (code === CLIPBOARD_BUSY)'), fn.indexOf('throw new Error', fn.indexOf('if (code === CLIPBOARD_BUSY)')));
  assert.match(busy, /clearCopied\(text\)\.catch\(\(\) => \{\}\);/, 'busy: the precautionary clear starts before the error');
});

test('smoke holder: no command line of a foreign program in the log', () => {
  const src = read('desktop/smoke-clipboard-held.js');
  assert.doesNotMatch(src, /CommandLine|commandline=/);
  assert.match(src, /process=\$\(\$p\.ProcessName\) class=\$class/);
});
