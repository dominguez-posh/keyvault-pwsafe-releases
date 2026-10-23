#Requires -Version 7
#Requires -Modules Az.Accounts
<#
.SYNOPSIS
    Legt die App-Registrierung "Keevault" in Microsoft Entra ID an oder aktualisiert sie.

.DESCRIPTION
    Die Desktop-App und die Browser-Erweiterung melden sich über diese App-Registrierung an und greifen
    delegiert (im Namen des Benutzers) auf Azure Key Vault zu.

    - Öffentlicher Client (Desktop-App): Redirect-URI http://localhost
    - Single-Page-Anwendung (Erweiterung): https://<erweiterungs-id>.chromiumapp.org/
      Die ID aus extension/manifest.json wird immer eingetragen, weitere (z. B. aus dem
      Edge-Add-ons-Store) über -ExtensionId.
    - Delegierte Berechtigungen: Azure Key Vault (user_impersonation), Azure Service Management
      (user_impersonation), Microsoft Graph (openid, profile, offline_access, User.Read,
      User.ReadBasic.All, GroupMember.Read.All)

    Benötigt die Rolle Anwendungsadministrator; für -GrantAdminConsent Privilegierter
    Rollenadministrator oder Globaler Administrator. Mehrfach ausführbar.

.PARAMETER TenantId
    Tenant-ID oder Domäne, z. B. contoso.onmicrosoft.com.

.PARAMETER ExtensionId
    Zusätzliche Erweiterungs-IDs (Store-Versionen).

.PARAMETER GrantAdminConsent
    Erteilt die Administratorzustimmung für alle Benutzer (sonst stimmt jeder Benutzer beim ersten
    Anmelden selbst zu; GroupMember.Read.All für die Gruppensuche braucht immer einen Administrator).

.PARAMETER ConfigPath
    Schreibt kvpwsafe.config.json für die Desktop-App (neben die EXE oder nach
    %ProgramData%\Keevault verteilen).

.EXAMPLE
    ./infra/Setup-KvPwSafe.ps1 -TenantId contoso.onmicrosoft.com -GrantAdminConsent -ConfigPath ./kvpwsafe.config.json
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string] $TenantId,
    [string] $DisplayName = 'Keevault',
    [string[]] $ExtensionId = @(),
    [switch] $GrantAdminConsent,
    [string] $ConfigPath
)

$ErrorActionPreference = 'Stop'

function Invoke-Graph {
    param([string] $Method, [string] $Path, $Body)
    $params = @{ Method = $Method; Uri = "https://graph.microsoft.com/v1.0$Path" }
    if ($null -ne $Body) { $params.Payload = $Body | ConvertTo-Json -Depth 10 -Compress }
    $response = Invoke-AzRestMethod @params
    if ($response.StatusCode -ge 400) { throw "Graph $Method $Path fehlgeschlagen ($($response.StatusCode)): $($response.Content)" }
    if ($response.Content) { return $response.Content | ConvertFrom-Json }
}

function Get-ExtensionIdFromManifest {
    $manifestPath = Join-Path $PSScriptRoot '..' 'extension' 'manifest.json'
    $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
    if (-not $manifest.key) { throw 'extension/manifest.json enthält keinen "key" – zuerst "npm run ext:key" ausführen.' }
    $hash = [System.Security.Cryptography.SHA256]::HashData([Convert]::FromBase64String($manifest.key))
    return -join ($hash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
}

$context = Get-AzContext
if (-not $context -or ($context.Tenant.Id -ne $TenantId -and $context.Tenant.Domain -ne $TenantId)) {
    Connect-AzAccount -Tenant $TenantId | Out-Null
    $context = Get-AzContext
}
$tenantGuid = $context.Tenant.Id
Write-Host "Tenant: $tenantGuid ($($context.Account.Id))"

$extensionIds = @(Get-ExtensionIdFromManifest) + $ExtensionId | Select-Object -Unique
$spaRedirects = $extensionIds | ForEach-Object { "https://$_.chromiumapp.org/" }

# Delegated permissions, resolved by name on the resource service principals.
$resources = @(
    @{ Name = 'Azure Key Vault'; AppId = 'cfa8b339-82a2-471a-a3c9-0fc0be7a4093'; Scopes = @('user_impersonation') }
    @{ Name = 'Azure Service Management'; AppId = '797f4846-ba00-4fd7-ba43-dac1f8f63013'; Scopes = @('user_impersonation') }
    @{ Name = 'Microsoft Graph'; AppId = '00000003-0000-0000-c000-000000000000'; Scopes = @('openid', 'profile', 'offline_access', 'User.Read', 'User.ReadBasic.All', 'GroupMember.Read.All') }
)
foreach ($resource in $resources) {
    $filter = [uri]::EscapeDataString("appId eq '$($resource.AppId)'")
    $sp = (Invoke-Graph GET "/servicePrincipals?`$filter=$filter&`$select=id,appId,displayName,oauth2PermissionScopes").value | Select-Object -First 1
    if (-not $sp) {
        # Fresh tenants may not have the Key Vault service principal yet.
        Invoke-Graph POST '/servicePrincipals' @{ appId = $resource.AppId } | Out-Null
        $sp = (Invoke-Graph GET "/servicePrincipals?`$filter=$filter&`$select=id,appId,displayName,oauth2PermissionScopes").value | Select-Object -First 1
    }
    $resource.ServicePrincipal = $sp
    $resource.Access = @(foreach ($name in $resource.Scopes) {
            $scope = $sp.oauth2PermissionScopes | Where-Object value -EQ $name
            if (-not $scope) { throw "Berechtigung $name bei $($resource.Name) nicht gefunden" }
            @{ id = $scope.id; type = 'Scope' }
        })
}

$filter = [uri]::EscapeDataString("displayName eq '$DisplayName'")
$app = (Invoke-Graph GET "/applications?`$filter=$filter").value | Select-Object -First 1
$body = @{
    displayName            = $DisplayName
    signInAudience         = 'AzureADMyOrg'
    isFallbackPublicClient = $true
    publicClient           = @{ redirectUris = @('http://localhost') }
    spa                    = @{ redirectUris = @(@($app.spa.redirectUris) + $spaRedirects | Where-Object { $_ } | Select-Object -Unique) }
    requiredResourceAccess = @($resources | ForEach-Object { @{ resourceAppId = $_.AppId; resourceAccess = $_.Access } })
}
if ($app) {
    if ($PSCmdlet.ShouldProcess($DisplayName, 'App-Registrierung aktualisieren')) {
        Invoke-Graph PATCH "/applications/$($app.id)" $body | Out-Null
        Write-Host "App-Registrierung aktualisiert: $($app.appId)"
    }
}
elseif ($PSCmdlet.ShouldProcess($DisplayName, 'App-Registrierung anlegen')) {
    $app = Invoke-Graph POST '/applications' $body
    Write-Host "App-Registrierung angelegt: $($app.appId)"
}

# http://localhost: sign-in in the browser; ms-appx-web://…: Windows sign-in dialog (WAM) – needs the app ID.
if ($app -and $PSCmdlet.ShouldProcess($DisplayName, 'Redirect-URIs setzen')) {
    Invoke-Graph PATCH "/applications/$($app.id)" @{ publicClient = @{ redirectUris = @('http://localhost', "ms-appx-web://Microsoft.AAD.BrokerPlugin/$($app.appId)") } } | Out-Null
}

$filter = [uri]::EscapeDataString("appId eq '$($app.appId)'")
$appSp = (Invoke-Graph GET "/servicePrincipals?`$filter=$filter").value | Select-Object -First 1
if (-not $appSp -and $PSCmdlet.ShouldProcess($DisplayName, 'Unternehmensanwendung anlegen')) {
    $appSp = Invoke-Graph POST '/servicePrincipals' @{ appId = $app.appId }
}

if ($GrantAdminConsent -and $appSp) {
    foreach ($resource in $resources) {
        $scope = $resource.Scopes -join ' '
        $filter = [uri]::EscapeDataString("clientId eq '$($appSp.id)' and resourceId eq '$($resource.ServicePrincipal.id)'")
        $grant = (Invoke-Graph GET "/oauth2PermissionGrants?`$filter=$filter").value | Where-Object consentType -EQ 'AllPrincipals' | Select-Object -First 1
        if (-not $PSCmdlet.ShouldProcess($resource.Name, "Administratorzustimmung ($scope)")) { continue }
        if ($grant) { Invoke-Graph PATCH "/oauth2PermissionGrants/$($grant.id)" @{ scope = $scope } | Out-Null }
        else {
            Invoke-Graph POST '/oauth2PermissionGrants' @{
                clientId = $appSp.id; consentType = 'AllPrincipals'; resourceId = $resource.ServicePrincipal.id; scope = $scope
            } | Out-Null
        }
        Write-Host "Zustimmung erteilt: $($resource.Name) – $scope"
    }
}

$config = [ordered]@{ tenantId = $tenantGuid; clientId = $app.appId; containers = @() }
if ($ConfigPath) {
    $config | ConvertTo-Json -Depth 5 | Set-Content -Path $ConfigPath -Encoding utf8
    Write-Host "Desktop-Konfiguration geschrieben: $ConfigPath"
}

Write-Host ''
Write-Host 'Fertig. Werte für Desktop-App und Erweiterung:' -ForegroundColor Green
Write-Host "  Tenant-ID : $tenantGuid"
Write-Host "  Client-ID : $($app.appId)"
Write-Host ''
Write-Host 'Erweiterung per Richtlinie konfigurieren (Intune/GPO, Registry):'
foreach ($id in $extensionIds) {
    Write-Host "  HKLM\SOFTWARE\Policies\Microsoft\Edge\3rdparty\extensions\$id\policy"
    Write-Host "  HKLM\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\$id\policy"
}
Write-Host "    tenantId (REG_SZ) = $tenantGuid"
Write-Host "    clientId (REG_SZ) = $($app.appId)"
Write-Host ''
Write-Host 'Nächster Schritt: Container anlegen, z. B.'
Write-Host "  ./infra/New-KvPwSafeContainer.ps1 -Name kv-pws-team -DisplayName 'Team' -ResourceGroupName rg-kvpwsafe -Owners admin@contoso.com"
