<#
.SYNOPSIS
    Startet das Keevault-Einrichtungstool (#501): grafischer Assistent im Keevault-Design, lokal, ohne Installation.

.DESCRIPTION
    Öffnet ein Edge-Fenster mit dem Assistenten (Auswahl -> Checkliste -> Probelauf -> Ausführen -> Doku).
    Ohne Fenster nutzbar über das Modul: Import-Module .\KeevaultSetup, dann Connect-KeevaultSetup,
    New-KeevaultSetupPlan, Invoke-KeevaultSetup -WhatIf, Invoke-KeevaultSetup -ConfirmPlanHash, New-KeevaultSetupReport.

    Voraussetzung: Az.Accounts (Install-Module Az.Accounts -Scope CurrentUser).

.EXAMPLE
    .\Keevault-Setup.ps1
#>
[CmdletBinding()]
param([switch] $NoBrowser, [int] $Port = 0)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path (Join-Path $PSScriptRoot 'KeevaultSetup') 'KeevaultSetup.psd1') -Force
Start-KeevaultSetupUi -NoBrowser:$NoBrowser -Port $Port
