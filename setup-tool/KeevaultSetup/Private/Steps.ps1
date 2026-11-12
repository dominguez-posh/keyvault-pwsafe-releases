# Steps of part a and the run: read the state, list what is missing, write only after a dry run and a confirmation.
# Every step is idempotent: what exists is kept, foreign role assignments and policies are never changed or removed.

$script:KsRole = @{
    SecretsUser     = '4633458b-17de-408a-b874-0445c86b69e6'
    SecretsOfficer  = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
    DataAccessAdmin = '8b54135c-b56d-4d72-a534-26097cfdc8d8'
    Reader          = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
}
$script:KsRoleName = @{
    '4633458b-17de-408a-b874-0445c86b69e6' = 'Key Vault Secrets User'
    'b86a8fe4-44ce-4948-aee5-eccb2c155cd7' = 'Key Vault Secrets Officer'
    '8b54135c-b56d-4d72-a534-26097cfdc8d8' = 'Key Vault Data Access Administrator'
    'acdd72a7-3385-48ef-bd42-f606fba81ae7' = 'role.reader'
}
function Get-KsRoleName([string] $Id) {
    $name = $script:KsRoleName[$Id]
    if ($name -like 'role.*') { return (KsT $name) }
    return $name
}
# Same levels as infra/azuredeploy.bicep: Reader lets the app find the vault and show the access level.
$script:KsLevels = [ordered]@{
    Read  = @($script:KsRole.SecretsUser, $script:KsRole.Reader)
    Write = @($script:KsRole.SecretsOfficer, $script:KsRole.Reader)
    Admin = @($script:KsRole.SecretsOfficer, $script:KsRole.DataAccessAdmin, $script:KsRole.Reader)
}
# Tips are manual steps with a title and a text (tip.<key>.title/.text in I18n.ps1); questions are asked with a step.
$script:KsTipKeys = @('subscriptionTip', 'pim', 'breakGlass', 'conditionalAccess', 'emergencyHandbook')
$script:KsQuestions = [ordered]@{
    breakGlass        = @('breakGlassFidoLocation', 'breakGlassAccess')
    emergencyHandbook = @('recoveryKeyLocation', 'contactOwner', 'contactEmergency')
}
# Same settings for the vault in the run and in the Terraform export (Terraform.ps1).
$script:KsVaultSettings = @{ Sku = 'standard'; SoftDeleteDays = 90; PurgeProtection = $true; PublicNetworkAccess = 'Enabled' }

function Get-KeevaultSetupStep {
    <#
    .SYNOPSIS
        Die Schritte eines Plans in Reihenfolge, ohne Netzwerkzugriff.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory, Position = 0)] $Plan)
    $check = Test-KeevaultSetupPlan $Plan
    if (-not $check.Valid) { throw ($check.Errors -join '; ') }
    $p = $check.Plan
    $list = New-Object System.Collections.Generic.List[object]
    function Add-Step([string] $Id, [string] $Key, [string] $Kind, [string] $Title, [string] $Right, [string] $Vault) {
        $text = ''; $questions = @()
        if ($script:KsTipKeys -contains $Key) { $text = KsT "tip.$Key.text" }
        if ($script:KsQuestions.Contains($Key)) { $questions = @($script:KsQuestions[$Key] | ForEach-Object { [pscustomobject]@{ Id = $_; Text = (KsT "q.$_"); Answer = $p.answers[$_] } }) }
        $rightText = ''
        if ($Right) { $rightText = KsT "cap.$Right" }
        $list.Add([pscustomobject]@{ Id = $Id; Key = $Key; Kind = $Kind; Title = $Title; Right = $Right; RightText = $rightText; Vault = $Vault; Selected = [bool] $p.steps[$Key]; Text = $text; Questions = $questions })
    }
    Add-Step 'subscriptionTip' 'subscriptionTip' 'manual' (KsT 'tip.subscriptionTip.title') '' ''
    Add-Step 'resourceGroup' 'resourceGroup' 'auto' (KsT 'step.resourceGroup' $p.resourceGroup $p.target.location) 'armWrite' ''
    foreach ($v in $p.vaults) { Add-Step "vault:$($v.name)" 'vaults' 'auto' (KsT 'step.vault' $v.name) 'armWrite' $v.name }
    foreach ($v in $p.vaults) { Add-Step "groups:$($v.name)" 'groups' 'auto' (KsT 'step.groups' $v.name ((@($script:KsLevels.Keys) | ForEach-Object { Get-KsGroupName $p $v.name $_ }) -join ', ')) 'groupCreate' $v.name }
    foreach ($v in $p.vaults) { Add-Step "roles:$($v.name)" 'roles' 'auto' (KsT 'step.roles' $v.name) 'roleAssign' $v.name }
    Add-Step 'pim' 'pim' 'manual' (KsT 'tip.pim.title') '' ''
    Add-Step 'breakGlass' 'breakGlass' 'manual' (KsT 'tip.breakGlass.title') '' ''
    Add-Step 'conditionalAccess' 'conditionalAccess' 'manual' (KsT 'tip.conditionalAccess.title') '' ''
    Add-Step 'emergencyHandbook' 'emergencyHandbook' 'manual' (KsT 'tip.emergencyHandbook.title') '' ''
    return $list.ToArray()
}

function Get-KsAssignmentName([string] $Scope, [string] $Principal, [string] $Role) {
    # Deterministic name per (scope, principal, role): a repeated run finds or re-puts the same assignment.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $b = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes(("$Scope|$Principal|$Role").ToLowerInvariant())) } finally { $sha.Dispose() }
    $b[6] = ($b[6] -band 0x0f) -bor 0x50
    $b[8] = ($b[8] -band 0x3f) -bor 0x80
    $h = (($b[0..15] | ForEach-Object { $_.ToString('x2') }) -join '')
    return '{0}-{1}-{2}-{3}-{4}' -f $h.Substring(0, 8), $h.Substring(8, 4), $h.Substring(12, 4), $h.Substring(16, 4), $h.Substring(20, 12)
}

function Find-KsGroup([string] $Name) {
    $filter = [uri]::EscapeDataString("displayName eq '$($Name.Replace("'", "''"))'")
    $r = Invoke-KsRest GET "$($script:KsGraph)/groups?`$filter=$filter&`$select=id,displayName,securityEnabled,mailEnabled"
    return @($r.Body.value | Where-Object { $_ })
}

function Get-KsVaultId($Plan, [string] $Sub, [string] $Vault) {
    return "/subscriptions/$Sub/resourceGroups/$($Plan.resourceGroup)/providers/Microsoft.KeyVault/vaults/$Vault"
}

function Read-KsStep($Step, $Plan, [string] $Sub, [string] $TenantId, $State, [bool] $Dry) {
    # Reads the current state of one step. Returns @{ Detail; Actions; Failed; Manual; Blocked } where Actions are the
    # requests still missing. Nothing here writes.
    $res = @{ Detail = ''; Actions = @(); Failed = ''; Manual = ''; Blocked = '' }
    $arm = $script:KsArm
    $needsSub = @('resourceGroup', 'vaults', 'roles')
    if ($needsSub -contains $Step.Key -and -not $Sub) { $res.Failed = KsT 'read.noSub'; return $res }
    switch ($Step.Key) {
        'resourceGroup' {
            $id = "/subscriptions/$Sub/resourceGroups/$($Plan.resourceGroup)"
            $r = Invoke-KsRest GET "$arm$($id)?api-version=2021-04-01" -Ok 404
            if ($r.Status -ne 404) { $res.Detail = KsT 'read.exists'; return $res }
            $res.Actions = @(@{ Text = (KsT 'read.rgCreate' $Plan.resourceGroup $Plan.target.location); Method = 'PUT'; Uri = "$arm$($id)?api-version=2021-04-01"; Body = @{ location = $Plan.target.location } })
        }
        'vaults' {
            $vault = @($Plan.vaults | Where-Object { $_.name -eq $Step.Vault })[0]
            $id = Get-KsVaultId $Plan $Sub $Step.Vault
            $r = Invoke-KsRest GET "$arm$($id)?api-version=2023-07-01" -Ok 404
            if ($r.Status -ne 404) {
                $State.Vaults[$Step.Vault] = [bool] $r.Body.properties.enableRbacAuthorization
                if (-not $r.Body.properties.enableRbacAuthorization) {
                    $res.Manual = KsT 'read.accessPolicies'
                }
                else { $res.Detail = KsT 'read.rbacActive' }
                return $res
            }
            $n = Invoke-KsRest POST "$arm/subscriptions/$Sub/providers/Microsoft.KeyVault/checkNameAvailability?api-version=2023-07-01" @{ name = $Step.Vault; type = 'Microsoft.KeyVault/vaults' }
            if ($n.Body -and $n.Body.PSObject.Properties['nameAvailable'] -and -not $n.Body.nameAvailable) {
                $res.Failed = KsT 'read.nameTaken' $Step.Vault
                return $res
            }
            $res.Actions = @(@{
                    Text = (KsT 'read.vaultCreate' $Step.Vault); Method = 'PUT'; Uri = "$arm$($id)?api-version=2023-07-01"; After = 'vault'
                    Body = @{
                        location   = $Plan.target.location
                        tags       = @{ kvpwsafe = 'container'; 'kvpwsafe-name' = $vault.displayName }
                        properties = @{
                            tenantId = $TenantId; sku = @{ family = 'A'; name = $script:KsVaultSettings.Sku }; enableRbacAuthorization = $true
                            enableSoftDelete = $true; softDeleteRetentionInDays = $script:KsVaultSettings.SoftDeleteDays
                            enablePurgeProtection = $script:KsVaultSettings.PurgeProtection; publicNetworkAccess = $script:KsVaultSettings.PublicNetworkAccess
                        }
                    }
                })
        }
        'groups' {
            $actions = @(); $found = @()
            foreach ($level in $script:KsLevels.Keys) {
                $name = Get-KsGroupName $Plan $Step.Vault $level
                $groups = @(Find-KsGroup $name)
                if ($groups.Count -gt 1) { $res.Failed = KsT 'read.groupTwice' $name; return $res }
                if ($groups.Count -eq 1) {
                    if (-not $groups[0].securityEnabled -or $groups[0].mailEnabled) { $res.Failed = KsT 'read.groupNotSec' $name; return $res }
                    $State.Groups[$name] = [string] $groups[0].id
                    $found += $name
                    continue
                }
                $nick = ($name -replace '[^A-Za-z0-9]', '')
                if ($nick.Length -gt 56) { $nick = $nick.Substring(0, 56) }
                $actions += @{
                    Text = (KsT 'read.groupCreate' $name); Method = 'POST'; Uri = "$($script:KsGraph)/groups"; Capture = $name
                    Body = @{ displayName = $name; mailEnabled = $false; securityEnabled = $true; mailNickname = $nick; description = (KsT 'read.groupDesc' $level $Step.Vault) }
                }
            }
            $res.Actions = $actions
            if ($found.Count) { $res.Detail = KsT 'read.found' ($found -join ', ') }
        }
        'roles' {
            $id = Get-KsVaultId $Plan $Sub $Step.Vault
            $exists = $State.Vaults.ContainsKey($Step.Vault)
            if (-not $exists) {
                $v = Invoke-KsRest GET "$arm$($id)?api-version=2023-07-01" -Ok 404
                $exists = $v.Status -ne 404
                if ($exists) { $State.Vaults[$Step.Vault] = [bool] $v.Body.properties.enableRbacAuthorization }
            }
            if ($exists -and -not $State.Vaults[$Step.Vault]) {
                # Data roles have no effect on a vault with access policies; switching it over stays a manual step.
                $res.Manual = KsT 'read.rolesPolicies'
                return $res
            }
            $existing = @()
            if ($exists) {
                $r = Invoke-KsRest GET "$arm$id/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&`$filter=atScope()"
                $existing = @($r.Body.value | Where-Object { $_ })
            }
            elseif (-not $Dry) { $res.Blocked = KsT 'read.vaultMissing' $Step.Vault }
            $actions = @()
            foreach ($level in $script:KsLevels.Keys) {
                $name = Get-KsGroupName $Plan $Step.Vault $level
                $principal = $State.Groups[$name]
                if (-not $principal) {
                    $g = @(Find-KsGroup $name)
                    if ($g.Count -eq 1) { $principal = [string] $g[0].id; $State.Groups[$name] = $principal }
                }
                foreach ($role in $script:KsLevels[$level]) {
                    $has = @($existing | Where-Object { $principal -and $_.properties.principalId -eq $principal -and ([string] $_.properties.roleDefinitionId).ToLowerInvariant().EndsWith("/$role") })
                    if ($has.Count) { continue }
                    $text = KsT 'read.role' (Get-KsRoleName $role) $name $Step.Vault
                    if (-not $principal) {
                        if (-not $Dry) { $res.Blocked = KsT 'read.groupMissing' $name }
                        $actions += @{ Text = (KsT 'read.rolePending' $text); Pending = $true }
                        continue
                    }
                    $assignment = Get-KsAssignmentName $id $principal $role
                    $actions += @{
                        Text = $text; Method = 'PUT'; Ok = @(409)
                        Uri = "$arm$id/providers/Microsoft.Authorization/roleAssignments/$($assignment)?api-version=2022-04-01"
                        Body = @{ properties = @{ roleDefinitionId = "/subscriptions/$Sub/providers/Microsoft.Authorization/roleDefinitions/$role"; principalId = $principal; principalType = 'Group' } }
                    }
                }
            }
            $res.Actions = $actions
        }
    }
    return $res
}

function Invoke-KeevaultSetup {
    <#
    .SYNOPSIS
        Probelauf (-WhatIf) oder Ausführen eines Plans. Ausführen verlangt den Fingerabdruck aus dem Probelauf
        (-ConfirmPlanHash) und fragt je Schritt nach (ConfirmImpact High; -Confirm:$false nur nach eigener Bestätigung).
    .EXAMPLE
        $dry = Invoke-KeevaultSetup -Plan $plan -WhatIf
        Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash $dry.PlanHash
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param(
        [Parameter(Mandatory)] $Plan,
        [string] $ConfirmPlanHash,
        $Rights,
        [switch] $SkipRightsCheck
    )
    Assert-KsSignedIn
    $check = Test-KeevaultSetupPlan $Plan
    if (-not $check.Valid) { throw (KsT 'plan.invalid' ($check.Errors -join ' ')) }
    $p = $check.Plan
    $hash = Get-KeevaultSetupPlanHash $p
    $dry = [bool] $WhatIfPreference
    if (-not $dry) {
        if (-not $ConfirmPlanHash) { throw (KsT 'run.needDryRun') }
        if ($ConfirmPlanHash -ne $hash) { throw (KsT 'run.changed') }
    }
    if ($p.target.tenantId -and $script:KsCtx.TenantId -and $p.target.tenantId -ne $script:KsCtx.TenantId) {
        throw (KsT 'run.otherTenant')
    }
    $sub = $p.target.subscriptionId
    if (-not $sub) { $sub = $script:KsCtx.SubscriptionId }
    if (-not $Rights -and -not $SkipRightsCheck) { $Rights = Get-KeevaultSetupRights -SubscriptionId $sub -ResourceGroup $p.resourceGroup }

    $state = @{ Groups = @{}; Vaults = @{} }
    $results = New-Object System.Collections.Generic.List[object]
    foreach ($step in (Get-KeevaultSetupStep $p)) {
        $status = ''; $detail = ''; $actions = @()
        if (-not $step.Selected) { $status = 'skipped' }
        elseif ($step.Kind -eq 'manual') {
            $status = 'manual'
            if ($step.Key -eq 'pim') {
                # PIM for groups needs Entra ID P2: without it the tip becomes a note, unknown stays a tip with a warning.
                if ($Rights -and $Rights.PSObject.Properties['EntraP2'] -and $Rights.EntraP2 -eq $false) { $status = 'info'; $detail = KsT 'pim.needsP2' }
                elseif ($Rights -and $Rights.PSObject.Properties['EntraP2'] -and $Rights.EntraP2 -eq $true) { $detail = KsT 'pim.p2Found' }
                else { $detail = KsT 'pim.p2Unknown' }
            }
        }
        else {
            try {
                $info = Read-KsStep $step $p $sub $script:KsCtx.TenantId $state $dry
                $actions = @($info.Actions)
                $allowed = $SkipRightsCheck -or ($Rights -and $Rights.Can[$step.Right])
                if ($info.Failed) { $status = 'failed'; $detail = $info.Failed }
                elseif ($info.Manual) { $status = 'manual'; $detail = $info.Manual }
                elseif ($actions.Count -eq 0) { $status = 'done'; $detail = $info.Detail; if (-not $detail) { $detail = KsT 'read.exists' } }
                elseif (-not $allowed) { $status = 'noRight'; $detail = KsT 'run.noRight' $step.RightText }
                elseif ($dry) { $status = 'planned'; $detail = $info.Detail }
                elseif ($info.Blocked) { $status = 'blocked'; $detail = $info.Blocked }
                else {
                    $done = 0
                    foreach ($a in $actions) {
                        if (-not $PSCmdlet.ShouldProcess($a.Text, (KsT 'run.what'))) { continue }
                        $ok = @(); if ($a.ContainsKey('Ok')) { $ok = $a.Ok }
                        $r = Invoke-KsRest $a.Method $a.Uri $a.Body -Ok $ok
                        if ($a.ContainsKey('Capture') -and $r.Body -and $r.Body.id) { $state.Groups[$a.Capture] = [string] $r.Body.id }
                        if ($a.ContainsKey('After') -and $a.After -eq 'vault') { Wait-KsVault $a.Uri; $state.Vaults[$step.Vault] = $true }
                        $done++
                    }
                    if ($done -eq $actions.Count) { $status = 'done'; $detail = KsT 'run.created' }
                    else { $status = 'blocked'; $detail = KsT 'run.notConfirmed' }
                }
            }
            catch { $status = 'failed'; $detail = $_.Exception.Message }
        }
        $results.Add([pscustomobject]@{
                Id = $step.Id; Key = $step.Key; Kind = $step.Kind; Title = $step.Title; Vault = $step.Vault
                Status = $status; StatusText = (KsT "status.$status"); Detail = $detail
                Actions = @($actions | ForEach-Object { $_.Text }); Text = $step.Text; Questions = $step.Questions; RightText = $step.RightText
            })
    }
    return [pscustomobject]@{
        PlanHash = $hash; DryRun = $dry; Time = (Get-Date).ToString('yyyy-MM-dd HH:mm')
        Account = $script:KsCtx.Account; Rights = $Rights; Steps = $results.ToArray(); Plan = $p
        Language = $script:KsLang; EntraP2 = $(if ($Rights -and $Rights.PSObject.Properties['EntraP2']) { $Rights.EntraP2 } else { $null })
        ToolVersion = [string] $MyInvocation.MyCommand.Module.Version
    }
}

function Wait-KsVault([string] $Uri) {
    for ($i = 0; $i -lt 30; $i++) {
        $v = Invoke-KsRest GET $Uri
        $state = [string] $v.Body.properties.provisioningState
        if ($state -eq 'Succeeded') { return }
        if ($state -eq 'Failed') { throw (KsT 'vault.failed') }
        Start-Sleep -Seconds $script:KsSleepSeconds
    }
    throw (KsT 'vault.slow')
}
