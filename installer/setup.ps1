<#
.SYNOPSIS
    Setup of Keevault outside the app. Runs on Windows PowerShell 5.1.

.DESCRIPTION
    -Scope User    (no admin, called by the uninstaller): removes the user's passkey provider package and
                   registration plus the native messaging host. The app itself sets everything up per user.
    -Scope Machine (admin or SYSTEM, once per device – e.g. Intune platform script, or "Set up with
                   administrator rights" in the app):
                     - trusts the signing certificate of the passkey provider (LocalMachine\TrustedPeople)
                     - adds the browser extension to the Edge/Chrome ExtensionInstallForcelist policy
                       (browsers honor that on managed devices: domain-, Entra- or Intune-joined)
    The release build embeds the certificate ($EmbeddedCertificate), so the machine script works stand-alone.
    Log: %ProgramData%\Keevault\setup.log (machine) or %LOCALAPPDATA%\KeyVault PwSafe\setup.log (user).
#>
param(
    [Parameter(Mandatory)] [ValidateSet('Install', 'Uninstall')] [string] $Action,
    [ValidateSet('User', 'Machine')] [string] $Scope = 'Machine',
    [string] $CertificatePath,
    # Machine: leave the browser policy alone (the company sets ExtensionInstallForcelist itself) – MSI: KV_NO_POLICY=1
    [switch] $SkipExtensionPolicy
)

$ErrorActionPreference = 'Continue'
$EmbeddedCertificate = '__CERTIFICATE_BASE64__'
$ExtensionId = 'pbkjijhihclckeeefbepoedgdmajioip'
$UpdateUrl = 'https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/latest/download/update.xml'
$PackageName = 'KvPwSafe.PasskeyProvider'
$HostName = 'com.kvpwsafe.desktop'
$Policies = @('HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist', 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist')

$LogDir = if ($Scope -eq 'Machine') { Join-Path $env:ProgramData 'Keevault' } else { Join-Path $env:LOCALAPPDATA 'KeyVault PwSafe' }
New-Item -ItemType Directory -Force $LogDir | Out-Null
Start-Transcript -Path (Join-Path $LogDir 'setup.log') -Append | Out-Null
Write-Output "$(Get-Date -Format s) $Action $Scope"
$failed = $false

function Step([string] $name, [scriptblock] $block) {
    try {
        & $block
        Write-Output "OK     $name"
    }
    catch {
        $script:failed = $true
        Write-Output "FEHLER $name : $($_.Exception.Message)"
    }
}

function Get-Certificate {
    if ($CertificatePath -and (Test-Path $CertificatePath)) {
        return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $CertificatePath
    }
    if ($EmbeddedCertificate -and $EmbeddedCertificate -notlike '__*') {
        return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [Convert]::FromBase64String($EmbeddedCertificate))
    }
    return $null
}

function Get-ForcelistEntries([string] $key) {
    if (-not (Test-Path $key)) { return @() }
    $item = Get-Item $key
    return @($item.GetValueNames() | ForEach-Object { [pscustomobject]@{ Name = $_; Value = [string]$item.GetValue($_) } })
}

if ($Scope -eq 'Machine') {
    $cert = Get-Certificate
    if ($Action -eq 'Install') {
        if ($cert) {
            Step 'Zertifikat des Passkey-Anbieters vertrauen' {
                $store = New-Object System.Security.Cryptography.X509Certificates.X509Store 'TrustedPeople', 'LocalMachine'
                $store.Open('ReadWrite')
                $store.Add($cert)
                $store.Close()
            }
        }
        foreach ($key in $(if ($SkipExtensionPolicy) { @() } else { $Policies })) {
            Step "Erweiterung per Richtlinie ($key)" {
                if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
                $entries = Get-ForcelistEntries $key
                $existing = $entries | Where-Object { $_.Value -like "$ExtensionId*" } | Select-Object -First 1
                if ($existing) {
                    # Outdated source (e.g. old update URL): replace it in place.
                    if ($existing.Value -ne "$ExtensionId;$UpdateUrl") { Set-ItemProperty -Path $key -Name $existing.Name -Value "$ExtensionId;$UpdateUrl" }
                    return
                }
                # Values are a list named 1, 2, 3, … – take the first free number.
                $n = 1
                while ($entries | Where-Object { $_.Name -eq "$n" }) { $n++ }
                New-ItemProperty -Path $key -Name "$n" -Value "$ExtensionId;$UpdateUrl" -PropertyType String -Force | Out-Null
            }
        }
    }
    else {
        foreach ($key in $(if ($SkipExtensionPolicy) { @() } else { $Policies })) {
            Step "Richtlinie entfernen ($key)" {
                foreach ($e in (Get-ForcelistEntries $key | Where-Object { $_.Value -like "$ExtensionId*" })) { Remove-ItemProperty -Path $key -Name $e.Name }
            }
        }
        if ($cert) {
            Step 'Zertifikat entfernen' {
                Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Thumbprint -eq $cert.Thumbprint | Remove-Item
            }
        }
    }
}
elseif ($Action -eq 'Uninstall') {
    Step 'Passkey-Anbieter bei Windows abmelden' {
        $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\kvpwsafe-passkeys.exe'
        if (Test-Path $alias) { & $alias --unregister | Out-Null }
    }
    Step 'Passkey-Anbieter entfernen' {
        Get-AppxPackage -Name $PackageName | Remove-AppxPackage
    }
    Step 'Browser-Anbindung entfernen' {
        foreach ($k in @("HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName", "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName", 'HKCU:\Software\KeyVault PwSafe')) {
            if (Test-Path $k) { Remove-Item $k -Recurse }
        }
    }
}
Stop-Transcript | Out-Null
if ($failed) { exit 1 }
exit 0
