# Starts the wizard's local server against the ARM/Graph stub, without a browser (#501, test/setup-tool-501.test.js).
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'KeevaultSetup\KeevaultSetup.psd1') -Force
. (Join-Path $PSScriptRoot 'FakeAzure.ps1')
$fake = New-KsFake
Set-KeevaultSetupTransport -Transport $fake.Transport -TenantId $fake.State.Tenant -SubscriptionId $fake.State.Sub -Account 'admin@contoso.example'
Start-KeevaultSetupUi -NoBrowser
[Console]::Out.WriteLine("WRITES $($fake.State.Writes.Count)")
