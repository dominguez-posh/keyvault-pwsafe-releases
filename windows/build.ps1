#Requires -Version 7
<#
.SYNOPSIS
    Baut den Windows-Passkey-Anbieter (C#) und verpackt ihn als signiertes MSIX.

.DESCRIPTION
    - Veröffentlicht windows/PasskeyProvider als eigenständige EXE (x64).
    - Holt MakeAppx/SignTool aus dem NuGet-Paket Microsoft.Windows.SDK.BuildTools (kein Windows SDK nötig).
    - Signiert mit -PfxPath (z. B. Firmen-Code-Signing-Zertifikat) oder erzeugt ein selbstsigniertes
      Testzertifikat "CN=KeyVault PwSafe Test" im Benutzerzertifikatsspeicher.
    Ergebnis: windows/out/KvPwSafe.PasskeyProvider.msix (+ .cer des Testzertifikats).

.EXAMPLE
    ./windows/build.ps1
.EXAMPLE
    ./windows/build.ps1 -PfxPath C:\certs\codesign.pfx -PfxPassword (Read-Host -AsSecureString) -Publisher 'CN=Contoso GmbH, O=Contoso GmbH, C=DE'
#>
[CmdletBinding()]
param(
    [string] $PfxPath,
    [SecureString] $PfxPassword,
    [string] $Publisher = 'CN=KeyVault PwSafe Test',
    [string] $Version = '0.3.1.0',
    [string] $BuildToolsVersion = '10.0.28000.2705'
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$project = Join-Path $here 'PasskeyProvider'
$out = Join-Path $here 'out'
$stage = Join-Path $out 'stage'
$tools = Join-Path $out 'tools'
New-Item -ItemType Directory -Force $out, $tools | Out-Null
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }

# First dotnet with an SDK 10 or newer (the project targets net10.0; an older SDK or a runtime-only installation may
# come first on PATH, e.g. SDK 8 under Program Files).
$dotnet = @((Get-Command dotnet -ErrorAction SilentlyContinue)?.Source, (Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'), (Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\dotnet.exe')) |
    Where-Object { $_ -and (Test-Path $_) -and ((& $_ --list-sdks 2>$null) | Where-Object { [int]($_ -split '\.')[0] -ge 10 }) } | Select-Object -First 1
if (-not $dotnet) { throw '.NET SDK 10 nicht gefunden (https://dot.net).' }

Write-Host 'Veröffentliche Passkey-Anbieter …'
& $dotnet publish $project -c Release -o $stage --nologo | Out-Host
if ($LASTEXITCODE) { throw "dotnet publish fehlgeschlagen ($LASTEXITCODE)" }
Get-ChildItem $stage -Filter *.pdb | Remove-Item

Copy-Item (Join-Path $project 'Assets') (Join-Path $stage 'Assets') -Recurse
$manifest = (Get-Content (Join-Path $project 'AppxManifest.xml') -Raw).Replace('__PUBLISHER__', [System.Security.SecurityElement]::Escape($Publisher)).Replace('__VERSION__', $Version)
Set-Content (Join-Path $stage 'AppxManifest.xml') $manifest -Encoding utf8

# MakeAppx/SignTool from NuGet.
$buildTools = Join-Path $tools "buildtools-$BuildToolsVersion"
if (-not (Test-Path $buildTools)) {
    $zip = Join-Path $tools 'buildtools.zip'
    Invoke-WebRequest "https://www.nuget.org/api/v2/package/Microsoft.Windows.SDK.BuildTools/$BuildToolsVersion" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip $buildTools
    Remove-Item $zip
}
$makeappx = Get-ChildItem $buildTools -Recurse -Filter makeappx.exe | Where-Object FullName -Match '\\x64\\' | Select-Object -First 1
$signtool = Get-ChildItem $buildTools -Recurse -Filter signtool.exe | Where-Object FullName -Match '\\x64\\' | Select-Object -First 1
if (-not $makeappx -or -not $signtool) { throw 'MakeAppx/SignTool im NuGet-Paket nicht gefunden.' }

$msix = Join-Path $out 'KvPwSafe.PasskeyProvider.msix'
& $makeappx.FullName pack /d $stage /p $msix /o /nv | Out-Host
if ($LASTEXITCODE) { throw "MakeAppx fehlgeschlagen ($LASTEXITCODE)" }

if (-not $PfxPath) {
    # Self-signed test certificate (current user only), reused across builds.
    $cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $Publisher -and $_.NotAfter -gt (Get-Date) -and $_.HasPrivateKey } | Select-Object -First 1
    if (-not $cert) {
        Write-Host "Erzeuge Testzertifikat $Publisher …"
        $cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature -FriendlyName 'KeyVault PwSafe Test (MSIX)' `
            -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(2) `
            -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
    }
    Export-Certificate -Cert $cert -FilePath (Join-Path $out 'KvPwSafe-Test.cer') | Out-Null
    & $signtool.FullName sign /fd SHA256 /sha1 $cert.Thumbprint /s My $msix | Out-Host
}
else {
    $plain = [System.Net.NetworkCredential]::new('', $PfxPassword).Password
    & $signtool.FullName sign /fd SHA256 /f $PfxPath /p $plain /tr http://timestamp.digicert.com /td SHA256 $msix | Out-Host
}
if ($LASTEXITCODE) { throw "Signieren fehlgeschlagen ($LASTEXITCODE)" }
Write-Host "Fertig: $msix" -ForegroundColor Green
