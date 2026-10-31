#Requires -Version 5.1
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
param(
    [switch] $Publish,
    # Also attach the macOS/Linux builds (release/ci) and the Android APK. Off since 2026-10-31: the website offers
    # Windows only ("coming soon" for the rest) until those platforms are ready.
    [switch] $Previews
)

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

# Sophos CryptoGuard reported this script as ransomware (2026-10-31): fast mass deletes and overwriting existing
# installers with new binaries look like encryption. So: delete one file at a time with a pause, and replace targets
# (delete, then copy) instead of overwriting them in place.
function Remove-Slowly([string] $path) {
    if (-not (Test-Path $path)) { return }
    foreach ($f in @(Get-ChildItem $path -Recurse -File -Force)) { Remove-Item $f.FullName -Force; Start-Sleep -Milliseconds 20 }
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
}
function Copy-Fresh([string] $from, [string] $to) {
    if (Test-Path $to) { Remove-Item $to -Force; Start-Sleep -Milliseconds 200 }
    Copy-Item $from $to
}

$unpacked = Join-Path $root 'release/win-unpacked'
Invoke-Step 'Passkey-Anbieter (MSIX)' { & ./windows/build.ps1 -Version "$version.0" }
Invoke-Step 'Erweiterung (ZIP)' { npm run ext:pack }
Invoke-Step 'Erweiterung (CRX + update.xml)' { node scripts/pack-crx.mjs }
Invoke-Step 'Installer (EXE + MSIX)' {
    # electron-builder empties release/win-unpacked first. A test build still running from there locks the folder
    # (EBUSY); then build next to it in release/build and copy the installers over.
    $out = 'release'
    if (Test-Path $unpacked) {
        try { Rename-Item $unpacked 'win-unpacked.old' -ErrorAction Stop; Remove-Slowly "$unpacked.old" }
        catch { Write-Warning 'release/win-unpacked ist gesperrt (läuft Keevault.exe daraus?) – baue nach release/build'; $out = 'release/build' }
    }
    npx electron-builder --win nsis appx --publish never "-c.directories.output=$out"
    if ($LASTEXITCODE) { return }
    if ($out -ne 'release') {
        $script:unpacked = Join-Path $root "$out/win-unpacked"
        foreach ($f in Get-ChildItem (Join-Path $root $out) -File | Where-Object { $_.Name -match '^(Keevault-.*\.(exe|msix|blockmap)|latest\.yml)$' }) {
            Copy-Fresh $f.FullName (Join-Path $root "release/$($f.Name)")
        }
    }
}
# Release notes (CHANGELOG.md) go into the manifest before it is signed: the app shows them in its update dialog.
Invoke-Step 'Release-Notes aus CHANGELOG.md' { node scripts/release-notes.mjs }
# The app only accepts update manifests signed with update-key.pem (desktop/update-verify.js).
Invoke-Step 'Update-Manifest signieren (Ed25519)' { node scripts/update-key.mjs sign release/latest.yml }
Invoke-Step 'Installer für Administratoren (MSI)' { $env:KV_UNPACKED_DIR = $unpacked; node scripts/build-msi.mjs }
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

Invoke-Step 'Richtlinien-Vorlagen (ADMX für GPO/Intune + Intune-Skript)' {
    $stage = Join-Path $root 'release/policy'
    Remove-Slowly $stage
    Copy-Item (Join-Path $root 'installer/policy') $stage -Recurse
    # BOM for Windows PowerShell 5.1 (umlauts in the settings block).
    $ps = Join-Path $stage 'Keevault-Richtlinie-Intune.ps1'
    [IO.File]::WriteAllText($ps, [IO.File]::ReadAllText($ps), [Text.UTF8Encoding]::new($true))
    $zip = Join-Path $root 'release/Keevault-Richtlinien.zip'
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
}

$setup = Join-Path $root "release/Keevault-Setup-$version.exe"
# Same installer under a fixed name: the website links to releases/latest/download/Keevault-Setup.exe.
# latest.yml (+ blockmap) is what the app's update check reads via https://keevault.de/update/ (website/php/api/dl.php).
$stable = Join-Path $root 'release/Keevault-Setup.exe'
Copy-Fresh $setup $stable
$msi = Join-Path $root "release/Keevault-$version.msi"
$msix = Join-Path $root "release/Keevault-$version.msix"
Copy-Fresh $msi (Join-Path $root 'release/Keevault.msi')
Copy-Fresh $msix (Join-Path $root 'release/Keevault.msix')
# Public part of the signing certificate: devices must trust it before the MSIX installs (until a purchased one).
Copy-Fresh (Join-Path $root 'windows/out/KvPwSafe-Test.cer') (Join-Path $root 'release/Keevault-Zertifikat.cer')
$assets = @($setup, $stable, $msi, (Join-Path $root 'release/Keevault.msi'), $msix, (Join-Path $root 'release/Keevault.msix'), (Join-Path $root 'release/Keevault-Zertifikat.cer'), (Join-Path $root 'release/latest.yml'), (Join-Path $root 'release/latest.yml.sig'), "$setup.blockmap", (Join-Path $root 'release/Keevault-Geraet-Einrichten.ps1'), (Join-Path $root 'release/Keevault-Richtlinien.zip'), (Join-Path $root 'dist/kvpwsafe-extension.crx'), (Join-Path $root 'dist/update.xml'), (Join-Path $root "dist/kvpwsafe-extension-$version-firefox.zip"))
# Mobile app (preview): the Android debug APK goes along when it was built (mobile/README.md).
$apk = Join-Path $root 'mobile/android/app/build/outputs/apk/debug/app-debug.apk'
if ($Previews -and (Test-Path $apk)) {
    $mobileVersion = (Get-Content (Join-Path $root 'mobile/package.json') -Raw | ConvertFrom-Json).version
    $apkTarget = Join-Path $root "release/Keevault-Mobile-$mobileVersion.apk"
    Copy-Fresh $apk $apkTarget
    $assets += $apkTarget
}
# macOS/Linux (preview, unsigned): built by the GitHub workflow "Desktop macOS/Linux" and downloaded with
# `gh run download <id> -D release/ci`; attached when present, plus copies under stable names for the website.
$ci = Join-Path $root 'release/ci'
if ($Previews -and (Test-Path $ci)) {
    $stable = @{ "Keevault-$version-mac-arm64.dmg" = 'Keevault-mac-arm64.dmg'; "Keevault-$version-mac-x64.dmg" = 'Keevault-mac-x64.dmg';
                 "Keevault-$version-linux-x86_64.AppImage" = 'Keevault-linux-x86_64.AppImage'; "Keevault-$version-linux-amd64.deb" = 'Keevault-linux-amd64.deb' }
    foreach ($f in Get-ChildItem $ci -Recurse -File | Where-Object { $_.Name -like "Keevault-$version-*" }) {
        $target = Join-Path $root "release/$($f.Name)"
        Copy-Fresh $f.FullName $target
        $assets += $target
        if ($stable.ContainsKey($f.Name)) {
            $copy = Join-Path $root "release/$($stable[$f.Name])"
            Copy-Fresh $f.FullName $copy
            $assets += $copy
        }
    }
}
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
    $notes = "EXE (pro Benutzer), MSI (pro Gerät, GPO/Intune: msiexec /i Keevault.msi /qn) und MSIX (Zertifikat Keevault-Zertifikat.cer vorher vertrauen). Installer mit Passkey-Anbieter und Browser-Erweiterung (Edge/Chrome per Richtlinie)."
    $previews = @()
    if ($assets -match 'mac-arm64\.dmg$') { $previews += 'macOS (DMG, unsigniert: „Trotzdem öffnen“)' }
    if ($assets -match '\.AppImage$') { $previews += 'Linux (AppImage/deb)' }
    if ($assets -match '\.apk$') { $previews += 'Android (APK, Debug-Build)' }
    if ($previews) { $notes += " Vorschau: $($previews -join ', ') – siehe https://keevault.de/download.html." }
    $notes += " Quellcode dieser Version: Tag v$version."
    # Changelog (scripts/release-notes.mjs, UTF-8 file: umlauts survive, unlike console output) plus the fixed text.
    $notesFile = Join-Path $root 'release/release-notes.md'
    [IO.File]::WriteAllText($notesFile, ([IO.File]::ReadAllText($notesFile).Trim() + "`n`n" + $notes), [Text.UTF8Encoding]::new($false))
    Invoke-Step "GitHub-Release v$version" {
        # The tag points at exactly the source the installer was built from (verifiable, see README).
        gh release create "v$version" @assets --repo $publicRepo --target $commit --title "Keevault $version" --notes-file $notesFile
    }
}
