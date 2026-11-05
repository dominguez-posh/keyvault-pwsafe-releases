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
