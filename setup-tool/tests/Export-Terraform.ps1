# Writes the Terraform export of two placeholder plans for `terraform validate` (#501 part c, test/setup-tool-501.test.js):
# <out>\full (every step) and <out>\data (resource group, vaults and groups exist: data sources, only roles).
param([Parameter(Mandatory)][string] $Out)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path (Split-Path $PSScriptRoot -Parent) 'KeevaultSetup\KeevaultSetup.psd1') -Force
$plan = New-KeevaultSetupPlan -Vault 'kv-team-a', 'kv-team-b' -SubscriptionId '00000000-0000-0000-0000-00000000aaaa' -TenantId '00000000-0000-0000-0000-00000000bbbb'
$plan.vaults[0].displayName = 'Team "A" ${x} %{y} \z'
foreach ($variant in 'full', 'data') {
    if ($variant -eq 'data') { $plan.steps.resourceGroup = $false; $plan.steps.vaults = $false; $plan.steps.groups = $false }
    $dir = Join-Path $Out $variant
    New-Item -ItemType Directory -Force $dir | Out-Null
    ConvertTo-KeevaultSetupTerraform $plan -Path (Join-Path $dir 'main.tf') | Out-Null
}
[Console]::Out.WriteLine('TF_WRITTEN')
