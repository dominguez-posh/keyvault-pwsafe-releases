#Requires -Version 7
<#
.SYNOPSIS
    Installiert den Windows-Passkey-Anbieter von Keevault für den aktuellen Benutzer.

.DESCRIPTION
    1. Vertraut dem Testzertifikat (nur bei selbstsigniertem Paket; dafür einmal Administratorrechte/UAC).
    2. Installiert das MSIX für den aktuellen Benutzer.
    3. Registriert den Anbieter bei Windows.
    Danach in Windows unter Einstellungen → Konten → Passkeys → Erweiterte Optionen „Keevault“
    einschalten und in der Desktop-App unter Einstellungen „Als Passkey-Anbieter in Windows verwenden“ aktivieren.

.EXAMPLE
    ./windows/Install-PasskeyProvider.ps1
.EXAMPLE
    ./windows/Install-PasskeyProvider.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [string] $Package = (Join-Path $PSScriptRoot 'out\KvPwSafe.PasskeyProvider.msix'),
    [string] $Certificate = (Join-Path $PSScriptRoot 'out\KvPwSafe-Test.cer'),
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'
$alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\kvpwsafe-passkeys.exe'

if ($Uninstall) {
    if (Test-Path $alias) { & $alias --unregister | Out-Host }
    Get-AppxPackage -Name 'KvPwSafe.PasskeyProvider' | Remove-AppxPackage
    Write-Host 'Passkey-Anbieter entfernt.'
    return
}

if (-not (Test-Path $Package)) { throw "Paket nicht gefunden: $Package – zuerst ./windows/build.ps1 ausführen." }

if (Test-Path $Certificate) {
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($Certificate)
    $trusted = Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Thumbprint -EQ $cert.Thumbprint
    if (-not $trusted) {
        Write-Host 'Vertraue dem Testzertifikat (Administratorrechte nötig) …'
        $cmd = "Import-Certificate -FilePath '$Certificate' -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null"
        $p = Start-Process pwsh -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile', '-Command', $cmd
        if ($p.ExitCode) { throw 'Zertifikat konnte nicht importiert werden.' }
    }
}

Write-Host 'Installiere Paket …'
Add-AppxPackage -Path $Package -ForceUpdateFromAnyVersion
Start-Sleep -Seconds 1
if (-not (Test-Path $alias)) { throw "Alias $alias fehlt – Installation prüfen." }

Write-Host 'Registriere bei Windows …'
$result = & $alias --register | ConvertFrom-Json
$result | Format-List | Out-Host
if (-not $result.registered) { throw "Registrierung fehlgeschlagen ($($result.hresult))." }

Write-Host ''
Write-Host 'Fertig. Noch zwei Schritte:' -ForegroundColor Green
Write-Host '  1. Windows: Einstellungen → Konten → Passkeys → Erweiterte Optionen → „Keevault“ einschalten'
Write-Host '  2. Desktop-App: Einstellungen → „Keevault als Passkey-Anbieter in Windows verwenden“'
Start-Process 'ms-settings:savedpasskeys'
