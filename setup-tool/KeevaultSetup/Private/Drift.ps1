# Drift check (#501 part e): the plan (from the wizard or a settings export) against what exists in the tenant and on
# this device. Read-only: GET requests and registry reads only. What is missing can be created by the normal run (dry
# run first); what differs or is extra is shown with a hint and stays as it is (the tool never changes foreign things).

$script:KsRegistry = {
    # -> hashtable value name -> value, or $null when the key does not exist. Read-only.
    param([string] $Hive, [string] $Key)
    $root = @{ HKLM = 'HKEY_LOCAL_MACHINE'; HKCU = 'HKEY_CURRENT_USER' }[$Hive]
    $item = Get-Item -LiteralPath "Registry::$root\$Key" -ErrorAction SilentlyContinue
    if (-not $item) { return $null }
    $out = @{}
    foreach ($n in $item.GetValueNames()) { $out[$n] = $item.GetValue($n) }
    return $out
}
# Data roles on a vault that matter for access; other roles at the vault are shown as extra without judgement.
$script:KsDataRoles = @('4633458b-17de-408a-b874-0445c86b69e6', 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7', '8b54135c-b56d-4d72-a534-26097cfdc8d8', '00482a5a-887f-4fb3-b363-3b7fe8e74483', '21090545-7ca7-4776-b22c-e363652d74d2')

function New-KsDriftItem([string] $Area, [string] $Object, [string] $Expected, [string] $Actual, [string] $Status, [string] $Fix = '', [string] $Hint = '') {
    return [pscustomobject]@{ Area = $Area; Object = $Object; Expected = $Expected; Actual = $Actual; Status = $Status; StatusText = (KsT "drift.s.$Status"); Fix = $Fix; Hint = $Hint }
}

function Get-KsVaultState($Plan, [string] $Sub, [string] $Vault, $Cache) {
    # The vault as ARM returns it (cached for drift and compliance): @{ Status = 200/404/403; Body }.
    if ($Cache.ContainsKey($Vault)) { return $Cache[$Vault] }
    $id = Get-KsVaultId $Plan $Sub $Vault
    $r = Invoke-KsRest GET "$($script:KsArm)$($id)?api-version=2023-07-01" -Ok 403, 404
    $Cache[$Vault] = @{ Status = $r.Status; Body = $r.Body; Id = $id }
    return $Cache[$Vault]
}

function Get-KsProp($Obj, [string] $Name) {
    if ($Obj -and $Obj.PSObject.Properties[$Name]) { return $Obj.$Name }
    return $null
}

function Test-KsTenantDrift($Plan, [string] $Sub, $Items, $Cache) {
    $arm = $script:KsArm
    $no = KsT 'drift.none'
    if ($Plan.steps.resourceGroup -or $Plan.steps.vaults) {
        $r = Invoke-KsRest GET "$arm/subscriptions/$Sub/resourceGroups/$($Plan.resourceGroup)?api-version=2021-04-01" -Ok 403, 404
        if ($r.Status -eq 403) { $Items.Add((New-KsDriftItem 'tenant' $Plan.resourceGroup (KsT 'drift.exists') '' 'notChecked' '' (KsT 'drift.noRead'))) }
        elseif ($r.Status -eq 404) { $Items.Add((New-KsDriftItem 'tenant' $Plan.resourceGroup (KsT 'drift.exists') $no 'missing' 'run')) }
        else { $Items.Add((New-KsDriftItem 'tenant' $Plan.resourceGroup (KsT 'drift.exists') (KsT 'drift.exists') 'ok')) }
    }
    foreach ($v in $Plan.vaults) {
        $vs = Get-KsVaultState $Plan $Sub $v.name $Cache
        if ($vs.Status -eq 403) { $Items.Add((New-KsDriftItem 'tenant' $v.name (KsT 'drift.exists') '' 'notChecked' '' (KsT 'drift.noRead'))); continue }
        if ($vs.Status -eq 404) { $Items.Add((New-KsDriftItem 'tenant' $v.name (KsT 'drift.exists') $no 'missing' 'run')); continue }
        $p = Get-KsProp $vs.Body 'properties'
        $tags = Get-KsProp $vs.Body 'tags'
        $checks = @(
            @('drift.v.rbac', 'true', [string] ([bool] (Get-KsProp $p 'enableRbacAuthorization')).ToString().ToLowerInvariant(), 'drift.h.rbac'),
            @('drift.v.softDelete', [string] $script:KsVaultSettings.SoftDeleteDays, [string] (Get-KsProp $p 'softDeleteRetentionInDays'), 'drift.h.softDelete'),
            @('drift.v.purge', 'true', [string] ([bool] (Get-KsProp $p 'enablePurgeProtection')).ToString().ToLowerInvariant(), 'drift.h.purge'),
            @('drift.v.marker', 'container', [string] (Get-KsProp $tags 'kvpwsafe'), 'drift.h.marker'),
            @('drift.v.location', $Plan.target.location, [string] (Get-KsProp $vs.Body 'location'), 'drift.h.location')
        )
        foreach ($c in $checks) {
            $obj = "$($v.name): $(KsT $c[0])"
            # A value ARM does not return (older API, missing field) is not drift; it is "not checked".
            if ($c[2] -eq '' -and $c[0] -ne 'drift.v.marker') { $Items.Add((New-KsDriftItem 'tenant' $obj $c[1] '' 'notChecked' '' (KsT 'drift.noValue'))); continue }
            if ($c[2] -eq $c[1]) { $Items.Add((New-KsDriftItem 'tenant' $obj $c[1] $c[2] 'ok')) }
            else { $Items.Add((New-KsDriftItem 'tenant' $obj $c[1] $(if ($c[2]) { $c[2] } else { $no }) 'differs' 'manual' (KsT $c[3]))) }
        }
    }
    $groupIds = @{}
    if ($Plan.steps.groups -or $Plan.steps.roles) {
        foreach ($v in $Plan.vaults) {
            foreach ($level in $script:KsLevels.Keys) {
                $name = Get-KsGroupName $Plan $v.name $level
                try { $g = @(Find-KsGroup $name) }
                catch { $Items.Add((New-KsDriftItem 'tenant' $name (KsT 'drift.secGroup') '' 'notChecked' '' (KsT 'drift.noRead'))); continue }
                if ($g.Count -eq 0) { $Items.Add((New-KsDriftItem 'tenant' $name (KsT 'drift.secGroup') $no 'missing' 'run')) }
                elseif ($g.Count -gt 1) { $Items.Add((New-KsDriftItem 'tenant' $name (KsT 'drift.secGroup') (KsT 'drift.groupsN' $g.Count) 'differs' 'manual' (KsT 'drift.h.twice'))) }
                elseif (-not $g[0].securityEnabled -or $g[0].mailEnabled) { $Items.Add((New-KsDriftItem 'tenant' $name (KsT 'drift.secGroup') (KsT 'drift.mailGroup') 'differs' 'manual' (KsT 'drift.h.mail'))) }
                else { $groupIds[[string] $g[0].id] = @($v.name, $level, $name); $Items.Add((New-KsDriftItem 'tenant' $name (KsT 'drift.secGroup') (KsT 'drift.secGroup') 'ok')) }
            }
        }
    }
    if ($Plan.steps.roles) {
        foreach ($v in $Plan.vaults) {
            $vs = Get-KsVaultState $Plan $Sub $v.name $Cache
            if ($vs.Status -ne 200 -and $vs.Status -ne 201) { continue }
            $r = Invoke-KsRest GET "$arm$($vs.Id)/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&`$filter=atScope()" -Ok 403
            if ($r.Status -eq 403) { $Items.Add((New-KsDriftItem 'tenant' "$($v.name): $(KsT 'drift.roles')" '' '' 'notChecked' '' (KsT 'drift.noRead'))); continue }
            $existing = @($r.Body.value | Where-Object { $_ })
            $expected = @{}
            foreach ($id in $groupIds.Keys) {
                if ($groupIds[$id][0] -ne $v.name) { continue }
                foreach ($role in $script:KsLevels[$groupIds[$id][1]]) { $expected["$id|$role"] = $groupIds[$id][2] }
            }
            foreach ($level in $script:KsLevels.Keys) {
                $name = Get-KsGroupName $Plan $v.name $level
                $id = @($groupIds.Keys | Where-Object { $groupIds[$_][2] -eq $name })[0]
                foreach ($role in $script:KsLevels[$level]) {
                    $obj = KsT 'read.role' (Get-KsRoleName $role) $name $v.name
                    $has = $id -and @($existing | Where-Object { [string] $_.properties.principalId -eq $id -and ([string] $_.properties.roleDefinitionId).ToLowerInvariant().EndsWith("/$role") }).Count
                    if ($has) { $Items.Add((New-KsDriftItem 'tenant' $obj (KsT 'drift.assigned') (KsT 'drift.assigned') 'ok')) }
                    else { $Items.Add((New-KsDriftItem 'tenant' $obj (KsT 'drift.assigned') $no 'missing' 'run')) }
                }
            }
            foreach ($a in $existing) {
                $role = ([string] $a.properties.roleDefinitionId).Split('/')[-1].ToLowerInvariant()
                $principal = [string] $a.properties.principalId
                if ($expected.ContainsKey("$principal|$role")) { continue }
                $roleName = Get-KsRoleName $role
                if (-not $roleName) { $roleName = $role }
                # Shares made in the app are role assignments to people: normal, but worth a look.
                $hint = KsT 'drift.h.extra'
                if ($groupIds.ContainsKey($principal)) { $hint = KsT 'drift.h.extraLevel' $groupIds[$principal][2] }
                elseif ($script:KsDataRoles -notcontains $role) { $hint = KsT 'drift.h.extraOther' }
                $Items.Add((New-KsDriftItem 'tenant' "$($v.name): $roleName" '' (KsT 'drift.principal' $principal ([string] $a.properties.principalType)) 'extra' 'manual' $hint))
            }
        }
    }
}

function Test-KsDeviceDrift($Plan, $Items) {
    if (-not (Test-KsDevicePolicyChosen $Plan)) { return }
    $cache = @{}
    foreach ($val in @(Get-KsDevicePolicyValues $Plan)) {
        $k = "$($val.Hive)\$($val.Key)"
        if (-not $cache.ContainsKey($k)) { $cache[$k] = & $script:KsRegistry $val.Hive $val.Key }
        $values = $cache[$k]
        $want = [string] $val.Value
        $obj = "$k\$($val.Name)"
        if ($null -eq $values) { $Items.Add((New-KsDriftItem 'device' $obj $want (KsT 'drift.none') 'missing' 'manual' (KsT 'drift.h.device'))); continue }
        if ($val.Name -eq '*') {
            # Forcelist: any numbered value with exactly this entry.
            $hit = @($values.Keys | Where-Object { [string] $values[$_] -eq $want }).Count
            if ($hit) { $Items.Add((New-KsDriftItem 'device' $obj $want $want 'ok')) }
            else { $Items.Add((New-KsDriftItem 'device' $obj $want (KsT 'drift.none') 'missing' 'manual' (KsT 'drift.h.device'))) }
            continue
        }
        if (-not $values.ContainsKey($val.Name)) { $Items.Add((New-KsDriftItem 'device' $obj $want (KsT 'drift.none') 'missing' 'manual' (KsT 'drift.h.device'))); continue }
        $have = [string] $values[$val.Name]
        if ($have -eq $want) { $Items.Add((New-KsDriftItem 'device' $obj $want $have 'ok')) }
        else { $Items.Add((New-KsDriftItem 'device' $obj $want $have 'differs' 'manual' (KsT 'drift.h.device'))) }
    }
}

function Test-KeevaultSetupDrift {
    <#
    .SYNOPSIS
        Vergleicht den Plan mit dem Ist-Stand im Tenant (-Tenant, Standard) und auf diesem Gerät (-Device). Liest nur.
        Fehlendes legt der normale Lauf an (erst Probelauf); Abweichendes und Zusätzliches bleibt und bekommt einen Hinweis.
    .EXAMPLE
        $plan = Import-KeevaultSetupPlan -Path .\keevault-einrichtung.json
        Test-KeevaultSetupDrift -Plan $plan -Device
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Plan, [switch] $Device, [switch] $NoTenant)
    $check = Test-KeevaultSetupPlan $Plan
    if (-not $check.Valid) { throw (KsT 'plan.invalid' ($check.Errors -join ' ')) }
    $p = $check.Plan
    $items = New-Object System.Collections.Generic.List[object]
    $cache = @{}
    if (-not $NoTenant) {
        Assert-KsSignedIn
        if ($p.target.tenantId -and $script:KsCtx.TenantId -and $p.target.tenantId -ne $script:KsCtx.TenantId) { throw (KsT 'run.otherTenant') }
        $sub = $p.target.subscriptionId
        if (-not $sub) { $sub = $script:KsCtx.SubscriptionId }
        if (-not $sub) { throw (KsT 'read.noSub') }
        Test-KsTenantDrift $p $sub $items $cache
    }
    if ($Device) { Test-KsDeviceDrift $p $items }
    $summary = [ordered]@{}
    foreach ($s in 'ok', 'missing', 'differs', 'extra', 'notChecked') { $summary[$s] = @($items | Where-Object { $_.Status -eq $s }).Count }
    return [pscustomobject]@{
        Kind = 'drift'; Time = (Get-Date).ToString('yyyy-MM-dd HH:mm'); PlanHash = (Get-KeevaultSetupPlanHash $p); Plan = $p
        Account = $(if ($script:KsCtx) { $script:KsCtx.Account } else { '' }); Language = $script:KsLang
        Items = $items.ToArray(); Summary = $summary
        FixByRun = [bool] @($items | Where-Object { $_.Fix -eq 'run' }).Count
    }
}
