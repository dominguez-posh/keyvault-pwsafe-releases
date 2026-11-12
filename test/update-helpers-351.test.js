import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// #351: the update waited 20 s for Keevault processes from the installation folder that never end by themselves –
// the browser's native messaging host and AI agents' MCP hosts. They are recognised by their command line, ended at
// once and logged with it.

const source = fileURLToPath(new URL('../windows/Setup/HelperProcesses.cs', import.meta.url));
const errors = readFileSync(fileURLToPath(new URL('../windows/Setup/Errors.cs', import.meta.url)), 'utf8');
const pwsh = (() => { try { execFileSync('pwsh', ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const skip = process.platform !== 'win32' || !pwsh;

/** Compiles HelperProcesses.cs on its own (made public for the test) and runs one call in PowerShell 7. */
function call(method, arg) {
  const dir = mkdtempSync(join(tmpdir(), 'kv351-'));
  const file = join(dir, 'HelperProcesses.cs');
  writeFileSync(file, readFileSync(source, 'utf8').replace('internal static class', 'public static class'));
  const script = `Add-Type -Path $env:KV_SRC; $r = [Keevault.Setup.HelperProcesses]::${method}($env:KV_ARG); if ($null -eq $r) { '<null>' } else { [string]$r }`;
  return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, KV_SRC: file, KV_ARG: String(arg) }, windowsHide: true }).trim();
}

test('#351: the connections for the browser and for agents are recognised, the app itself is not', { skip }, () => {
  assert.equal(call('IsHelper', '"C:\\Program Files\\Keevault\\Keevault.exe" "C:\\Users\\a\\AppData\\Roaming\\KeyVault PwSafe\\native-host\\host.cjs" chrome-extension://abc/'), 'True');
  assert.equal(call('IsHelper', '"C:\\Program Files\\Keevault\\Keevault.exe" C:/Users/a/AppData/Roaming/KeyVault PwSafe/mcp/keevault-mcp.cjs'), 'True');
  // #505: the relay from resources (Keevault-Update.exe --native-host) is the browser's connection as well.
  assert.equal(call('IsHelper', '"C:\\Program Files\\Keevault\\resources\\Keevault-Update.exe" --native-host "C:\\Users\\a\\AppData\\Roaming\\KeyVault PwSafe\\native-host\\host.json" chrome-extension://abc/'), 'True');
  assert.equal(call('IsHelper', '"C:\\Program Files\\Keevault\\resources\\Keevault-Update.exe" chrome-extension://abc/ --parent-window=0'), 'True', 'as Chrome/Edge start it');
  assert.equal(call('IsHelper', '"C:\\Program Files\\Keevault\\resources\\Keevault-Update.exe" --update C:\\t\\setup.exe'), 'False');
  assert.equal(call('IsHelper', '"C:\\Program Files\\Keevault\\Keevault.exe" --type=renderer'), 'False');
  assert.equal(call('IsHelper', '"C:\\Program Files\\Keevault\\Keevault.exe"'), 'False');
  assert.equal(call('IsHelper', ''), 'False');
});

test('#351: the command line of a running process is read (for the check and the update log)', { skip }, async () => {
  const marker = 'C:\\kv351\\native-host\\host.cjs';
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', marker], { stdio: 'ignore', windowsHide: true });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const line = call('CommandLine', child.pid);
    assert.ok(line.includes(marker), line);
    assert.equal(call('IsHelper', line), 'True');
    assert.equal(call('CommandLine', 999999999), '<null>', 'no such process: null');
  } finally {
    child.kill();
  }
});

test('#351: Release ends the connections at once instead of waiting for them, and logs every command line', () => {
  const release = errors.slice(errors.indexOf('public static async Task<List<string>> Release'), errors.indexOf('private static void End('));
  const loop = release.slice(release.indexOf('while (DateTime.Now < until)'), release.indexOf('await Task.Delay(500);'));
  // #513: after the grace that lets them quit on the update's signal, each once.
  assert.match(loop, /HelperProcesses\.IsHelper\(commandLine\) && DateTime\.Now - start >= helperGrace && ended\.Add\(p\.Id\)\) End\(p, commandLine/, 'helpers are ended inside the waiting loop');
  assert.match(loop, /if \(running\.Count == 0\) return running;/, 'done when nothing runs any more');
  assert.match(errors, /UpdateLog\.Write\(\$"ending \{NameOf\(p\)\} \(\{p\.Id\}\), \{why\}: \{commandLine/);
});
