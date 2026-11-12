// Smoke helper for #526: another program holds the clipboard for a moment (clipboard monitors, the Windows clipboard
// history and its sync open it after every change). Keevault-Update.exe --clipboard must wait for it and then copy,
// instead of failing after 1 s as before. The holder is a hidden PowerShell process (no window): it opens the
// clipboard, says "held", keeps it for `ms` and closes it. No Electron here: a test can drive it.

import { spawn } from 'node:child_process';

// It opens the clipboard for a message-only window (parent HWND_MESSAGE: never shown) like a real clipboard program:
// opened without an owner window (NULL), Windows 11 did not keep other processes out in a test on 2026-11-11.
// #526: no progress records (CLIXML on stderr with -EncodedCommand); "compiled" tells a slow start from a slow open.
const holderScript = (ms) => `$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Name Clip -Namespace KvSmoke -MemberDefinition '[DllImport("user32.dll", SetLastError = true)] public static extern bool OpenClipboard(IntPtr owner); [DllImport("user32.dll")] public static extern bool CloseClipboard(); [DllImport("user32.dll")] public static extern IntPtr GetOpenClipboardWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder name, int count);'
[Console]::Out.WriteLine('compiled')
$owner = New-Object System.Windows.Forms.NativeWindow
$params = New-Object System.Windows.Forms.CreateParams
$params.Parent = [IntPtr](-3)
$owner.CreateHandle($params)
$open = $false
$err = 0
for ($i = 0; $i -lt 40 -and -not ($open = [KvSmoke.Clip]::OpenClipboard($owner.Handle)); $i++) { $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); Start-Sleep -Milliseconds 50 }
if (-not $open) {
  # Who holds it: the window that opened it (0 = opened without a window, or Windows refuses it, e.g. a locked session).
  $w = [KvSmoke.Clip]::GetOpenClipboardWindow(); $holder = 0; [void][KvSmoke.Clip]::GetWindowThreadProcessId($w, [ref]$holder)
  $class = New-Object System.Text.StringBuilder 256; [void][KvSmoke.Clip]::GetClassName($w, $class, 256)
  # Only name, PID and window class: a foreign program's command line may hold paths or secrets, it stays out of the log.
  $p = if ($holder) { Get-Process -Id $holder -ErrorAction SilentlyContinue }
  [Console]::Out.WriteLine("busy error=$err window=$w pid=$holder process=$($p.ProcessName) class=$class"); exit 1
}
try { [Console]::Out.WriteLine('held'); Start-Sleep -Milliseconds ${Number(ms) | 0} } finally { [void][KvSmoke.Clip]::CloseClipboard() }`;

/**
 * Holds the clipboard in a child process for `ms`. → { held, why, released }: held is true once the child has it open;
 * otherwise why says what kept it out – with the window and process holding the clipboard when there was one (#526:
 * in full smoke runs something held it for the whole clipboard area). released resolves when the child has ended.
 */
export function holdClipboard(ms, { startTimeoutMs = 15000 } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ held: false, why: 'not Windows', released: Promise.resolve() });
  const encoded = Buffer.from(holderScript(ms), 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const released = new Promise((resolve) => { child.on('exit', resolve); child.on('error', resolve); });
  return new Promise((resolve) => {
    let out = '';
    const timer = setTimeout(() => { child.kill(); resolve({ held: false, why: `no answer from PowerShell in ${startTimeoutMs} ms (${/\bcompiled\b/.test(out) ? 'compiled, then stuck opening the clipboard' : 'still loading/compiling'})`, released }); }, startTimeoutMs);
    const done = (held, why = '') => { clearTimeout(timer); resolve({ held, why, released }); };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (/\bheld\b/.test(out)) done(true);
      else if (/\bbusy .*\r?\n/.test(out)) done(false, `the clipboard stayed held for 2 s: ${out.match(/busy (.*)/)[1].trim()}`);
    });
    child.on('exit', (code) => done(/\bheld\b/.test(out), `PowerShell ended with ${code}: ${out.trim().slice(0, 200)}`));
    child.on('error', (e) => done(false, e.message));
  });
}

/**
 * The smoke check: with the clipboard held for 2 s by another process, a copy through the helper still arrives.
 * Before #526 the helper gave up after ~1 s (exit 2) – this check fails with such a helper.
 */
export async function heldClipboardCheck({ copyViaHelperExe, clipboardHas, fail, log = console.log }) {
  if (process.platform !== 'win32') return;
  const { held, why, released } = await holdClipboard(2000);
  if (!held) {
    log(`[features] clipboard: could not hold the clipboard from a second process (${why}) – the #526 wait check is not judged`);
    await released;
    return;
  }
  const marker = `kv-held-${Date.now()}`;
  const started = Date.now();
  const copied = await copyViaHelperExe(marker);
  const took = Date.now() - started;
  await released;
  if (!copied) fail('clipboard', `#526: copy failed while another process held the clipboard for 2 s (after ${took} ms) – the helper does not wait long enough`);
  await clipboardHas(marker); // clears the marker again: the clipboard is empty after the run
}
