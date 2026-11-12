# Rights check at the start: which Entra and Azure roles the signed-in admin has, and which steps they allow.
# Read-only. Roles only eligible through PIM and not activated do not count (the admin activates them first).

# Known role names are in I18n.ps1 (entra.<templateId>, azure.<roleId>).
# Capability -> roles that grant it. groupCreate is also granted when the tenant lets every user create security groups.
$script:KsCapabilityRoles = @{
    armWrite    = @('8e3af657-a8ff-443c-a75c-2fe8c4bcb635', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
    roleAssign  = @('8e3af657-a8ff-443c-a75c-2fe8c4bcb635', '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9', 'f58310d9-a9f6-439a-9e8d-f62e7b41a168')
    groupCreate = @('62e90394-69f5-4237-9190-012177145e10', 'fdd7a751-b60b-444a-984c-02652fe8fa1c', 'fe930be7-5e62-47db-91af-98c3a49a38b1')
}

function Get-KeevaultSetupRights {
    <#
    .SYNOPSIS
        Liest die aktiven Entra- und Azure-Rollen des angemeldeten Administrators und leitet ab, was er darf.
    #>
    [CmdletBinding()]
    param([string] $SubscriptionId, [string] $ResourceGroup)
    Assert-KsSignedIn
    if (-not $SubscriptionId) { $SubscriptionId = $script:KsCtx.SubscriptionId }
    $notes = New-Object System.Collections.Generic.List[string]
    $me = (Invoke-KsRest GET "$($script:KsGraph)/me?`$select=id,userPrincipalName,displayName").Body

    $entra = New-Object System.Collections.Generic.List[object]
    $r = Invoke-KsRest GET "$($script:KsGraph)/me/transitiveMemberOf/microsoft.graph.directoryRole?`$select=roleTemplateId,displayName" -Ok 403
    if ($r.Status -eq 403) { $notes.Add((KsT 'rights.entraHidden')) }
    elseif ($r.Body -and $r.Body.value) {
        foreach ($role in $r.Body.value) {
            $name = KsT "entra.$([string] $role.roleTemplateId)"
            if ($name -like 'entra.*') { $name = [string] $role.displayName }
            $entra.Add([pscustomobject]@{ Id = [string] $role.roleTemplateId; Name = $name })
        }
    }
    $usersCreateGroups = $false
    $pol = Invoke-KsRest GET "$($script:KsGraph)/policies/authorizationPolicy?`$select=defaultUserRolePermissions" -Ok 400, 401, 403, 404
    if ($pol.Status -lt 400 -and $pol.Body -and $pol.Body.defaultUserRolePermissions) {
        $usersCreateGroups = [bool] $pol.Body.defaultUserRolePermissions.allowedToCreateSecurityGroups
    }

    # Entra ID P2 (PIM for groups): a licence with the AAD_PREMIUM_P2 service plan. $null = not readable.
    $p2 = $null
    $sku = Invoke-KsRest GET "$($script:KsGraph)/subscribedSkus" -Ok 400, 401, 403, 404
    if ($sku.Status -lt 400 -and $sku.Body -and $sku.Body.PSObject.Properties['value']) {
        $p2 = $false
        foreach ($s in @($sku.Body.value)) {
            if (-not $s -or @('Enabled', 'Warning') -notcontains [string] $s.capabilityStatus) { continue }
            foreach ($plan in @($s.servicePlans)) {
                if ($plan -and [string] $plan.servicePlanName -eq 'AAD_PREMIUM_P2' -and [string] $plan.provisioningStatus -ne 'Disabled') { $p2 = $true }
            }
        }
        if (-not $p2) { $notes.Add((KsT 'rights.noP2')) }
    }
    else { $notes.Add((KsT 'rights.p2Unknown')) }

    $azure = New-Object System.Collections.Generic.List[object]
    if ($SubscriptionId) {
        $filter = [uri]::EscapeDataString("assignedTo('$($me.id)')")
        $a = Invoke-KsRest GET "$($script:KsArm)/subscriptions/$SubscriptionId/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&`$filter=$filter" -Ok 403, 404
        if ($a.Status -ge 400) { $notes.Add((KsT 'rights.azureHidden')) }
        else {
            $subScope = "/subscriptions/$SubscriptionId".ToLowerInvariant()
            $rgScope = "$subScope/resourcegroups/$ResourceGroup".ToLowerInvariant()
            foreach ($as in @($a.Body.value)) {
                if (-not $as) { continue }
                $scope = ([string] $as.properties.scope).ToLowerInvariant()
                # Counts when the assignment covers the resource group: root, management group, subscription or the group itself.
                $covers = ($scope -eq '/' -or $scope -like '/providers/microsoft.management/managementgroups/*' -or $scope -eq $subScope -or ($ResourceGroup -and $scope -eq $rgScope))
                if (-not $covers) { continue }
                $roleId = ([string] $as.properties.roleDefinitionId).Split('/')[-1].ToLowerInvariant()
                $name = KsT "azure.$roleId"
                if ($name -like 'azure.*') { $name = KsT 'azure.other' $roleId }
                $azure.Add([pscustomobject]@{ Id = $roleId; Name = $name; Scope = [string] $as.properties.scope })
            }
        }
    }
    else { $notes.Add((KsT 'rights.noSub')) }

    $entraIds = @($entra | ForEach-Object { $_.Id })
    $azureIds = @($azure | ForEach-Object { $_.Id })
    $can = [ordered]@{
        armWrite    = [bool] (@($script:KsCapabilityRoles.armWrite | Where-Object { $azureIds -contains $_ }).Count)
        roleAssign  = [bool] (@($script:KsCapabilityRoles.roleAssign | Where-Object { $azureIds -contains $_ }).Count)
        groupCreate = [bool] (@($script:KsCapabilityRoles.groupCreate | Where-Object { $entraIds -contains $_ }).Count) -or $usersCreateGroups
    }
    if ($usersCreateGroups -and -not (@($script:KsCapabilityRoles.groupCreate | Where-Object { $entraIds -contains $_ }).Count)) {
        $notes.Add((KsT 'rights.usersGroups'))
    }
    if ($can.roleAssign -and @($azureIds | Where-Object { $_ -eq 'f58310d9-a9f6-439a-9e8d-f62e7b41a168' }).Count -and -not @($azureIds | Where-Object { $_ -in '8e3af657-a8ff-443c-a75c-2fe8c4bcb635', '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9' }).Count) {
        $notes.Add((KsT 'rights.rbacAdmin'))
    }
    return [pscustomobject]@{
        Account     = [string] $me.userPrincipalName
        ObjectId    = [string] $me.id
        EntraRoles  = $entra.ToArray()
        AzureRoles  = $azure.ToArray()
        Can         = $can
        EntraP2     = $p2
        Notes       = $notes.ToArray()
    }
}
