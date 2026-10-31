<#
.SYNOPSIS
    Keevault: connect vaults and set company defaults on a device – for Intune platform scripts (or any software
    deployment) when the ADMX template is not imported. Runs on Windows PowerShell 5.1.

.DESCRIPTION
    Writes HKLM\SOFTWARE\Policies\Keevault (the same values as the ADMX template, computer policy). Adjust the
    block "Einstellungen" below, then in Intune: Geräte → Skripts und Wartung → Plattformskripts → Hinzufügen,
    "Als angemeldeter Benutzer ausführen: Nein", "64-Bit-PowerShell: Ja", assign to a device group.

    Who may open a vault is decided by Azure: assign the users or an Entra ID group the role
    "Key Vault Secrets User" (read) or "Key Vault Secrets Officer" (read and write) on the Key Vault.

    Re-running replaces the vault list. -Remove deletes all Keevault policies again.
#>
param([switch] $Remove)

# ------------------------------------------------------------------ Einstellungen
# Anzeigename = Key-Vault-Adresse (optional ";<Tenant-ID>" für Tresore in einem anderen Tenant)
$Vaults = [ordered]@{
    'Team IT'      = 'https://kv-team-it.vault.azure.net'
    # 'Geschäftsführung' = 'https://kv-gf.vault.azure.net'
}
# Leer lassen ('') = nicht vorgeben
$TenantId         = ''        # z. B. 'contoso.onmicrosoft.com'
$ClientId         = ''        # nur mit eigener App-Registrierung
$UnlockPrompt     = ''        # select_account | login | none
$AutoLockMinutes  = $null     # z. B. 15
$ClipboardSeconds = $null     # z. B. 30
$RequirePin       = $null     # $true | $false
$UpdateMode       = ''        # off | auto | ask
$Language         = ''        # auto | de | en
# ab 0.7.10
$SelfUpdate       = $null     # $false = App installiert nie selbst Updates (IT verteilt sie); $true/$null = erlaubt
$DefaultVault     = ''        # z. B. 'https://kv-team-it.vault.azure.net' (Standard-Tresor für neue Einträge)
$BrowserIntegration = $null   # $true | $false – Datei-Tresore in der Browser-Erweiterung
$WindowsProvider  = $null     # $true | $false – Keevault als Passkey-Anbieter in Windows
$SignInWindows    = $null     # $true | $false – Anmeldung im Windows-Dialog (WAM) statt im Browser
$McpScope         = ''        # selected | all – Zugriff für KI-Agenten
$ExtensionIds     = ''        # z. B. 'pbkjijhihclckeeefbepoedgdmajioip,abc…' (nur bei eigener Erweiterungs-ID)
# ------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SOFTWARE\Policies\Keevault'

if ($Remove) {
    if (Test-Path $key) { Remove-Item $key -Recurse -Force }
    Write-Output 'Keevault-Richtlinien entfernt.'
    exit 0
}

New-Item -Path "$key\Vaults" -Force | Out-Null
# Replace the list completely (vaults removed above disappear on the devices).
Remove-Item -Path "$key\Vaults" -Recurse -Force
New-Item -Path "$key\Vaults" -Force | Out-Null
foreach ($name in $Vaults.Keys) {
    if ($Vaults[$name] -notmatch '^https://[a-z0-9-]+\.vault\.') { throw "Keine Key-Vault-Adresse: $($Vaults[$name])" }
    New-ItemProperty -Path "$key\Vaults" -Name $name -Value $Vaults[$name] -PropertyType String -Force | Out-Null
}

function Set-Text([string] $name, [string] $value) {
    if ($value) { New-ItemProperty -Path $key -Name $name -Value $value -PropertyType String -Force | Out-Null }
    else { Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue }
}
function Set-Number([string] $name, $value) {
    if ($null -ne $value) { New-ItemProperty -Path $key -Name $name -Value ([int] $value) -PropertyType DWord -Force | Out-Null }
    else { Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue }
}

Set-Text 'TenantId' $TenantId
Set-Text 'ClientId' $ClientId
Set-Text 'UnlockPrompt' $UnlockPrompt
Set-Text 'UpdateMode' $UpdateMode
Set-Text 'Language' $Language
Set-Number 'AutoLockMinutes' $AutoLockMinutes
Set-Number 'ClipboardSeconds' $ClipboardSeconds
function Set-Bool([string] $name, $value) { Set-Number $name $(if ($null -eq $value) { $null } elseif ($value) { 1 } else { 0 }) }
Set-Bool 'RequirePin' $RequirePin
Set-Bool 'SelfUpdate' $SelfUpdate
Set-Bool 'BrowserIntegration' $BrowserIntegration
Set-Bool 'WindowsProvider' $WindowsProvider
Set-Bool 'SignInWindows' $SignInWindows
Set-Text 'DefaultVault' $DefaultVault
Set-Text 'McpScope' $McpScope
Set-Text 'ExtensionIds' $ExtensionIds

Write-Output "Keevault: $($Vaults.Count) Tresor(e) vorgegeben. Wirksam beim nächsten Start von Keevault."
exit 0
