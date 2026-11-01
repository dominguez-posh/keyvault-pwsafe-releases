// The emergency export script (installer/emergency/Keevault-Notfall-Export.ps1) decrypts what the app encrypts:
// a keyring and a sealed item made here with extension/core/protect.js are opened by the script's own PowerShell
// crypto (master password and recovery key), and its KeePass XML keeps titles, passwords and extra fields.
// Needs PowerShell 7.2+ (pwsh); skipped where it is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyring, setPassword, newRecoveryKey } from '../extension/core/protect.js';
import { serializeItem } from '../extension/core/model.js';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'installer', 'emergency', 'Keevault-Notfall-Export.ps1');
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;

const PS = String.raw`
param($Script, $Fixture)
$ErrorActionPreference = 'Stop'
. $Script -Vault x
$f = Get-Content $Fixture -Raw | ConvertFrom-Json
$ck = Unlock-Keyring $f.keyring $f.password ''
if (-not $ck) { throw 'password unlock failed' }
$plain = [Text.Encoding]::UTF8.GetString((Unprotect-Sealed $ck $f.sealed $f.aad))
if ($plain -ne $f.plain) { throw 'decrypted value differs' }
$ck2 = Unlock-Keyring $f.keyring '' $f.recovery
if (-not $ck2 -or [Convert]::ToBase64String($ck2) -ne [Convert]::ToBase64String($ck)) { throw 'recovery unlock failed' }
if (Unlock-Keyring $f.keyring 'wrong password' '') { throw 'wrong password accepted' }
$bad = $false; try { Unprotect-Sealed $ck $f.sealed 'other/aad' | Out-Null; $bad = $true } catch {}
if ($bad) { throw 'wrong additional data accepted' }
$entries = @([pscustomobject]@{ VaultName = 'kv-test'; VaultHost = 'kv-test.vault.azure.net'; Id = 'pws-abc'; Doc = ($plain | ConvertFrom-Json) })
[xml]$x = [Text.Encoding]::UTF8.GetString((ConvertTo-KeePassXml $entries))
$e = $x.KeePassFile.Root.Group.Group.Group.Group.Entry
if (($e.String | Where-Object Key -eq 'Title').Value -ne $f.title) { throw 'KeePass title' }
if (($e.String | Where-Object Key -eq 'Password').Value.'#text' -ne $f.secret) { throw 'KeePass password' }
if (($e.String | Where-Object Key -eq 'Notes').Value -notmatch 'PIN: 1234') { throw 'KeePass extra fields' }
'OK'
`;

test('emergency export script decrypts the app format and writes KeePass XML', { skip: !hasPwsh && 'pwsh not installed' }, async () => {
  let { keyring, ck } = await createKeyring('kv-test.vault.azure.net');
  keyring = await setPassword(keyring, ck, 'Notfall-Test-123!');
  const r = await newRecoveryKey(keyring, ck);
  keyring = r.keyring;
  const secret = 'p@ss"wörd <&>';
  const title = 'Grüße & <Test>';
  const { value } = serializeItem({ type: 'login', title, username: 'ops', password: secret, urls: ['https://a.example'], folder: 'Kunden/Contoso', fields: [{ name: 'PIN', value: '1234' }] });
  const aad = 'kv-test.vault.azure.net/pws-abc';
  const dir = mkdtempSync(join(tmpdir(), 'kv-notfall-'));
  try {
    const fixture = join(dir, 'fixture.json');
    const runner = join(dir, 'run.ps1');
    writeFileSync(fixture, JSON.stringify({ keyring, sealed: await ck.encrypt(value, aad), aad, plain: value, password: 'Notfall-Test-123!', recovery: r.recoveryKey, title, secret }));
    writeFileSync(runner, PS);
    const out = spawnSync('pwsh', ['-NoProfile', '-File', runner, '-Script', script, '-Fixture', fixture], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(out.stdout.trim().split(/\r?\n/).pop(), 'OK', out.stderr || out.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
