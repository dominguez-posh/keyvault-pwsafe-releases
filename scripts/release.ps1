#Requires -Version 7
<#
.SYNOPSIS
    Builds all installers locally: passkey provider (MSIX), browser extension (CRX + update.xml),
    Keevault-Setup-<version>.exe (per user), Keevault-<version>.msi (per machine, GPO/Intune) and Keevault-<version>.msix. -Publish uploads them as GitHub release v<version>.

.DESCRIPTION
    Local on purpose: the extension's private key (extension-key.pem) never leaves this machine. Browsers fetch
    the extension from the latest release (update.xml), so every release needs a higher version in package.json
    and extension/manifest.json.

.EXAMPLE
    npm run installer
.EXAMPLE
    pwsh scripts/release.ps1 -Publish
#>
[CmdletBinding()]
param([switch] $Publish)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
Set-Location $root
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$extVersion = (Get-Content extension/manifest.json -Raw | ConvertFrom-Json).version
if ($version -ne $extVersion) { throw "Version in package.json ($version) und extension/manifest.json ($extVersion) unterscheiden sich." }

function Invoke-Step([string] $name, [scriptblock] $block) {
    Write-Host "== $name" -ForegroundColor Cyan
    & $block
    if ($LASTEXITCODE) { throw "$name fehlgeschlagen ($LASTEXITCODE)" }
}

Invoke-Step 'Passkey-Anbieter (MSIX)' { & ./windows/build.ps1 -Version "$version.0" }
Invoke-Step 'Erweiterung (ZIP)' { npm run ext:pack }
Invoke-Step 'Erweiterung (CRX + update.xml)' { node scripts/pack-crx.mjs }
Invoke-Step 'Installer (EXE + MSIX)' { npx electron-builder --win nsis appx --publish never }
Invoke-Step 'Installer für Administratoren (MSI)' { node scripts/build-msi.mjs }
Invoke-Step 'MSIX signieren' {
    # Same certificate as the passkey provider (CN=KeyVault PwSafe Test, CurrentUser\My) – replace with a purchased
    # code-signing certificate later; Publisher in package.json (appx.publisher) must match its subject.
    $publisher = (Get-Content package.json -Raw | ConvertFrom-Json).build.appx.publisher
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $publisher -and $_.NotAfter -gt (Get-Date) -and $_.HasPrivateKey } | Select-Object -First 1
    if (-not $cert) { throw "Zertifikat $publisher fehlt (windows/build.ps1 legt es an)" }
    $signtool = Get-ChildItem (Join-Path $root 'windows/out/tools') -Recurse -Filter signtool.exe | Where-Object FullName -Match '\\x64\\' | Select-Object -First 1
    & $signtool.FullName sign /fd SHA256 /sha1 $cert.Thumbprint /s My (Join-Path $root "release/Keevault-$version.msix") | Out-Host
}

Invoke-Step 'Geräte-Skript für IT/Intune (Zertifikat eingebettet)' {
    $cer = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $root 'windows/out/KvPwSafe-Test.cer')))
    $script = (Get-Content (Join-Path $root 'installer/setup.ps1') -Raw).Replace('__CERTIFICATE_BASE64__', $cer)
    # BOM: Windows PowerShell 5.1 (Intune) reads the umlauts correctly only with it.
    [IO.File]::WriteAllText((Join-Path $root 'release/Keevault-Geraet-Einrichten.ps1'), $script, [Text.UTF8Encoding]::new($true))
}

$setup = Join-Path $root "release/Keevault-Setup-$version.exe"
# Same installer under a fixed name: the website links to releases/latest/download/Keevault-Setup.exe.
# latest.yml (+ blockmap) is what the app's update check reads via https://keevault.de/update/ (website/php/api/dl.php).
$stable = Join-Path $root 'release/Keevault-Setup.exe'
Copy-Item $setup $stable -Force
$msi = Join-Path $root "release/Keevault-$version.msi"
$msix = Join-Path $root "release/Keevault-$version.msix"
Copy-Item $msi (Join-Path $root 'release/Keevault.msi') -Force
Copy-Item $msix (Join-Path $root 'release/Keevault.msix') -Force
# Public part of the signing certificate: devices must trust it before the MSIX installs (until a purchased one).
Copy-Item (Join-Path $root 'windows/out/KvPwSafe-Test.cer') (Join-Path $root 'release/Keevault-Zertifikat.cer') -Force
$assets = @($setup, $stable, $msi, (Join-Path $root 'release/Keevault.msi'), $msix, (Join-Path $root 'release/Keevault.msix'), (Join-Path $root 'release/Keevault-Zertifikat.cer'), (Join-Path $root 'release/latest.yml'), "$setup.blockmap", (Join-Path $root 'release/Keevault-Geraet-Einrichten.ps1'), (Join-Path $root 'dist/kvpwsafe-extension.crx'), (Join-Path $root 'dist/update.xml'))
foreach ($a in $assets) { if (-not (Test-Path $a)) { throw "$a fehlt" } }
Write-Host "Fertig: $setup" -ForegroundColor Green

if ($Publish) {
    # Public repository = source-available code + releases (browsers fetch update.xml/CRX from it without signing in).
    # The private repository keeps website, license tool and notes; scripts/export-public.mjs leaves them out.
    $publicRepo = 'dominguez-posh/keyvault-pwsafe-releases'
    $public = Join-Path (Split-Path $root) 'keevault-public'
    Invoke-Step 'Quellcode ins öffentliche Repo' {
        if (-not (Test-Path (Join-Path $public '.git'))) {
            git clone "https://github.com/$publicRepo.git" $public
            if ($LASTEXITCODE) { throw 'Klonen fehlgeschlagen' }
        }
        git -C $public pull --ff-only
        if ($LASTEXITCODE) { throw 'Öffentliches Repo nicht aktuell' }
        node scripts/export-public.mjs $public
        if ($LASTEXITCODE) { throw 'Export abgebrochen (interne Daten gefunden?)' }
        git -C $public add -A
        git -C $public diff --cached --quiet
        if ($LASTEXITCODE) {
            git -C $public commit -m "Keevault $version"
            if ($LASTEXITCODE) { throw 'Commit fehlgeschlagen' }
        }
        git -C $public push origin HEAD
    }
    $commit = (git -C $public rev-parse HEAD).Trim()
    Invoke-Step "GitHub-Release v$version" {
        # The tag points at exactly the source the installer was built from (verifiable, see README).
        gh release create "v$version" @assets --repo $publicRepo --target $commit --title "Keevault $version" --notes "EXE (pro Benutzer), MSI (pro Gerät, GPO/Intune: msiexec /i Keevault.msi /qn) und MSIX (Zertifikat Keevault-Zertifikat.cer vorher vertrauen). Installer mit Passkey-Anbieter und Browser-Erweiterung (Edge/Chrome per Richtlinie). Quellcode dieser Version: Tag v$version."
    }
}
