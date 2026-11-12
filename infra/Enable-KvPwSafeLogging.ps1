#Requires -Version 7
#Requires -Modules Az.Accounts
<#
.SYNOPSIS
    Richtet die Protokollierung eines Keevault-Tresors (Key Vault) in Log Analytics ein – dieselben Schritte wie
    „Tresor-Einstellungen → Protokollierung“ in der App, für die IT ohne App.

.DESCRIPTION
    Schritte (jeweils nur, wenn nötig):
      1. Ressourcenanbieter Microsoft.OperationalInsights / Microsoft.Insights registrieren
      2. Ressourcengruppe und Log-Analytics-Workspace anlegen (oder einen vorhandenen nutzen; Aufbewahrung wird nie verkürzt)
      3. Diagnoseeinstellung „kvpwsafe-audit“ am Key Vault: AuditEvent + AllMetrics an den Workspace
      4. Aktionsgruppe „keevault-alerts“ mit E-Mail
      5. Warnregel „ungewöhnlich viele Abrufe pro Person“ (KQL, feste Schwelle oder Vielfaches der Basislinie)
      6. Optional: Warnregel für abgelehnte Zugriffe und Löschungen
      7. Warnung im Aktivitätsprotokoll, wenn jemand die Diagnoseeinstellung ändert oder löscht
      8. Optional: Azure Policy (AuditIfNotExists oder DeployIfNotExists) gegen fehlende/abgeschaltete Protokollierung
      9. Optional: unveränderlicher Export in ein Storage-Konto (WORM, versionsbasierte Unveränderlichkeit)

    Zuerst zeigt das Skript den Probelauf (was angelegt oder geändert würde) und fragt dann nach. -WhatIf zeigt nur den
    Probelauf, -Force schreibt ohne Rückfrage. Fehlende Rechte nennen Schritt und Rolle.

    Empfehlung: ein gemeinsamer Workspace pro Tenant bzw. Kunde in einer eigenen Ressourcengruppe, auf die Tresor-Admins
    keine Schreibrechte haben. Grenzen: Das Protokoll zeigt den Zugriff auf Key Vault, nicht was jemand danach mit dem
    Wert macht; Daten kommen mit einigen Minuten Verzug an; Zugriffe vor der Einrichtung fehlen.

    Rechte: Monitoring Contributor (Diagnoseeinstellung, Warnregeln, Aktionsgruppe), Log Analytics Contributor (Workspace),
    Contributor auf dem Abonnement (neue Ressourcengruppe, Anbieter registrieren), für -Policy zusätzlich Resource Policy
    Contributor und User Access Administrator (Rollen für die verwaltete Identität der Zuweisung).

.EXAMPLE
    ./infra/Enable-KvPwSafeLogging.ps1 -VaultName kv-pws-team -VaultResourceGroup rg-kvpwsafe -AlertEmail it-security@contoso.com

.EXAMPLE
    ./infra/Enable-KvPwSafeLogging.ps1 -VaultName kv-pws-team -VaultResourceGroup rg-kvpwsafe -AlertEmail it-security@contoso.com `
        -WorkspaceResourceId $workspaceId -ReadsThreshold 50 -DeniedAlert -Policy DeployIfNotExists

.EXAMPLE
    ./infra/Enable-KvPwSafeLogging.ps1 -VaultName kv-pws-team -VaultResourceGroup rg-kvpwsafe -AlertEmail it-security@contoso.com `
        -ImmutableStorageAccount stkeevaultaudit -ImmutableDays 365 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$')][string] $VaultName,
    [Parameter(Mandatory)][ValidatePattern('^[-\w.()]{0,89}[-\w()]$')][string] $VaultResourceGroup,
    [Parameter(Mandatory)][ValidatePattern('^[^\s@<>",;]+@[^\s@<>",;]+\.[a-zA-Z]{2,}$')][string] $AlertEmail,
    [string] $SubscriptionId,
    [string] $WorkspaceResourceId,
    [ValidatePattern('^[-\w.()]{1,90}$')][string] $ResourceGroupName = 'rg-keevault-logs',
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9-]{2,61}[a-zA-Z0-9]$')][string] $WorkspaceName = 'law-keevault',
    [ValidatePattern('^[a-z0-9]{2,40}$')][string] $Location,
    [ValidateRange(30, 730)][int] $RetentionDays = 90,
    [ValidateRange(1, 100000)][int] $ReadsThreshold,
    [ValidateRange(2, 50)][int] $BaselineFactor = 3,
    [ValidateRange(1, 100000)][int] $BaselineMinimum = 20,
    [switch] $DeniedAlert,
    [ValidateSet('None', 'AuditIfNotExists', 'DeployIfNotExists')][string] $Policy = 'None',
    [ValidatePattern('^/(subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/resourceGroups/[-\w.()]{1,90})?|providers/Microsoft\.Management/managementGroups/[-\w.()]{1,90})$')][string] $PolicyScope,
    [ValidatePattern('^[a-z0-9]{3,24}$')][string] $ImmutableStorageAccount,
    [ValidateRange(1, 3650)][int] $ImmutableDays = 365,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$api = @{
    groups = '2021-04-01'; providers = '2021-04-01'; permissions = '2022-04-01'; workspaces = '2022-10-01'
    diagnostics = '2021-05-01-preview'; actionGroups = '2023-01-01'; queryRules = '2023-12-01'; activityAlerts = '2020-10-01'
    policyDefinitions = '2023-04-01'; policyAssignments = '2023-04-01'; roleAssignments = '2022-04-01'; storage = '2023-01-01'
}
$roles = @{
    'Microsoft.Resources/subscriptions/resourceGroups/write' = 'Contributor'
    'Microsoft.OperationalInsights/workspaces/write'         = 'Log Analytics Contributor'
    'Microsoft.Insights/diagnosticSettings/write'            = 'Monitoring Contributor'
    'Microsoft.Insights/actionGroups/write'                  = 'Monitoring Contributor'
    'Microsoft.Insights/scheduledQueryRules/write'           = 'Monitoring Contributor'
    'Microsoft.Insights/activityLogAlerts/write'             = 'Monitoring Contributor'
    'Microsoft.Authorization/policyAssignments/write'        = 'Resource Policy Contributor'
    'Microsoft.Authorization/policyDefinitions/write'        = 'Resource Policy Contributor'
    'Microsoft.Storage/storageAccounts/write'                = 'Storage Account Contributor'
}

# ---------------------------------------------------------------- KQL, the same fixed queries as the app
# (extension/core/loganalytics.js; test/loganalytics-486.test.js checks that both are equal)
$KqlReadsFixed = @'
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.KEYVAULT" and Category == "AuditEvent"
| where _ResourceId =~ "{{VAULT}}"
| where OperationName == "SecretGet" and toint(httpStatusCode_d) < 300
| extend Person = coalesce(tostring(column_ifexists("identity_claim_upn_s", "")), tostring(column_ifexists("identity_claim_http_schemas_xmlsoap_org_ws_2005_05_identity_claims_upn_s", "")), tostring(column_ifexists("identity_claim_oid_g", "")), tostring(column_ifexists("identity_claim_appid_g", "")), CallerIPAddress)
| extend Entry = tostring(split(id_s, "/")[4])
| where TimeGenerated > ago(1h)
| summarize Reads = dcount(Entry) by Person
| where Reads > {{THRESHOLD}}
'@
$KqlReadsBaseline = @'
let reads = AzureDiagnostics
| where ResourceProvider == "MICROSOFT.KEYVAULT" and Category == "AuditEvent"
| where _ResourceId =~ "{{VAULT}}"
| where OperationName == "SecretGet" and toint(httpStatusCode_d) < 300
| extend Person = coalesce(tostring(column_ifexists("identity_claim_upn_s", "")), tostring(column_ifexists("identity_claim_http_schemas_xmlsoap_org_ws_2005_05_identity_claims_upn_s", "")), tostring(column_ifexists("identity_claim_oid_g", "")), tostring(column_ifexists("identity_claim_appid_g", "")), CallerIPAddress)
| extend Entry = tostring(split(id_s, "/")[4]);
let recent = reads | where TimeGenerated > ago(1h) | summarize Reads = dcount(Entry) by Person;
let usual = reads | where TimeGenerated <= ago(1h) and TimeGenerated > ago(2d)
    | summarize Entries = dcount(Entry) by Person, bin(TimeGenerated, 1h) | summarize Usual = avg(Entries) by Person;
recent
| join kind=leftouter usual on Person
| extend Usual = coalesce(Usual, 0.0)
| where Reads > max_of({{MINIMUM}}, Usual * {{FACTOR}})
| project Person, Reads, Usual
'@
$KqlDenied = @'
AzureDiagnostics
| where ResourceProvider == "MICROSOFT.KEYVAULT" and Category == "AuditEvent"
| where _ResourceId =~ "{{VAULT}}"
| where TimeGenerated > ago(15m)
| where toint(httpStatusCode_d) == 403 or OperationName in ("SecretDelete", "SecretPurge", "VaultDelete")
| extend Person = coalesce(tostring(column_ifexists("identity_claim_upn_s", "")), tostring(column_ifexists("identity_claim_http_schemas_xmlsoap_org_ws_2005_05_identity_claims_upn_s", "")), tostring(column_ifexists("identity_claim_oid_g", "")), tostring(column_ifexists("identity_claim_appid_g", "")), CallerIPAddress)
| project TimeGenerated, Person, OperationName, ResultSignature, CallerIPAddress
'@

# ---------------------------------------------------------------- helpers

function Invoke-Rest {
    param([string] $Method, [string] $Path, [string] $ApiVersion, $Body, [string] $Step)
    $sep = $Path.Contains('?') ? '&' : '?'
    $params = @{ Method = $Method; Uri = "https://management.azure.com$Path$($sep)api-version=$ApiVersion" }
    if ($null -ne $Body) { $params.Payload = $Body | ConvertTo-Json -Depth 30 -Compress }
    $response = Invoke-AzRestMethod @params
    if ($response.StatusCode -eq 404 -and $Method -eq 'GET') { return $null }
    if ($response.StatusCode -eq 403) {
        if ($Method -eq 'GET') { return [pscustomobject]@{ forbidden = $true } }
        throw "Schritt '$Step': Dafür fehlt dir das Recht in Azure. Rolle prüfen (siehe Probelauf) und das Skript erneut ausführen; bis hierher Angelegtes bleibt."
    }
    if ($response.StatusCode -ge 400) {
        $code = try { ($response.Content | ConvertFrom-Json).error.code } catch { '' }
        throw "Schritt '$Step' fehlgeschlagen ($($response.StatusCode) $code)."
    }
    if ($response.Content) { return $response.Content | ConvertFrom-Json -Depth 30 }
}

$permCache = @{}
function Test-Right([string] $Scope, [string] $Action) {
    if (-not $permCache.ContainsKey($Scope)) {
        $list = Invoke-Rest GET "$Scope/providers/Microsoft.Authorization/permissions" $api.permissions
        $permCache[$Scope] = if ($list -and -not $list.forbidden) { @($list.value) } else { $null }
    }
    $perms = $permCache[$Scope]
    if ($null -eq $perms) { return $true } # unknown: the write itself decides
    $match = { param($patterns) @($patterns) | Where-Object { $_ -and $Action -like $_ } }
    foreach ($p in $perms) {
        if ((& $match $p.actions) -and -not (& $match $p.notActions)) { return $true }
    }
    return $false
}

$steps = [System.Collections.Generic.List[object]]::new()
function Add-Step([string] $Id, [string] $Kind, [string] $Text, [hashtable] $Request, [string] $Scope, [string] $Action, [string] $Wait) {
    $missing = $null
    if ($Scope -and $Action -and -not (Test-Right $Scope $Action)) {
        $missing = "Dir fehlt das Recht '$Action' (z. B. Rolle '$($roles[$Action] ?? 'Contributor')')."
    }
    $steps.Add([pscustomobject]@{ Id = $Id; Kind = $Kind; Text = $Text; Request = $Request; Missing = $missing; Wait = $Wait })
}

# ---------------------------------------------------------------- dry run

# -WhatIf:$false: the context switch only selects where to read; without it -WhatIf would leave the old subscription.
if ($SubscriptionId) { Set-AzContext -Subscription $SubscriptionId -WhatIf:$false | Out-Null }
$context = Get-AzContext
if (-not $context) { throw 'Nicht angemeldet – zuerst Connect-AzAccount ausführen.' }
$vaultSub = $context.Subscription.Id
$vaultId = "/subscriptions/$vaultSub/resourceGroups/$VaultResourceGroup/providers/Microsoft.KeyVault/vaults/$VaultName"
$vault = Invoke-Rest GET $vaultId '2023-07-01'
if (-not $vault -or $vault.forbidden) { throw "Key Vault '$VaultName' in '$VaultResourceGroup' nicht gefunden oder nicht lesbar (Rolle 'Reader' fehlt)." }
$vaultId = $vault.id
$vaultKql = $vaultId.ToLowerInvariant()

if ($WorkspaceResourceId) {
    if ($WorkspaceResourceId -notmatch '^/subscriptions/[0-9a-f-]{36}/resourceGroups/[^/]+/providers/Microsoft\.OperationalInsights/workspaces/[^/]+$') { throw 'WorkspaceResourceId ist keine Workspace-Ressourcen-ID.' }
    $ws = Invoke-Rest GET $WorkspaceResourceId $api.workspaces
    if (-not $ws -or $ws.forbidden) { throw 'Den Workspace gibt es nicht oder du darfst ihn nicht lesen (Rolle „Log Analytics Reader“ fehlt).' }
    $workspace = @{ Id = $ws.id; Name = $ws.name; Location = $ws.location; Retention = [int]$ws.properties.retentionInDays; Existing = $true }
}
else {
    $wsId = "/subscriptions/$vaultSub/resourceGroups/$ResourceGroupName/providers/Microsoft.OperationalInsights/workspaces/$WorkspaceName"
    $ws = Invoke-Rest GET $wsId $api.workspaces
    $location = $Location ? $Location : $vault.location
    $workspace = ($ws -and -not $ws.forbidden) `
        ? @{ Id = $ws.id; Name = $WorkspaceName; Location = $ws.location; Retention = [int]$ws.properties.retentionInDays; Existing = $true } `
        : @{ Id = $wsId; Name = $WorkspaceName; Location = $location; Retention = 0; Existing = $false }
}
$wsSub = $workspace.Id.Split('/')[2]
$wsGroup = $workspace.Id.Split('/')[4]
$groupPath = "/subscriptions/$wsSub/resourceGroups/$wsGroup"

$providers = @(@($wsSub, 'Microsoft.OperationalInsights'), @($wsSub, 'Microsoft.Insights'))
if ($vaultSub -ne $wsSub) { $providers += , @($vaultSub, 'Microsoft.Insights') }
if ($ImmutableStorageAccount) { $providers += , @($vaultSub, 'Microsoft.Storage') }
foreach ($p in $providers) {
    $reg = Invoke-Rest GET "/subscriptions/$($p[0])/providers/$($p[1])" $api.providers
    if ($reg -and $reg.registrationState -and $reg.registrationState -ne 'Registered') {
        Add-Step "register-$($p[1])" 'register' "Ressourcenanbieter '$($p[1])' registrieren" @{ Method = 'POST'; Path = "/subscriptions/$($p[0])/providers/$($p[1])/register"; ApiVersion = $api.providers } "/subscriptions/$($p[0])" "$($p[1])/register/action" 'provider'
    }
}

$groupExists = $true
if (-not $workspace.Existing) {
    $rg = Invoke-Rest GET $groupPath $api.groups
    $groupExists = [bool]$rg
    if (-not $groupExists) {
        Add-Step 'group' 'create' "Ressourcengruppe '$wsGroup' anlegen ($($workspace.Location))" @{ Method = 'PUT'; Path = $groupPath; ApiVersion = $api.groups; Body = @{ location = $workspace.Location } } "/subscriptions/$wsSub" 'Microsoft.Resources/subscriptions/resourceGroups/write'
    }
}
$rightsScope = $groupExists ? $groupPath : "/subscriptions/$wsSub"
if (-not $workspace.Existing) {
    Add-Step 'workspace' 'create' "Log-Analytics-Workspace '$($workspace.Name)' anlegen, Aufbewahrung $RetentionDays Tage" @{ Method = 'PUT'; Path = $workspace.Id; ApiVersion = $api.workspaces
        Body = @{ location = $workspace.Location; properties = @{ sku = @{ name = 'PerGB2018' }; retentionInDays = $RetentionDays } } } $rightsScope 'Microsoft.OperationalInsights/workspaces/write' 'workspace'
}
elseif ($workspace.Retention -lt $RetentionDays) {
    Add-Step 'workspace' 'update' "Aufbewahrung im Workspace '$($workspace.Name)' von $($workspace.Retention) auf $RetentionDays Tage verlängern" @{ Method = 'PATCH'; Path = $workspace.Id; ApiVersion = $api.workspaces
        Body = @{ properties = @{ retentionInDays = $RetentionDays } } } $rightsScope 'Microsoft.OperationalInsights/workspaces/write'
}
else {
    Add-Step 'workspace' 'keep' "Workspace '$($workspace.Name)' bleibt, Aufbewahrung $($workspace.Retention) Tage (wird nie verkürzt)" $null
}

# Optional immutable export: storage account with version-level immutability (WORM). The policy stays "Unlocked":
# locking it is irreversible and is done deliberately in the portal (see the knowledge base article).
$storageId = $null
if ($ImmutableStorageAccount) {
    $storageGroup = ($wsSub -eq $vaultSub) ? $wsGroup : $VaultResourceGroup
    $storageId = "/subscriptions/$vaultSub/resourceGroups/$storageGroup/providers/Microsoft.Storage/storageAccounts/$ImmutableStorageAccount"
    $st = Invoke-Rest GET $storageId $api.storage
    if (-not $st) {
        Add-Step 'storage' 'create' "Storage-Konto '$ImmutableStorageAccount' mit unveränderlicher Aufbewahrung ($ImmutableDays Tage, noch nicht gesperrt)" @{ Method = 'PUT'; Path = $storageId; ApiVersion = $api.storage
            Body = @{ location = $vault.location; kind = 'StorageV2'; sku = @{ name = 'Standard_LRS' }
                properties = @{ minimumTlsVersion = 'TLS1_2'; allowBlobPublicAccess = $false; supportsHttpsTrafficOnly = $true
                    immutableStorageWithVersioning = @{ enabled = $true; immutabilityPolicy = @{ immutabilityPeriodSinceCreationInDays = $ImmutableDays; state = 'Unlocked'; allowProtectedAppendWrites = $true } } } } } "/subscriptions/$vaultSub/resourceGroups/$storageGroup" 'Microsoft.Storage/storageAccounts/write'
    }
    elseif (-not $st.forbidden -and -not $st.properties.immutableStorageWithVersioning.enabled) {
        Write-Warning "Das Storage-Konto '$ImmutableStorageAccount' gibt es schon ohne versionsbasierte Unveränderlichkeit – es wird trotzdem als Ziel eingetragen, ist aber kein WORM-Export."
    }
}

$diagList = Invoke-Rest GET "$vaultId/providers/Microsoft.Insights/diagnosticSettings" $api.diagnostics
$settings = @($diagList.value | Where-Object { $_ })
$current = ($settings | Where-Object { "$($_.properties.workspaceId)".ToLowerInvariant() -eq $workspace.Id.ToLowerInvariant() } | Select-Object -First 1) ??
    ($settings | Where-Object { $_.name -eq 'kvpwsafe-audit' } | Select-Object -First 1)
$diagName = $current ? $current.name : 'kvpwsafe-audit'
# Our setting sends to another workspace: switching it means that workspace gets nothing any more (said plainly).
$diagFrom = ($current -and $current.properties.workspaceId -and "$($current.properties.workspaceId)".ToLowerInvariant() -ne $workspace.Id.ToLowerInvariant()) ? "$($current.properties.workspaceId)".Split('/')[-1] : $null
$diagProps = [ordered]@{}
foreach ($k in 'storageAccountId', 'eventHubAuthorizationRuleId', 'eventHubName', 'marketplacePartnerId') { if ($current.properties.$k) { $diagProps[$k] = $current.properties.$k } }
if ($storageId) { $diagProps.storageAccountId = $storageId }
$diagProps.workspaceId = $workspace.Id
$diagProps.logs = @(@($current.properties.logs | Where-Object { $_ -and $_.category -ne 'AuditEvent' -and -not $_.categoryGroup }) + @{ category = 'AuditEvent'; enabled = $true })
$diagProps.metrics = @(@($current.properties.metrics | Where-Object { $_ -and $_.category -ne 'AllMetrics' }) + @{ category = 'AllMetrics'; enabled = $true })
$diagText = $diagFrom ? "Diagnoseeinstellung '$diagName' am Key Vault umstellen: bisher Workspace '$diagFrom' → neu '$($workspace.Name)' ('$diagFrom' erhält keine Daten mehr)" : "Diagnoseeinstellung '$diagName' am Key Vault: AuditEvent und AllMetrics an den Workspace"
Add-Step 'diagnostics' ($current ? 'update' : 'create') "$diagText$($storageId ? ' und das Storage-Konto' : '')" @{ Method = 'PUT'
    Path = "$vaultId/providers/Microsoft.Insights/diagnosticSettings/$diagName"; ApiVersion = $api.diagnostics; Body = @{ properties = $diagProps } } $vaultId 'Microsoft.Insights/diagnosticSettings/write'

$agId = "$groupPath/providers/Microsoft.Insights/actionGroups/keevault-alerts"
$ag = ($workspace.Existing -or $groupExists) ? (Invoke-Rest GET $agId $api.actionGroups) : $null
$receivers = @($ag.properties.emailReceivers | Where-Object { $_ })
$hasMail = [bool]($receivers | Where-Object { $_.emailAddress -eq $AlertEmail })
if ($hasMail -and $ag.properties.enabled -ne $false) {
    Add-Step 'actiongroup' 'keep' "Aktionsgruppe 'keevault-alerts' schickt schon an $AlertEmail" $null
}
else {
    $mail = $hasMail ? $receivers : @($receivers + @{ name = "mail-$($receivers.Count + 1)"; emailAddress = $AlertEmail; useCommonAlertSchema = $true })
    # Existing receivers of every kind (SMS, webhook, Logic App, ...) stay, as in the app: merge into the old properties.
    $agProps = [ordered]@{}
    if ($ag -and -not $ag.forbidden -and $ag.properties) { foreach ($p in $ag.properties.PSObject.Properties) { $agProps[$p.Name] = $p.Value } }
    $agProps.groupShortName = 'Keevault'; $agProps.enabled = $true; $agProps.emailReceivers = $mail
    Add-Step 'actiongroup' ($ag -and -not $ag.forbidden ? 'update' : 'create') "Aktionsgruppe 'keevault-alerts': E-Mail an $AlertEmail" @{ Method = 'PUT'; Path = $agId; ApiVersion = $api.actionGroups
        Body = @{ location = 'Global'; properties = $agProps } } $rightsScope 'Microsoft.Insights/actionGroups/write'
}

function Add-Rule([string] $Id, [string] $Name, [string] $Text, [string] $Description, [string] $Query, [string] $Window, [string] $Override, [bool] $ByPerson) {
    $path = "$groupPath/providers/Microsoft.Insights/scheduledQueryRules/$Name"
    $got = ($workspace.Existing -or $groupExists) ? (Invoke-Rest GET $path $api.queryRules) : $null
    $criterion = [ordered]@{ query = $Query; timeAggregation = 'Count'; operator = 'GreaterThan'; threshold = 0 }
    if ($ByPerson) { $criterion.dimensions = @(@{ name = 'Person'; operator = 'Include'; values = @('*') }) }
    $criterion.failingPeriods = @{ numberOfEvaluationPeriods = 1; minFailingPeriodsToAlert = 1 }
    $props = [ordered]@{ displayName = $Name; description = $Description; severity = 2; enabled = $true; scopes = @($workspace.Id)
        evaluationFrequency = 'PT15M'; windowSize = $Window }
    if ($Override) { $props.overrideQueryTimeRange = $Override }
    $props.criteria = @{ allOf = @($criterion) }
    $props.autoMitigate = $false; $props.muteActionsDuration = 'PT1H'; $props.actions = @{ actionGroups = @($agId) }
    Add-Step $Id ($got -and -not $got.forbidden ? 'update' : 'create') $Text @{ Method = 'PUT'; Path = $path; ApiVersion = $api.queryRules
        Body = @{ location = $workspace.Location; kind = 'LogAlert'; properties = $props } } $rightsScope 'Microsoft.Insights/scheduledQueryRules/write'
}
if ($PSBoundParameters.ContainsKey('ReadsThreshold')) {
    $q = $KqlReadsFixed.Replace('{{VAULT}}', $vaultKql).Replace('{{THRESHOLD}}', "$ReadsThreshold")
    Add-Rule 'reads' "keevault-reads-$VaultName" "Warnregel: mehr als $ReadsThreshold verschiedene Einträge pro Person und Stunde" "Keevault: unusually many reads per person in $VaultName" $q 'PT1H' $null $true
}
else {
    $q = $KqlReadsBaseline.Replace('{{VAULT}}', $vaultKql).Replace('{{MINIMUM}}', "$BaselineMinimum").Replace('{{FACTOR}}', "$BaselineFactor")
    Add-Rule 'reads' "keevault-reads-$VaultName" "Warnregel: mehr als das $BaselineFactor-Fache der üblichen Abrufe pro Person und Stunde (mindestens $BaselineMinimum)" "Keevault: unusually many reads per person in $VaultName" $q 'PT1H' 'P2D' $true
}
if ($DeniedAlert) {
    Add-Rule 'denied' "keevault-denied-$VaultName" 'Warnregel: abgelehnte Zugriffe und Löschungen' "Keevault: denied accesses and deletions in $VaultName" $KqlDenied.Replace('{{VAULT}}', $vaultKql) 'PT15M' $null $false
}

$home_ = ($wsSub -eq $vaultSub) ? $groupPath : "/subscriptions/$vaultSub/resourceGroups/$VaultResourceGroup"
$alertPath = "$home_/providers/Microsoft.Insights/activityLogAlerts/keevault-diag-$VaultName"
$alert = ($workspace.Existing -or $groupExists -or $home_ -ne $groupPath) ? (Invoke-Rest GET $alertPath $api.activityAlerts) : $null
Add-Step 'activity' ($alert -and -not $alert.forbidden ? 'update' : 'create') 'Warnung im Aktivitätsprotokoll, wenn jemand die Diagnoseeinstellung ändert oder löscht' @{ Method = 'PUT'; Path = $alertPath; ApiVersion = $api.activityAlerts
    Body = @{ location = 'Global'; properties = @{ enabled = $true; scopes = @($vaultId); description = "Keevault: diagnostic setting of $VaultName changed or deleted"
            condition = @{ allOf = @(@{ field = 'category'; equals = 'Administrative' }, @{ anyOf = @(
                            @{ field = 'operationName'; equals = 'Microsoft.Insights/diagnosticSettings/write' },
                            @{ field = 'operationName'; equals = 'Microsoft.Insights/diagnosticSettings/delete' }) }) }
            actions = @{ actionGroups = @(@{ actionGroupId = $agId }) } } } } ($home_ -eq $groupPath ? $rightsScope : $home_) 'Microsoft.Insights/activityLogAlerts/write'

# Optional Azure Policy: our fixed definition (infra/policy-keyvault-logging.json) assigned at the vault's subscription.
if ($Policy -ne 'None') {
    $scope = $PolicyScope ? $PolicyScope : "/subscriptions/$vaultSub"
    $definition = Get-Content -Raw (Join-Path $PSScriptRoot 'policy-keyvault-logging.json') | ConvertFrom-Json -AsHashtable
    $defId = "/subscriptions/$vaultSub/providers/Microsoft.Authorization/policyDefinitions/keevault-keyvault-logging"
    Add-Step 'policy-definition' 'create' 'Policy-Definition „Keevault: Key Vault audit log to Log Analytics“' @{ Method = 'PUT'; Path = $defId; ApiVersion = $api.policyDefinitions; Body = $definition } "/subscriptions/$vaultSub" 'Microsoft.Authorization/policyDefinitions/write'
    $assignment = @{ properties = @{ displayName = 'Keevault: Key Vault audit log to Log Analytics'; policyDefinitionId = $defId
            parameters = @{ effect = @{ value = $Policy }; workspaceId = @{ value = $workspace.Id } } } }
    if ($Policy -eq 'DeployIfNotExists') { $assignment.identity = @{ type = 'SystemAssigned' }; $assignment.location = $vault.location }
    Add-Step 'policy-assignment' 'create' "Policy-Zuweisung ($Policy) auf $($scope -replace '/subscriptions/[^/]+', '/subscriptions/…')" @{ Method = 'PUT'
        Path = "$scope/providers/Microsoft.Authorization/policyAssignments/keevault-kv-logging"; ApiVersion = $api.policyAssignments; Body = $assignment } $scope 'Microsoft.Authorization/policyAssignments/write'
}

# ---------------------------------------------------------------- show, confirm, write

Write-Host ''
Write-Host "Probelauf für Key Vault '$VaultName' → Workspace '$($workspace.Name)':" -ForegroundColor Cyan
$i = 0
foreach ($s in $steps) {
    $i++
    $label = @{ create = 'anlegen'; update = 'ändern'; keep = 'bleibt'; register = 'registrieren' }[$s.Kind]
    Write-Host ("{0,2}. [{1}] {2}" -f $i, $label, $s.Text)
    if ($s.Missing) { Write-Host "     $($s.Missing)" -ForegroundColor Yellow }
}
if ($steps | Where-Object Missing) { throw 'Es fehlen Rechte – siehe Probelauf. Es wurde nichts geändert.' }
if ($WhatIfPreference) { Write-Host 'Nur Probelauf (-WhatIf): nichts geändert.'; return }
if (-not $Force -and -not $PSCmdlet.ShouldContinue('Diese Schritte jetzt ausführen?', 'Protokollierung einrichten')) { Write-Host 'Abgebrochen, nichts geändert.'; return }

foreach ($s in $steps) {
    if ($s.Kind -eq 'keep' -or -not $s.Request) { continue }
    $r = $s.Request
    $result = Invoke-Rest $r.Method $r.Path $r.ApiVersion $r.Body $s.Text
    if ($s.Wait) {
        for ($n = 0; $n -lt 30; $n++) {
            if ($s.Wait -eq 'provider') { if ((Invoke-Rest GET ($r.Path -replace '/register$', '') $api.providers).registrationState -eq 'Registered') { break } }
            elseif ((Invoke-Rest GET $r.Path $api.workspaces).properties.provisioningState -eq 'Succeeded') { break }
            Start-Sleep -Seconds 2
        }
    }
    if ($s.Id -eq 'policy-assignment' -and $Policy -eq 'DeployIfNotExists') {
        # The assignment's managed identity needs Monitoring Contributor and Log Analytics Contributor for remediation.
        foreach ($role in '749f88d5-cbae-40b8-bcfc-e573ddc772fa', '92aaf0da-9dab-42b6-94a3-d43ce8d16293') {
            foreach ($target in @($scope, $workspace.Id) | Select-Object -Unique) {
                Invoke-Rest PUT "$target/providers/Microsoft.Authorization/roleAssignments/$([guid]::NewGuid())" $api.roleAssignments @{ properties = @{
                        roleDefinitionId = "/subscriptions/$vaultSub/providers/Microsoft.Authorization/roleDefinitions/$role"
                        principalId = $result.identity.principalId; principalType = 'ServicePrincipal' } } 'Rollen für die Policy-Identität' | Out-Null
            }
        }
    }
    Write-Host "erledigt: $($s.Text)" -ForegroundColor Green
}
Write-Host ''
Write-Host 'Fertig. Die ersten Protokolle erscheinen nach einigen Minuten im Workspace (Tabelle AzureDiagnostics).'
if ($storageId) { Write-Host 'WORM: Die Unveränderlichkeit ist eingerichtet, aber noch nicht gesperrt. Sperren ist endgültig – siehe Wissensartikel.' }
