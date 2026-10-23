#Requires -Version 7
#Requires -Modules Az.Accounts
<#
.SYNOPSIS
    Legt einen Container (Azure Key Vault mit RBAC) für Keevault an und vergibt die Rollen.

.DESCRIPTION
    Container = Key Vault mit Tag kvpwsafe=container (wird von den Apps automatisch gefunden),
    RBAC-Autorisierung, Soft Delete (90 Tage) und standardmäßig Löschschutz.

    Berechtigungen (Azure-Rollen auf dem Key Vault):
      -Readers  Key Vault Secrets User                                   (Lesen)
      -Editors  Key Vault Secrets Officer                                (Bearbeiten)
      -Owners   Key Vault Secrets Officer + Key Vault Data Access Admin  (Verwalten/Freigeben)
    Alle Mitglieder erhalten zusätzlich "Leser" (Reader), damit der Container automatisch erscheint.
    Mitglieder als UPN (alex@contoso.com), Objekt-ID oder Gruppenname mit Präfix "group:".

    Ausführung mit Rechten zum Anlegen von Ressourcen und Vergeben von Rollen (z. B. Besitzer der
    Ressourcengruppe). Mehrfach ausführbar: vorhandene Zuweisungen bleiben bestehen.

.EXAMPLE
    ./infra/New-KvPwSafeContainer.ps1 -Name kv-pws-alex -DisplayName 'Persönlich (Alex)' -ResourceGroupName rg-kvpwsafe -Owners alex@contoso.com

.EXAMPLE
    ./infra/New-KvPwSafeContainer.ps1 -Name kv-pws-ops -DisplayName 'Team Ops' -ResourceGroupName rg-kvpwsafe `
        -Owners lead@contoso.com -Editors 'group:Ops-Team' -Readers 'group:Helpdesk' -LogAnalyticsWorkspaceId $workspaceId
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$')][string] $Name,
    [string] $DisplayName,
    [Parameter(Mandatory)][string] $ResourceGroupName,
    [string] $Location = 'germanywestcentral',
    [string] $SubscriptionId,
    [string[]] $Owners = @(),
    [string[]] $Editors = @(),
    [string[]] $Readers = @(),
    [string] $LogAnalyticsWorkspaceId,
    [switch] $NoPurgeProtection
)

$ErrorActionPreference = 'Stop'
$roles = @{
    SecretsUser     = '4633458b-17de-408a-b874-0445c86b69e6'
    SecretsOfficer  = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
    DataAccessAdmin = '8b54135c-b56d-4d72-a534-26097cfdc8d8'
    Reader          = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
}

function Invoke-Rest {
    param([string] $Method, [string] $Uri, $Body, [int[]] $Ok = @())
    $params = @{ Method = $Method; Uri = $Uri }
    if ($null -ne $Body) { $params.Payload = $Body | ConvertTo-Json -Depth 10 -Compress }
    $response = Invoke-AzRestMethod @params
    if ($response.StatusCode -ge 400 -and $response.StatusCode -notin $Ok) { throw "$Method $Uri fehlgeschlagen ($($response.StatusCode)): $($response.Content)" }
    if ($response.Content) { return $response.Content | ConvertFrom-Json }
}

function Resolve-Principal([string] $Value) {
    $graph = 'https://graph.microsoft.com/v1.0'
    if ($Value -match '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$') {
        $obj = Invoke-Rest GET "$graph/directoryObjects/$Value"
        $type = switch ($obj.'@odata.type') { '#microsoft.graph.group' { 'Group' } '#microsoft.graph.servicePrincipal' { 'ServicePrincipal' } default { 'User' } }
        return @{ Id = $obj.id; Type = $type; Name = $obj.displayName }
    }
    if ($Value -like 'group:*') {
        $groupName = $Value.Substring(6).Replace("'", "''")
        $filter = [uri]::EscapeDataString("displayName eq '$groupName' and securityEnabled eq true")
        $group = (Invoke-Rest GET "$graph/groups?`$filter=$filter").value | Select-Object -First 1
        if (-not $group) { throw "Sicherheitsgruppe '$($Value.Substring(6))' nicht gefunden" }
        return @{ Id = $group.id; Type = 'Group'; Name = $group.displayName }
    }
    $user = Invoke-Rest GET "$graph/users/$([uri]::EscapeDataString($Value))"
    return @{ Id = $user.id; Type = 'User'; Name = $user.userPrincipalName }
}

if ($SubscriptionId) { Set-AzContext -Subscription $SubscriptionId | Out-Null }
$context = Get-AzContext
if (-not $context) { throw 'Nicht angemeldet – zuerst Connect-AzAccount ausführen.' }
$sub = $context.Subscription.Id
$arm = 'https://management.azure.com'
$rgId = "/subscriptions/$sub/resourceGroups/$ResourceGroupName"
$vaultId = "$rgId/providers/Microsoft.KeyVault/vaults/$Name"

if ($PSCmdlet.ShouldProcess($ResourceGroupName, 'Ressourcengruppe sicherstellen')) {
    $rg = Invoke-Rest GET "$arm$($rgId)?api-version=2021-04-01" -Ok 404
    if (-not $rg.id) { Invoke-Rest PUT "$arm$($rgId)?api-version=2021-04-01" @{ location = $Location } | Out-Null }
}

$properties = @{
    tenantId                  = $context.Tenant.Id
    sku                       = @{ family = 'A'; name = 'standard' }
    enableRbacAuthorization   = $true
    enableSoftDelete          = $true
    softDeleteRetentionInDays = 90
    publicNetworkAccess       = 'Enabled'
}
if (-not $NoPurgeProtection) { $properties.enablePurgeProtection = $true }
if ($PSCmdlet.ShouldProcess($Name, 'Key Vault anlegen/aktualisieren')) {
    $existing = Invoke-Rest GET "$arm$($vaultId)?api-version=2023-07-01" -Ok 404
    if ($existing.properties) {
        # Keep settings of an existing vault, only (re)apply the container tags.
        $tags = @{}
        if ($existing.tags) { $existing.tags.PSObject.Properties | ForEach-Object { $tags[$_.Name] = $_.Value } }
        $tags.kvpwsafe = 'container'
        $tags.'kvpwsafe-name' = $DisplayName ? $DisplayName : $Name
        Invoke-Rest PATCH "$arm$($vaultId)?api-version=2023-07-01" @{ tags = $tags } | Out-Null
    }
    else {
        Invoke-Rest PUT "$arm$($vaultId)?api-version=2023-07-01" @{
            location   = $Location
            tags       = @{ kvpwsafe = 'container'; 'kvpwsafe-name' = ($DisplayName ? $DisplayName : $Name) }
            properties = $properties
        } | Out-Null
    }
    do {
        Start-Sleep -Seconds 2
        $vault = Invoke-Rest GET "$arm$($vaultId)?api-version=2023-07-01"
    } while ($vault.properties.provisioningState -notin 'Succeeded', 'Failed')
    if (-not $vault.properties.enableRbacAuthorization) { Write-Warning 'Der Key Vault nutzt Zugriffsrichtlinien statt RBAC – Freigaben aus der App funktionieren nur mit RBAC.' }
    Write-Host "Container: $($vault.properties.vaultUri)"
}

$existingAssignments = (Invoke-Rest GET "$arm$vaultId/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&`$filter=atScope()").value
function Grant-Role($Principal, [string] $RoleId) {
    $already = $existingAssignments | Where-Object {
        $_.properties.principalId -eq $Principal.Id -and $_.properties.roleDefinitionId -like "*/$RoleId" -and $_.properties.scope -eq $vaultId
    }
    if ($already) { return }
    if (-not $PSCmdlet.ShouldProcess($Principal.Name, "Rolle $RoleId zuweisen")) { return }
    Invoke-Rest PUT "$arm$vaultId/providers/Microsoft.Authorization/roleAssignments/$([guid]::NewGuid())?api-version=2022-04-01" @{
        properties = @{
            roleDefinitionId = "/subscriptions/$sub/providers/Microsoft.Authorization/roleDefinitions/$RoleId"
            principalId      = $Principal.Id
            principalType    = $Principal.Type
        }
    } -Ok 409 | Out-Null
}

$members = @(
    $Owners | ForEach-Object { @{ Value = $_; Roles = @($roles.SecretsOfficer, $roles.DataAccessAdmin) } }
    $Editors | ForEach-Object { @{ Value = $_; Roles = @($roles.SecretsOfficer) } }
    $Readers | ForEach-Object { @{ Value = $_; Roles = @($roles.SecretsUser) } }
)
foreach ($member in $members) {
    $principal = Resolve-Principal $member.Value
    foreach ($role in $member.Roles + $roles.Reader) { Grant-Role $principal $role }
    Write-Host "Berechtigt: $($principal.Name)"
}

if ($LogAnalyticsWorkspaceId -and $PSCmdlet.ShouldProcess($Name, 'Diagnoseeinstellung (Audit-Logs)')) {
    Invoke-Rest PUT "$arm$vaultId/providers/Microsoft.Insights/diagnosticSettings/kvpwsafe-audit?api-version=2021-05-01-preview" @{
        properties = @{ workspaceId = $LogAnalyticsWorkspaceId; logs = @(@{ categoryGroup = 'audit'; enabled = $true }) }
    } | Out-Null
    Write-Host 'Audit-Logs an Log Analytics aktiviert.'
}

Write-Host ''
Write-Host "Fertig. Einladungslink: kvpwsafe://add?vault=$([uri]::EscapeDataString("https://$Name.vault.azure.net"))&name=$([uri]::EscapeDataString($DisplayName ? $DisplayName : $Name))"
Write-Host 'Hinweis: Neue Rollenzuweisungen können einige Minuten brauchen, bis sie wirken.'
