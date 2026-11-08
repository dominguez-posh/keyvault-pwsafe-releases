# #377: measures a smoke run from outside the app. Starts scripts/start.mjs with the given arguments and KVPWSAFE_SMOKE_DEBUG=1,
# polls every top-level window of that worktree's Electron processes and whether one of them holds the foreground.
# The run's output is passed on line by line, so a run that has to be stopped has still told how far it got. Writes nothing to
# disk. Example:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-window-watch.ps1 --demo --smoke-test --screenshot=C:\temp\x.png
# Exit code: the run's own, 3 if the run passed but a window was seen, 4 if the run was stopped after -TimeoutSeconds (longer
# than the run's own deadline in desktop/main/smoke-guard.js: this is for a main process that no longer reacts).
# Summary line: WATCH samples= visible= foreground= exit=
[CmdletBinding(PositionalBinding = $false)]
param(
  [string]$Root = '',
  [string]$Script = 'scripts/start.mjs',
  [string]$ProcessName = 'electron',
  [string]$ImagePrefix = '',
  [int]$IntervalMs = 100,
  [int]$TimeoutSeconds = 600,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$RunArgs
)
$ErrorActionPreference = 'Stop'
if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
if (-not $ImagePrefix) { $ImagePrefix = Join-Path $Root 'node_modules\electron\dist\' }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SmokeWindowWatch {
  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  public static List<string> Visible(int[] pids) {
    var wanted = new HashSet<int>(pids);
    var found = new List<string>();
    EnumWindows((hwnd, param) => {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (wanted.Contains((int)pid) && IsWindowVisible(hwnd)) {
        var text = new StringBuilder(256);
        GetWindowText(hwnd, text, 256);
        RECT r;
        GetWindowRect(hwnd, out r);
        found.Add(String.Format("pid={0} title=\"{1}\" rect={2},{3},{4},{5}", pid, text, r.Left, r.Top, r.Right, r.Bottom));
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static int ForegroundPid() {
    uint pid = 0;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return (int)pid;
  }
}
'@

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = (@($Script) + @($RunArgs | Where-Object { $_ }) | ForEach-Object { '"' + $_ + '"' }) -join ' '
$psi.WorkingDirectory = $Root
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$psi.EnvironmentVariables['KVPWSAFE_SMOKE_DEBUG'] = '1'

$clock = [System.Diagnostics.Stopwatch]::StartNew()
$run = [System.Diagnostics.Process]::Start($psi)
$streams = @(@{ Reader = $run.StandardOutput; Task = $null; Done = $false }, @{ Reader = $run.StandardError; Task = $null; Done = $false })
function Show-Lines {
  foreach ($s in $streams) {
    while (-not $s.Done) {
      if (-not $s.Task) { $s.Task = $s.Reader.ReadLineAsync() }
      if (-not $s.Task.IsCompleted) { break }
      $line = $s.Task.Result
      $s.Task = $null
      if ($null -eq $line) { $s.Done = $true } else { Write-Output $line }
    }
  }
}

$samples = 0; $visibleSamples = 0; $foregroundSamples = 0
$pids = [int[]]@(); $last = ''; $lastForeground = $false; $timedOut = $false
while (-not $run.HasExited) {
  Show-Lines
  if (-not $timedOut -and $clock.Elapsed.TotalSeconds -gt $TimeoutSeconds) {
    $timedOut = $true
    Write-Output ('WATCH run did not end within {0} s, stopping it' -f $TimeoutSeconds)
    & taskkill.exe /T /F /PID $run.Id | Out-Null
  }
  if ($samples % 5 -eq 0) {
    $pids = [int[]]@(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($ImagePrefix, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.Id })
  }
  $samples++
  $seen = [SmokeWindowWatch]::Visible($pids)
  if ($seen.Count) { $visibleSamples++ }
  $now = ($seen -join ' | ')
  if ($now -ne $last) { Write-Output ('WATCH +{0:n1}s visible: {1}' -f $clock.Elapsed.TotalSeconds, $(if ($now) { $now } else { 'none' })); $last = $now }
  $foreground = $pids -contains [SmokeWindowWatch]::ForegroundPid()
  if ($foreground) { $foregroundSamples++ }
  if ($foreground -ne $lastForeground) { Write-Output ('WATCH +{0:n1}s foreground: {1}' -f $clock.Elapsed.TotalSeconds, $foreground); $lastForeground = $foreground }
  Start-Sleep -Milliseconds $IntervalMs
}
$run.WaitForExit()
# Whatever is left in the pipes, without waiting for ever on a process that inherited one of them.
for ($i = 0; $i -lt 30 -and ($streams | Where-Object { -not $_.Done }); $i++) { Show-Lines; Start-Sleep -Milliseconds 100 }
$code = $(if ($timedOut) { 4 } else { $run.ExitCode })
Write-Output ('WATCH samples={0} visible={1} foreground={2} exit={3} seconds={4:n0}' -f $samples, $visibleSamples, $foregroundSamples, $code, $clock.Elapsed.TotalSeconds)
if ($code -eq 0 -and ($visibleSamples -or $foregroundSamples)) { exit 3 }
exit $code
