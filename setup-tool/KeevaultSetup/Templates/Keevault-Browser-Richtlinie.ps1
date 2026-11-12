<#
.SYNOPSIS
    Keevault: Browser-Erweiterung in Edge/Chrome per Richtlinie erzwingen (Intune-Korrekturskript oder Plattformskript).
    Forces the Keevault browser extension in Edge/Chrome by policy (Intune remediation or platform script).

.DESCRIPTION
    Erzeugt vom Keevault-Einrichtungstool (#501), feste Werte, keine Parameter nötig. Läuft als SYSTEM, 64 Bit,
    Windows PowerShell 5.1.
    - Ohne Parameter (Korrektur): setzt je gewähltem Browser den Forcelist-Eintrag der Erweiterung und den Wert
      ExtensionSettings, und merkt in HKLM\SOFTWARE\Keevault (NoExtensionPolicy = 1), dass die Firma die Richtlinie
      selbst setzt (die App und Keevault-Geraet-Einrichten.ps1 legen dann keine eigene an).
    - -Detect bzw. die Kopie Keevault-Browser-Erkennung.ps1 (Erkennung): schreibt nichts; Exit 1, wenn eine Korrektur
      nötig ist, sonst 0.
    - -Remove: entfernt nur die eigenen Werte wieder.
    Fremde Einträge (ein anderer Forcelist-Eintrag mit derselben Erweiterungs-ID, ein fremdes ExtensionSettings oder
    ExtensionSettings als Unterschlüssel) werden nie geändert: der Browser wird dann übersprungen und gemeldet.
#>
param(
    [switch] $Detect,
    [switch] $Remove,
    # Tests only: other roots instead of HKLM:\SOFTWARE\Policies and HKLM:\SOFTWARE\Keevault.
    [Parameter(DontShow)][string] $PolicyRoot = 'HKLM:\SOFTWARE\Policies',
    [Parameter(DontShow)][string] $MarkPath = 'HKLM:\SOFTWARE\Keevault'
)

$ErrorActionPreference = 'Stop'
# The detection copy (Keevault-Browser-Erkennung.ps1) has 'yes' here: Intune passes no parameters.
if ('__KEEVAULT_DETECT__' -eq 'yes') { $Detect = [switch] $true }
$ConfigJson = @'
__KEEVAULT_CONFIG__
'@
$Config = $ConfigJson | ConvertFrom-Json
$needed = $false
$skipped = @()

function Get-Entries([string] $Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $item = Get-Item -LiteralPath $Path
    return @($item.GetValueNames() | ForEach-Object { [pscustomobject]@{ Name = $_; Value = [string] $item.GetValue($_) } })
}
function Test-Own([string] $Value, $List) { return @($List | Where-Object { $_ -eq $Value }).Count -gt 0 }

foreach ($b in @($Config.browsers)) {
    $base = Join-Path $PolicyRoot $b.path
    $listPath = Join-Path $base 'ExtensionInstallForcelist'
    $entries = @(Get-Entries $listPath)
    $mine = @($entries | Where-Object { $_.Value -eq $b.id -or $_.Value -like "$($b.id);*" })
    $foreign = @($mine | Where-Object { -not (Test-Own $_.Value $Config.ownForcelist) -and $_.Value -notlike "$($b.id);$($Config.ownSource)*" })
    $settingsKey = Test-Path -LiteralPath (Join-Path $base 'ExtensionSettings')
    $settings = $null
    if (Test-Path -LiteralPath $base) { $settings = (Get-ItemProperty -LiteralPath $base -Name 'ExtensionSettings' -ErrorAction SilentlyContinue).ExtensionSettings }
    $foreignSettings = $settingsKey -or ($null -ne $settings -and -not (Test-Own ([string] $settings) $Config.ownSettings))
    if ($foreign.Count -or $foreignSettings) {
        $skipped += $b.name
        Write-Output "$($b.name): Richtlinie der Firma vorhanden (fremder Eintrag) - unverändert."
        continue
    }
    if ($Remove) {
        if (-not $Detect) {
            foreach ($e in $mine) { Remove-ItemProperty -LiteralPath $listPath -Name $e.Name }
            if ($null -ne $settings) { Remove-ItemProperty -LiteralPath $base -Name 'ExtensionSettings' }
        }
        Write-Output "$($b.name): eigene Werte entfernt."
        continue
    }
    $ok = ($mine.Count -eq 1 -and $mine[0].Value -eq $b.forcelist -and [string] $settings -eq $b.settings)
    if ($ok) { Write-Output "$($b.name): in Ordnung."; continue }
    $needed = $true
    if ($Detect) { Write-Output "$($b.name): Korrektur nötig."; continue }
    if (-not (Test-Path -LiteralPath $listPath)) { New-Item -Path $listPath -Force | Out-Null }
    if ($mine.Count) {
        # Our older entry is replaced in place; further ones of ours are removed.
        Set-ItemProperty -LiteralPath $listPath -Name $mine[0].Name -Value $b.forcelist
        foreach ($e in ($mine | Select-Object -Skip 1)) { Remove-ItemProperty -LiteralPath $listPath -Name $e.Name }
    }
    else {
        # The browser reads the list as 1, 2, 3, ... - the first free number.
        $n = 1
        while (@($entries | Where-Object { $_.Name -eq "$n" }).Count) { $n++ }
        New-ItemProperty -LiteralPath $listPath -Name "$n" -Value $b.forcelist -PropertyType String -Force | Out-Null
    }
    New-ItemProperty -LiteralPath $base -Name 'ExtensionSettings' -Value $b.settings -PropertyType String -Force | Out-Null
    Write-Output "$($b.name): gesetzt ($($b.forcelist))."
}

$mark = (Get-ItemProperty -LiteralPath $MarkPath -Name 'NoExtensionPolicy' -ErrorAction SilentlyContinue).NoExtensionPolicy
if ($Remove -and -not $Detect -and $null -ne $mark) { Remove-ItemProperty -LiteralPath $MarkPath -Name 'NoExtensionPolicy' }
elseif (-not $Remove -and $mark -ne 1) {
    $needed = $true
    if (-not $Detect) {
        if (-not (Test-Path -LiteralPath $MarkPath)) { New-Item -Path $MarkPath -Force | Out-Null }
        New-ItemProperty -LiteralPath $MarkPath -Name 'NoExtensionPolicy' -Value 1 -PropertyType DWord -Force | Out-Null
    }
}
if ($Detect -and $needed) { exit 1 }
exit 0
