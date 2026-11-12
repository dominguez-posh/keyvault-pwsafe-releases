import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fallbackVerdict } from '../desktop/smoke-autotype-fallback.js';

// #526: Windows PowerShell started with -EncodedCommand writes progress records ("Module werden für erstmalige
// Verwendung vorbereitet") and errors to stderr as CLIXML. The smoke check of the auto-type fallback reported only
// "#< CLIXML" and hid why the marker was missing. It now reads the marker line and names a timeout or the error.

const CLIXML_PROGRESS = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><PR N="Record"><AV>Module werden für erstmalige Verwendung vorbereitet.</AV></PR></MS></Obj></Objs>';

test('the marker on stdout passes, whatever CLIXML stands on stderr', () => {
  assert.equal(fallbackVerdict({ stdout: 'selftest ok\r\n', stderr: CLIXML_PROGRESS }), null);
});

test('a timeout is named as such, not as "#< CLIXML"', () => {
  const v = fallbackVerdict({ stdout: '', stderr: CLIXML_PROGRESS, error: { killed: true }, ms: 60_000 });
  assert.match(v, /no answer from PowerShell within 60 s/);
  assert.doesNotMatch(v, /CLIXML|<Obj/);
});

test('an error inside CLIXML is shown as text', () => {
  const stderr = `${CLIXML_PROGRESS.replace('</Objs>', '')}<S S="Error">Der Typ konnte nicht kompiliert werden_x000D__x000A_</S></Objs>`;
  const v = fallbackVerdict({ stdout: '', stderr, error: { code: 1 }, ms: 4000 });
  assert.match(v, /Der Typ konnte nicht kompiliert werden/);
  assert.doesNotMatch(v, /CLIXML|<S |vorbereitet/);
});

test('a compile error reported by the script itself and a key plan error are passed on', () => {
  assert.equal(fallbackVerdict({ stdout: 'selftest error csc.exe failed\r\n' }), 'error csc.exe failed');
  assert.equal(fallbackVerdict({ stdout: 'selftest rdp: wrong scan code\r\n' }), 'rdp: wrong scan code');
  assert.equal(fallbackVerdict({ stdout: 'selftest error Cannot add type. Definition of new types is not supported in this language mode.' }), null);
});

test('every -EncodedCommand script switches progress records off', () => {
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  for (const file of ['../desktop/autotype.js', '../desktop/smoke-autotype-fallback.js', '../desktop/smoke-clipboard-held.js']) {
    assert.match(src(file), /\$ProgressPreference = 'SilentlyContinue'/, file);
  }
});
