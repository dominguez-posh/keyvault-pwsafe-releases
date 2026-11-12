# Keevault-Einrichtungstool (#501), engine. Plan -> steps -> requests against ARM and Microsoft Graph.
# Only Az.Accounts (Invoke-AzRestMethod) is used, like infra/. All requests go through one transport, so tests and the
# dry-run stub replace a single function. Structure: Private/*.ps1 by subject, this file only loads them.
Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'

foreach ($file in @('I18n', 'I18nCheck', 'Rest', 'Plan', 'Rights', 'Steps', 'Report', 'Render', 'Terraform', 'DevicePolicy', 'DeviceExport', 'Drift', 'Compliance', 'Crypto', 'Update', 'Server')) {
    . (Join-Path (Join-Path $PSScriptRoot 'Private') "$file.ps1")
}
