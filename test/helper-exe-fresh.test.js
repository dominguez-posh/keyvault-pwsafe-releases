import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { helperExeProblem } from '../scripts/helper-exe-fresh.mjs';

// #526: a smoke run on Windows starts only with a Keevault-Update.exe at least as new as windows/Setup.

/** A small file tree: { path: mtimeMs } for files, directories implied by the paths. */
function fakeFs(files) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  const stat = (p) => {
    const key = norm(p);
    if (key in files) return { isDirectory: () => false, mtimeMs: files[key] };
    if (Object.keys(files).some((f) => f.startsWith(`${key}/`))) return { isDirectory: () => true, mtimeMs: 0 };
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const list = (dir) => [...new Set(Object.keys(files).filter((f) => f.startsWith(`${norm(dir)}/`)).map((f) => f.slice(norm(dir).length + 1).split('/')[0]))];
  return { stat, list };
}

test('a helper newer than its sources passes', () => {
  const fs = fakeFs({ 'r/windows/out/Keevault-Update.exe': 200, 'r/windows/Setup/Clip.cs': 100, 'r/windows/Setup/Keevault.Setup.csproj': 150 });
  assert.equal(helperExeProblem('r', { platform: 'win32', ...fs }), null);
});

test('a helper older than one source is refused with the build command', () => {
  const fs = fakeFs({ 'r/windows/out/Keevault-Update.exe': 200, 'r/windows/Setup/Clip.cs': 100, 'r/windows/Setup/Hello.cs': 300 });
  const why = helperExeProblem('r', { platform: 'win32', ...fs });
  assert.match(why, /älter als die Quellen/);
  assert.match(why, /dotnet build windows\/Setup/);
});

test('a missing helper is refused; build output (bin, obj) and other files do not count', () => {
  assert.match(helperExeProblem('r', { platform: 'win32', ...fakeFs({ 'r/windows/Setup/Clip.cs': 100 }) }), /fehlt/);
  const fs = fakeFs({ 'r/windows/out/Keevault-Update.exe': 200, 'r/windows/Setup/Clip.cs': 100, 'r/windows/Setup/obj/Gen.cs': 900, 'r/windows/Setup/notes.txt': 900 });
  assert.equal(helperExeProblem('r', { platform: 'win32', ...fs }), null);
});

test('other platforms do not use the helper', () => {
  assert.equal(helperExeProblem('r', { platform: 'linux', ...fakeFs({}) }), null);
});

test('start.mjs checks the helper before a smoke run', () => {
  const src = readFileSync(new URL('../scripts/start.mjs', import.meta.url), 'utf8');
  assert.match(src, /helperExeProblem\(root\)/);
});
