<#
.SYNOPSIS
    Keevault: legt ein eigenes Gruppenrichtlinienobjekt mit den Werten aus dem Einrichtungstool an.
    Creates a Group Policy object of its own with the values chosen in the Keevault setup tool.

.DESCRIPTION
    Erzeugt vom Keevault-Einrichtungstool (#501). Ohne -Apply ist es ein Probelauf: das Skript liest nur (vorhandene
    GPOs, Konflikte mit anderen GPOs) und zeigt, was es schreiben würde. Mit -Apply fragt PowerShell vor dem Schreiben
    nach (ConfirmImpact High); -WhatIf schreibt nie.

    - Es ändert nur das GPO mit dem Namen -Name, und nur, wenn es von diesem Skript stammt (Kommentar mit
      Kennzeichen). Ein fremdes GPO mit demselben Namen bleibt unberührt, das Skript bricht ab.
    - Setzt ein anderes GPO (Registry-Richtlinie oder Einstellung/GPP) schon den Forcelist-Eintrag von Edge oder
      Chrome (ExtensionInstallForcelist), bricht es ab: dort den Eintrag aus der Anleitung von Hand ergänzen.
    - Es setzt nur den Forcelist-Eintrag, nie ExtensionSettings: der Wert gilt für alle Erweiterungen, ein GPO würde
      eine Sperrliste der Firma ersetzen. Grenze: Intune, Chrome Browser Cloud Management und lokale Richtlinien
      sieht das Skript nicht.
    - Ein erneuter Lauf entfernt in diesem GPO nur die Werte, die das Skript selbst schreibt (nach Name bzw. Inhalt).
    - Es verknüpft das GPO nicht. Verknüpfen: Gruppenrichtlinienverwaltung oder New-GPLink -Guid <id> -Target <OU>.

    Benötigt die Gruppenrichtlinienverwaltung (RSAT, Modul GroupPolicy) und das Recht, GPOs anzulegen.

.EXAMPLE
    .\New-KeevaultGpo.ps1                  # Probelauf
    .\New-KeevaultGpo.ps1 -Apply           # anlegen, fragt vorher nach
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string] $Name = '',
    [string] $Domain = '',
    [switch] $Apply,
    # Number of the Forcelist entry in this GPO (the browser reads 1, 2, 3, ... without gaps).
    [ValidateRange(1, 999)][int] $ForcelistIndex = 1
)

$ErrorActionPreference = 'Stop'
$ConfigJson = @'
__KEEVAULT_CONFIG__
'@
$Config = $ConfigJson | ConvertFrom-Json
if (-not $Name) { $Name = $Config.gpoName }
$Marker = $Config.marker

if (-not (Get-Command New-GPO -ErrorAction SilentlyContinue)) {
    try { Import-Module GroupPolicy -ErrorAction Stop } catch { Write-Output 'Modul GroupPolicy fehlt (RSAT: Gruppenrichtlinienverwaltung).'; exit 1 }
}
$dom = @{}
if ($Domain) { $dom.Domain = $Domain }

function Get-Gpo1([string] $GpoName) {
    try { return Get-GPO -Name $GpoName @dom -ErrorAction Stop } catch { return $null }
}
function Test-GpValue($Gpo, [string] $RegKey, [string] $ValueName) {
    try {
        $p = @{}
        if ($ValueName) { $p.ValueName = $ValueName }
        return @(Get-GPRegistryValue -Guid $Gpo.Id -Key $RegKey -ErrorAction Stop @p @dom | Where-Object { $_.ValueName }).Count -gt 0
    }
    catch { return $false }
}
# The same in the GPO's preferences (GPP registry items): they write the browser key just as well.
function Test-GppValue($Gpo, [string] $RegKey, [string] $ValueName) {
    $context = 'Computer'; if ($RegKey -like 'HKCU\*') { $context = 'User' }
    try {
        $p = @{}
        if ($ValueName) { $p.ValueName = $ValueName }
        return @(Get-GPPrefRegistryValue -Guid $Gpo.Id -Context $context -Key $RegKey -ErrorAction Stop @p @dom).Count -gt 0
    }
    catch { return $false }
}

# ------------------------------------------------------------------ read only: own GPO, conflicts
$gpo = Get-Gpo1 $Name
if ($gpo -and ([string] $gpo.Description) -notlike "$Marker*") {
    Write-Output "ABBRUCH: Es gibt schon ein GPO '$Name', das nicht von diesem Skript stammt. Es bleibt unverändert; anderen Namen mit -Name wählen."
    exit 2
}
$values = @($Config.values)
$conflicts = @()
$browser = @($values | Where-Object { $_.browser })
if ($browser.Count) {
    foreach ($other in @(Get-GPO -All @dom | Where-Object { -not $gpo -or $_.Id -ne $gpo.Id })) {
        foreach ($v in $browser) {
            $vn = ''; if ($v.name -ne '*') { $vn = $v.name }
            if (Test-GpValue $other "$($v.hive)\$($v.key)" $vn) { $conflicts += "$($other.DisplayName): $($v.hive)\$($v.key) $vn" }
            if (Test-GppValue $other "$($v.hive)\$($v.key)" $vn) { $conflicts += "$($other.DisplayName) (Einstellungen/GPP): $($v.hive)\$($v.key) $vn" }
        }
    }
}

Write-Output "GPO: $Name ($(if ($gpo) { 'vorhanden, von diesem Skript – wird aktualisiert' } else { 'wird angelegt' }))"
foreach ($v in $values) {
    $vn = $v.name; if ($vn -eq '*') { $vn = [string] $ForcelistIndex }
    Write-Output ("  {0}\{1}  {2} = {3} ({4})" -f $v.hive, $v.key, $vn, $v.value, $v.type)
}
if ($browser.Count) {
    Write-Output 'Grenze: Geprüft werden nur GPOs dieser Domäne (Registry-Richtlinien und Einstellungen/GPP). Intune, Chrome Browser Cloud Management und lokale Richtlinien sieht das Skript nicht. ExtensionSettings setzt das GPO nicht, eine Sperrliste der Firma bleibt unverändert; blockiert sie Keevault, die Erweiterung dort freigeben.'
}
if ($conflicts.Count) {
    Write-Output 'ABBRUCH: Andere GPOs setzen schon die Erweiterungs-Richtlinie des Browsers. Sie bleiben unverändert; den Eintrag dort von Hand ergänzen:'
    $conflicts | Sort-Object -Unique | ForEach-Object { Write-Output "  $_" }
    exit 3
}
if (-not $Apply) {
    Write-Output 'Probelauf: nichts geändert. Zum Anlegen mit -Apply erneut starten (PowerShell fragt vorher nach).'
    exit 0
}
if (-not $PSCmdlet.ShouldProcess($Name, 'Gruppenrichtlinienobjekt für Keevault anlegen bzw. aktualisieren')) {
    Write-Output 'Nichts geändert.'
    exit 0
}

# ------------------------------------------------------------------ write: only this GPO
if (-not $gpo) { $gpo = New-GPO -Name $Name -Comment "$Marker. $($Config.comment)" @dom }
# The values of an earlier run of this script are replaced (a vault removed from the list disappears) - only those this
# script writes, by name and content: a key in this GPO (e.g. Edge's) may hold settings the admin added by hand.
foreach ($o in @($Config.own)) {
    $present = @(try { Get-GPRegistryValue -Guid $gpo.Id -Key $o.key -ErrorAction Stop @dom | Where-Object { $_.ValueName } } catch { })
    foreach ($p in $present) {
        if (@($o.names).Count -and @($o.names) -notcontains $p.ValueName) { continue }
        if ($o.pattern -and ([string] $p.Value) -notmatch $o.pattern) { continue }
        Remove-GPRegistryValue -Guid $gpo.Id -Key $o.key -ValueName $p.ValueName @dom | Out-Null
    }
}
foreach ($v in $values) {
    $vn = $v.name; if ($vn -eq '*') { $vn = [string] $ForcelistIndex }
    $data = $v.value
    if ($v.type -eq 'DWord') { $data = [int] $v.value }
    Set-GPRegistryValue -Guid $gpo.Id -Key "$($v.hive)\$($v.key)" -ValueName $vn -Type $v.type -Value $data @dom | Out-Null
}
Write-Output "Fertig: GPO '$Name' ($($gpo.Id)). Noch verknüpfen: New-GPLink -Guid $($gpo.Id) -Target '<OU>'"
exit 0
