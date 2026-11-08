import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// #418: setup.ps1 -Scope Machine writes its transcript as SYSTEM. The folder must be one a standard user cannot create
// beforehand: Start-Transcript follows a junction or hard link planted there.

const win = process.platform === 'win32';
const script = fileURLToPath(new URL('../installer/setup.ps1', import.meta.url));

function powershell(command, env = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

/** Evaluates the real $LogDir assignment of setup.ps1 for machine scope, without running anything else of the script. */
function machineLogDir() {
  return powershell(`$t = $null; $e = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($env:KV_SETUP, [ref]$t, [ref]$e)
    $a = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$LogDir' }, $true)[0]
    $Scope = 'Machine'
    Invoke-Expression $a.Extent.Text
    $LogDir`, { KV_SETUP: script });
}

test('the machine log is not below ProgramData', { skip: !win }, () => {
  const dir = machineLogDir();
  assert.equal(dir.toLowerCase(), `${process.env.SystemRoot}\\Logs\\Keevault`.toLowerCase());
  assert.ok(!dir.toLowerCase().startsWith(String(process.env.ProgramData).toLowerCase()), dir);
});

test('standard users cannot create the machine log folder beforehand', { skip: !win }, () => {
  const parent = machineLogDir().replace(/\\[^\\]+$/, '');
  // Rights on the folder itself for Users, Authenticated Users, Everyone. Bits: create file, create folder, delete,
  // change permissions, take ownership, generic all/write.
  const found = powershell(`$rules = [IO.Directory]::GetAccessControl($env:KV_DIR).GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
    $mask = 0x2 -bor 0x4 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
    foreach ($r in $rules) {
      if ($r.AccessControlType -ne 'Allow') { continue }
      if ($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
      if (@('S-1-5-32-545', 'S-1-5-11', 'S-1-1-0') -notcontains $r.IdentityReference.Value) { continue }
      if ([int64]$r.FileSystemRights -band $mask) { "$($r.IdentityReference.Value) $($r.FileSystemRights)" }
    }`, { KV_DIR: parent });
  assert.equal(found, '', `${parent} is writable: ${found}`);
});
