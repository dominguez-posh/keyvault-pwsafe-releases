import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quitSignalFile, quitWatch } from '../desktop/helper-quit.js';
import { hostScript } from '../desktop/bridge.js';
import { mcpHostScript } from '../desktop/mcp.js';

// #513: the update waited long because the updater could not end Keevault processes ("Zugriff verweigert"). Windows
// refuses TerminateProcess for a process that is exiting already; the helpers now quit by themselves on a signal, ended
// processes are not waited for, and the setup starts only when no file of the folder is open. Tested with stand-ins: a
// copy of node.exe named Keevault.exe in a temporary "installation folder", running scripts with the helpers' paths.

const src = (f) => readFileSync(fileURLToPath(new URL(`../windows/Setup/${f}`, import.meta.url)), 'utf8');
const pwsh = (() => { try { execFileSync('pwsh', ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const skip = process.platform !== 'win32' || !pwsh;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exited = (child, ms) => new Promise((resolve) => {
  if (child.exitCode !== null) return resolve(child.exitCode);
  const timer = setTimeout(() => resolve(null), ms);
  child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
});

// Text stands in for Program.cs (SetupError's messages); everything made public for PowerShell.
const TEXT_STUB = 'namespace Keevault.Setup { public static class Text { public static bool German => true; public static string T(string s, params object[] a) => a.Length > 0 ? string.Format(s, a) : s; } }';

/** Compiles UpdateWait.cs (and with errors: Errors.cs, HelperProcesses.cs) and runs a PowerShell script against it. */
function ps(script, { withRelease = false, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kv513-cs-'));
  const files = ['UpdateWait.cs', ...(withRelease ? ['HelperProcesses.cs', 'Errors.cs'] : [])].map((f) => {
    const out = join(dir, f);
    writeFileSync(out, src(f).replace(/internal (sealed |static )?class/g, (m, k) => `public ${k || ''}class`));
    return out;
  });
  if (withRelease) writeFileSync(join(dir, 'Text.cs'), TEXT_STUB);
  const paths = [...files, ...(withRelease ? [join(dir, 'Text.cs')] : [])].map((f) => `'${f}'`).join(',');
  try {
    return execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Add-Type -Path ${paths}; ${script}`],
      { encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000 }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('#513: kinds of Keevault processes for the "Wartet noch auf" list', { skip }, () => {
  const kind = (line) => ps(`[Keevault.Setup.UpdateWait]::Kind($env:KV_ARG)`, { env: { KV_ARG: line } });
  assert.equal(kind('C:\\P\\Keevault\\Keevault.exe "C:\\U\\AppData\\Roaming\\KeyVault PwSafe\\mcp\\keevault-mcp.cjs"'), 'mcp');
  assert.equal(kind('"C:\\P\\Keevault\\Keevault.exe"  "C:\\U\\KeyVault PwSafe\\native-host\\host.cjs" chrome-extension://abc/'), 'browser');
  assert.equal(kind('"C:\\P\\Keevault\\resources\\Keevault-Update.exe" chrome-extension://abc/ --parent-window=0'), 'browser');
  assert.equal(kind('"C:\\P\\Keevault\\Keevault.exe" "kvpwsafe://open/"'), 'app');
  assert.equal(kind('"C:\\P\\Keevault\\Keevault.exe" --type=gpu-process'), 'app', "Electron's own processes belong to the app");
  assert.equal(kind('C:\\P\\Keevault\\Keevault.exe'), 'app');
  assert.equal(kind('C:\\Program Files\\Keevault\\Keevault.exe --type=renderer'), 'app', 'a path with spaces without quotes');
  assert.equal(kind('"C:\\P\\Keevault\\other.exe" x'), 'other');
  const summary = ps(`[Keevault.Setup.UpdateWait]::Summary([string[]]@('mcp','app','mcp','browser','app','mcp'), [Func[string,string]]{ param($k) $k })`);
  assert.equal(summary, 'app, mcp ×3, browser');
});

test('#513: the signal counts only when it is newer than the helper', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv513-sig-'));
  try {
    const file = join(dir, 'sub', 'quit-helpers');
    const out = ps(`$f = $env:KV_FILE; $before = [DateTime]::UtcNow.AddSeconds(-5); $none = [Keevault.Setup.UpdateWait]::Signalled($f, $before); `
      + `$w = [Keevault.Setup.UpdateWait]::Signal($f); $after = [DateTime]::UtcNow.AddSeconds(5); `
      + `"$none $w $([Keevault.Setup.UpdateWait]::Signalled($f, $before)) $([Keevault.Setup.UpdateWait]::Signalled($f, $after))"`, { env: { KV_FILE: file } });
    assert.equal(out, 'False True True False', 'none yet; written; newer than the start: quit; older: ignored');
    assert.equal(quitSignalFile({ LOCALAPPDATA: 'C:\\L' }), join('C:\\L', 'keyvault-pwsafe-updater', 'quit-helpers'), 'the app and the updater mean the same file');
    assert.match(src('UpdateWait.cs'), /"keyvault-pwsafe-updater", "quit-helpers"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#513: generated helper scripts quit by themselves on a new signal, an old one is ignored', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv513-helper-'));
  const pipe = `\\\\.\\pipe\\kv513-none-${process.pid}`;
  const kids = [];
  try {
    for (const [name, script] of [['mcp.cjs', mcpHostScript(pipe, '0.0.0') + quitWatch(join(dir, 'quit'))], ['host.cjs', hostScript(pipe, { cmd: 'none', args: [] })]]) {
      // hostScript carries the watch for the real signal file; the test points it at its own.
      const file = join(dir, name);
      writeFileSync(file, name === 'host.cjs' ? script.replace(JSON.stringify(quitSignalFile()), JSON.stringify(join(dir, 'quit'))) : script);
      assert.ok(readFileSync(file, 'utf8').includes(JSON.stringify(join(dir, 'quit'))), `${name} watches the signal file`);
    }
    writeFileSync(join(dir, 'quit'), 'old'); // from an earlier update
    await sleep(50);
    for (const name of ['mcp.cjs', 'host.cjs']) kids.push(spawn(process.execPath, [join(dir, name)], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true }));
    await sleep(2500);
    for (const k of kids) assert.equal(k.exitCode, null, 'an old signal does not end a helper started later');
    writeFileSync(join(dir, 'quit'), 'now');
    const codes = await Promise.all(kids.map((k) => exited(k, 5000)));
    assert.deepEqual(codes, [0, 0], 'both quit cleanly within a few seconds');
  } finally {
    for (const k of kids) if (k.exitCode === null) k.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#513: Release with stand-ins – the agent quits on the signal, the browser connection is ended, the app is waited for; then no file is open', { skip, timeout: 120_000 }, async () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'kv513-install-'))); // long names: the image path of a process keeps the form it was started with
  const kids = [];
  try {
    const exe = join(dir, 'Keevault.exe');
    copyFileSync(process.execPath, exe);
    mkdirSync(join(dir, 'mcp'));
    mkdirSync(join(dir, 'native-host'));
    const signal = join(dir, 'quit-helpers');
    const log = join(dir, 'update.log');
    writeFileSync(join(dir, 'mcp', 'keevault-mcp.cjs'), `${quitWatch(signal)}setInterval(() => {}, 1000);\n`);
    writeFileSync(join(dir, 'native-host', 'host.cjs'), 'setInterval(() => {}, 1000);\n'); // an old helper without the watch
    writeFileSync(join(dir, 'app.cjs'), 'setTimeout(() => process.exit(0), 3000);\n'); // the app, quitting a bit later
    for (const s of ['mcp\\keevault-mcp.cjs', 'native-host\\host.cjs', 'app.cjs']) kids.push(spawn(exe, [join(dir, s)], { stdio: 'ignore', windowsHide: true }));
    await sleep(800);
    const locked = ps(`[string]::Join(',', [Keevault.Setup.UpdateWait]::LockedFiles($env:KV_DIR, 5))`, { env: { KV_DIR: dir } });
    assert.equal(locked, 'Keevault.exe', 'a running exe is an open file');
    const out = ps(`[void][Keevault.Setup.UpdateWait]::Signal($env:KV_SIGNAL); `
      + `$t = [Keevault.Setup.InstallProcesses]::Release($env:KV_DIR, [TimeSpan]::FromSeconds(12), [TimeSpan]::FromSeconds(2), $null); `
      + `$left = $t.GetAwaiter().GetResult(); "left=" + [string]::Join(',', $left) + " open=" + [string]::Join(',', [Keevault.Setup.UpdateWait]::LockedFilesSettled($env:KV_DIR, [TimeSpan]::FromSeconds(10)))`,
    { withRelease: true, env: { KV_DIR: dir, KV_SIGNAL: signal, KV_UPDATE_LOG: log } });
    assert.equal(out, 'left= open=', `nothing runs and nothing is open: the setup may start; log: ${existsSync(log) ? readFileSync(log, 'utf8') : '(none)'}; alive: ${kids.map((k) => k.exitCode)}`);
    const text = readFileSync(log, 'utf8');
    assert.match(text, /ending Keevault \(\d+\), a connection for the browser or an AI agent: .*native-host\\host\.cjs/, 'the old helper is ended after its grace');
    assert.doesNotMatch(text, /keevault-mcp\.cjs/, 'the agent connection quit by itself, nobody ended it');
    assert.doesNotMatch(text, /app\.cjs/, 'the app was waited for, not ended');
    assert.doesNotMatch(text, /could not end|Zugriff verweigert|Access is denied/i);
    assert.deepEqual(await Promise.all(kids.map((k) => exited(k, 3000))).then((c) => c.map((x) => x !== null)), [true, true, true]);
  } finally {
    for (const k of kids) if (k.exitCode === null) k.kill();
    await sleep(300);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('#513: an exited process that is still listed counts as ended; a second end of it is no error', { skip }, () => {
  const out = ps('$p = Start-Process -FilePath "$env:WINDIR\\System32\\ping.exe" -ArgumentList "-n","30","127.0.0.1" -WindowStyle Hidden -PassThru; '
    + 'Start-Sleep -Milliseconds 300; $running = [Keevault.Setup.UpdateWait]::Ended($p.Id); $h = $p.Handle; $p.Kill(); $p.WaitForExit(); '
    + '"$running $([Keevault.Setup.UpdateWait]::Ended($p.Id)) $([Keevault.Setup.UpdateWait]::Ended(999999999))"');
  assert.equal(out, 'False True True', 'running: no; ended (handle still held): yes; gone: yes');
  const errors = src('Errors.cs');
  assert.match(errors, /catch \(Win32Exception e\) when \(e\.NativeErrorCode == 5\)/, 'access denied of an exiting process is logged as such');
  assert.doesNotMatch(errors, /WaitForExit\(5000\)/, 'no 5 s wait per process');
});

test('#513: the setup never runs over open files; the window says what it waits for, with retry and cancel', () => {
  const program = src('Program.cs');
  const run = program.slice(program.indexOf('private async Task RunUpdate(bool retry)'), program.indexOf('private async Task FailUpdateWithRollback'));
  assert.ok(run.indexOf('UpdateWait.Signal()') < run.indexOf('ReadyToInstall('), 'the helpers are asked first');
  assert.ok(run.indexOf('if (!await ReadyToInstall(') < run.indexOf('RunHidden(setup'), 'the setup only after the folder is free');
  assert.match(run, /var locked = await Task\.Run\(\(\) => UpdateWait\.LockedFilesSettled\(dir, TimeSpan\.FromSeconds\(5\)\)\);\s+if \(left\.Count > 0 \|\| locked\.Count > 0\)[\s\S]*?break;/, 'a second attempt only over a free folder');
  const ready = program.slice(program.indexOf('private async Task<bool> ReadyToInstall'), program.indexOf('private static string KindLabel'));
  assert.match(ready, /if \(kinds\.Count == 0 && locked\.Count == 0\) return true;/);
  assert.match(ready, /Text\.T\("Wartet noch auf: \{0\}"/);
  assert.match(ready, /Text\.T\("Erneut versuchen"\)[\s\S]*RunUpdate\(true\)/);
  assert.match(ready, /Text\.T\("Abbrechen"\)/);
  assert.match(ready, /startAppOnClose = true;/, 'cancelled: the old version starts again');
  for (const s of ['Wartet noch auf: {0}', 'Update wartet', 'Abbrechen', 'KI-Agent-Verbindung (MCP)', 'Browser-Verbindung', 'Keevault (App)']) assert.ok(program.includes(`["${s}"] =`), `English for "${s}"`);
  assert.match(src('NativeHost.cs'), /UpdateWait\.Signalled\(signal, started\)\) Environment\.Exit\(0\)/, 'the relay (#505) quits on the signal too');
  const updater = readFileSync(fileURLToPath(new URL('../desktop/updater.js', import.meta.url)), 'utf8');
  assert.match(updater, /setTimeout\(\(\) => app\.quit\(\), 250\);\s+\/\/ #513[\s\S]*?setTimeout\(\(\) => app\.exit\(0\), 10_000\)/, 'the app ends itself before the installer');
});

test('#513: the built update window renders the waiting page', { skip: process.platform !== 'win32' || !existsSync(fileURLToPath(new URL('../windows/out/Keevault-Update.exe', import.meta.url))) }, () => {
  const exe = fileURLToPath(new URL('../windows/out/Keevault-Update.exe', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'kv513-shot-'));
  try {
    const png = join(dir, 'waiting.png');
    execFileSync(exe, ['--screenshot', png, '--page', 'waiting', '--lang', 'de'], { stdio: 'ignore', timeout: 30_000 });
    assert.ok(existsSync(png));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
