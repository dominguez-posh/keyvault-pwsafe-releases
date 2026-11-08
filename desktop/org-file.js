// The organization file kvpwsafe.config.json (next to the program, in %ProgramData%\Keevault or in the repository root
// during development): presets of the company. Its values are enforced, the app cannot change them.
//
// %ProgramData% lets every standard user create folders and files (#423): a user of a shared device could plant the
// file for everyone else (tenant, extension IDs for the native host, MCP). A file there counts only when it and its
// folder are owned by SYSTEM, Administrators or TrustedInstaller and nobody else may change, delete or replace it.
// Next to the program and in the app folder only the installer or the developer write.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export const TRUSTED_SIDS = ['S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'];

/** rights: { file: { owner, writers }, folder: { owner, writers } } (SIDs); null (unknown) is never trusted. */
export function orgPlaceTrusted(rights) {
  const fine = (x) => !!x && TRUSTED_SIDS.includes(x.owner) && Array.isArray(x.writers) && x.writers.every((s) => TRUSTED_SIDS.includes(s));
  return !!rights && fine(rights.file) && fine(rights.folder);
}

// Rights that let someone change the file: write/append data and attributes, delete, change permissions or owner,
// generic all/write. On the folder: those that let someone remove or swap the file – delete children (0x40), delete,
// permissions, owner, generic all; adding files is fine (Users may by default, a planted file has the user as owner).
// Inherit-only entries do not apply to the object itself.
// One handle (#431): the file is opened once (others may only read meanwhile, not write, delete or rename it); its
// rights and its content come from that handle, so a junction turned elsewhere after the check changes nothing. A
// reparse point (junction, link) as the folder or the file is refused before and after opening.
const PS_RIGHTS = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Reparse($p) { ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0 }
$fileMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000 -bor 0x40000000
$dirMask = 0x40 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x10000000
$sid = [System.Security.Principal.SecurityIdentifier]
function Rights($acl, $mask) {
  $w = foreach ($r in $acl.GetAccessRules($true, $true, $sid)) {
    if ($r.AccessControlType -ne 'Allow') { continue }
    if ($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
    if ([int64]$r.FileSystemRights -band $mask) { $r.IdentityReference.Value }
  }
  @{ owner = $acl.GetOwner($sid).Value; writers = @($w) }
}
if ((Reparse $env:KV_DIR) -or (Reparse $env:KV_FILE)) { 'null'; exit }
$fs = [IO.File]::Open($env:KV_FILE, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
  if ((Reparse $env:KV_DIR) -or (Reparse $env:KV_FILE)) { 'null'; exit }
  $file = Rights $fs.GetAccessControl() $fileMask
  $folder = Rights ([IO.Directory]::GetAccessControl($env:KV_DIR)) $dirMask
  $text = (New-Object IO.StreamReader($fs, (New-Object Text.UTF8Encoding($false)))).ReadToEnd()
  ConvertTo-Json -Compress -Depth 3 @{ file = $file; folder = $folder; text = $text }
} finally { $fs.Dispose() }`;

/**
 * Owner and writers of the file and its folder plus the file's text, all through one handle (Windows); null when they
 * cannot be read or a reparse point is in the way – then the file does not count.
 */
export function readRights(file) {
  try {
    const out = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', PS_RIGHTS],
      { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, KV_FILE: file, KV_DIR: path.dirname(file) } });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** The first organization file found. where: { execPath, programData, appPath }; security(file): rights (tests). */
export function readOrgFile({ execPath, programData, appPath }, { security = readRights } = {}) {
  // Only the text read with the rights counts, never a second read of the path (#431).
  const shared = (file) => {
    if (!fs.existsSync(file)) return null;
    const r = security(file);
    if (!orgPlaceTrusted(r) || typeof r.text !== 'string') return null;
    try {
      return JSON.parse(r.text.replace(/^﻿/, ''));
    } catch {
      return null;
    }
  };
  const candidates = [
    [path.join(path.dirname(execPath), 'kvpwsafe.config.json'), readJson],
    programData && [path.join(programData, 'Keevault', 'kvpwsafe.config.json'), shared],
    // Folder of the old product name (KeyVault PwSafe), still honored for existing deployments.
    programData && [path.join(programData, 'KeyVault PwSafe', 'kvpwsafe.config.json'), shared],
    [path.join(appPath, 'kvpwsafe.config.json'), readJson],
  ].filter(Boolean);
  for (const [file, read] of candidates) {
    const value = read(file);
    if (value) return value;
  }
  return {};
}

/** Smoke (#423, #431): is a file a user planted in a ProgramData-like folder (dir), directly or behind a junction, taken? */
export async function plantedOrgFileTaken(dir) {
  await fs.promises.mkdir(path.join(dir, 'Keevault'), { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'Keevault', 'kvpwsafe.config.json'), JSON.stringify({ tenantId: 'planted' }));
  const junction = path.join(dir, 'via-junction');
  try {
    if (readOrgFile({ execPath: path.join(dir, 'x.exe'), programData: dir, appPath: dir }).tenantId) return true;
    await fs.promises.mkdir(junction);
    await fs.promises.symlink(path.join(dir, 'Keevault'), path.join(junction, 'Keevault'), 'junction');
    return readRights(path.join(junction, 'Keevault', 'kvpwsafe.config.json')) !== null;
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
