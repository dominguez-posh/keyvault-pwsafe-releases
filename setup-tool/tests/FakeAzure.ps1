# Stub of ARM and Microsoft Graph for the setup tool's tests (#501). Only placeholder data, no real tenant.
# New-KsFake returns @{ State; Transport }: State holds the fake tenant and logs every request and every write,
# Transport answers like Invoke-AzRestMethod (StatusCode, Content).

$script:FakeSub = '00000000-0000-0000-0000-00000000aaaa'
$script:FakeTenant = '00000000-0000-0000-0000-00000000bbbb'
$script:FakeMe = '00000000-0000-0000-0000-00000000cccc'

function New-KsFake {
    param([string[]] $EntraRoles = @('fdd7a751-b60b-444a-984c-02652fe8fa1c'), [string[]] $AzureRoles = @('8e3af657-a8ff-443c-a75c-2fe8c4bcb635'), [switch] $UsersCreateGroups, [ValidateSet('yes', 'no', 'hidden')][string] $P2 = 'yes')
    $state = @{
        Sub = $script:FakeSub; Tenant = $script:FakeTenant
        Me = @{ id = $script:FakeMe; userPrincipalName = 'admin@contoso.example'; displayName = 'Admin' }
        EntraRoles = $EntraRoles; AzureRoles = $AzureRoles; UsersCreateGroups = [bool] $UsersCreateGroups; P2 = $P2
        ResourceGroups = @{}; Vaults = @{}; TakenNames = @(); Groups = @{}; Assignments = @{}
        Requests = New-Object System.Collections.ArrayList; Writes = New-Object System.Collections.ArrayList
        Unknown = New-Object System.Collections.ArrayList
    }
    $transport = {
        param([string] $Method, [string] $Uri, [string] $Payload)
        $s = $state
        [void] $s.Requests.Add("$Method $Uri")
        function Reply([int] $Code, $Obj) { [pscustomobject]@{ StatusCode = $Code; Content = $(if ($null -ne $Obj) { $Obj | ConvertTo-Json -Depth 10 -Compress } else { '' }) } }
        function Err([int] $Code, [string] $Msg) { Reply $Code @{ error = @{ code = 'Fake'; message = $Msg } } }
        $body = $null
        if ($Payload) { $body = $Payload | ConvertFrom-Json }
        $u = [uri] $Uri
        $path = [uri]::UnescapeDataString($u.AbsolutePath)
        $query = [uri]::UnescapeDataString($u.Query)
        $isWrite = $Method -ne 'GET' -and $path -notlike '*/checkNameAvailability'
        if ($isWrite) { [void] $s.Writes.Add("$Method $path") }
        $hasRole = { param([string[]] $Ids) @($s.AzureRoles | Where-Object { $Ids -contains $_ }).Count -gt 0 }

        if ($u.Host -eq 'graph.microsoft.com') {
            if ($Method -eq 'GET' -and $path -eq '/v1.0/me') { return Reply 200 $s.Me }
            if ($Method -eq 'GET' -and $path -eq '/v1.0/me/transitiveMemberOf/microsoft.graph.directoryRole') {
                return Reply 200 @{ value = @($s.EntraRoles | ForEach-Object { @{ roleTemplateId = $_; displayName = "Rolle $_" } }) }
            }
            if ($Method -eq 'GET' -and $path -eq '/v1.0/subscribedSkus') {
                # Licences: P2 only counts on an active SKU (the suspended one must not count).
                if ($s.P2 -eq 'hidden') { return Err 403 'Authorization_RequestDenied' }
                $plans = @(@{ servicePlanName = 'AAD_PREMIUM'; provisioningStatus = 'Success' })
                if ($s.P2 -eq 'yes') { $plans += @{ servicePlanName = 'AAD_PREMIUM_P2'; provisioningStatus = 'Success' } }
                return Reply 200 @{ value = @(@{ skuPartNumber = 'TEST_SKU'; capabilityStatus = 'Enabled'; servicePlans = $plans }, @{ skuPartNumber = 'OLD_P2'; capabilityStatus = 'Suspended'; servicePlans = @(@{ servicePlanName = 'AAD_PREMIUM_P2'; provisioningStatus = 'Success' }) }) }
            }
            if ($Method -eq 'GET' -and $path -eq '/v1.0/policies/authorizationPolicy') { return Reply 200 @{ defaultUserRolePermissions = @{ allowedToCreateSecurityGroups = $s.UsersCreateGroups } } }
            if ($Method -eq 'GET' -and $path -eq '/v1.0/groups') {
                if ($query -notmatch "displayName eq '((?:[^']|'')*)'") { return Err 400 'filter' }
                $name = $Matches[1].Replace("''", "'")
                $hits = @($s.Groups.Keys | Where-Object { $s.Groups[$_].displayName -eq $name } | ForEach-Object { $g = $s.Groups[$_]; @{ id = $_; displayName = $g.displayName; securityEnabled = $g.securityEnabled; mailEnabled = $g.mailEnabled } })
                return Reply 200 @{ value = $hits }
            }
            if ($Method -eq 'POST' -and $path -eq '/v1.0/groups') {
                $allowed = $s.UsersCreateGroups -or @($s.EntraRoles | Where-Object { @('62e90394-69f5-4237-9190-012177145e10', 'fdd7a751-b60b-444a-984c-02652fe8fa1c', 'fe930be7-5e62-47db-91af-98c3a49a38b1') -contains $_ }).Count
                if (-not $allowed) { return Err 403 'Authorization_RequestDenied' }
                if (-not $body.securityEnabled -or $body.mailEnabled -or -not $body.mailNickname) { return Err 400 'bad group' }
                $id = [guid]::NewGuid().ToString()
                $s.Groups[$id] = @{ displayName = $body.displayName; securityEnabled = $true; mailEnabled = $false; description = $body.description }
                return Reply 201 @{ id = $id; displayName = $body.displayName }
            }
        }
        if ($u.Host -eq 'management.azure.com') {
            $sub = "/subscriptions/$($s.Sub)"
            if ($path -eq "$sub/providers/Microsoft.Authorization/roleAssignments" -and $Method -eq 'GET') {
                if ($query -notmatch "assignedTo\('$($s.Me.id)'\)") { return Err 400 'filter' }
                return Reply 200 @{ value = @($s.AzureRoles | ForEach-Object { @{ properties = @{ scope = $sub; principalId = $s.Me.id; roleDefinitionId = "$sub/providers/Microsoft.Authorization/roleDefinitions/$_" } } }) }
            }
            if ($path -eq "$sub/providers/Microsoft.KeyVault/checkNameAvailability" -and $Method -eq 'POST') {
                $taken = $s.Vaults.ContainsKey($body.name.ToLowerInvariant()) -or ($s.TakenNames -contains $body.name.ToLowerInvariant())
                return Reply 200 @{ nameAvailable = (-not $taken) }
            }
            if ($path -match "^$([regex]::Escape($sub))/resourceGroups/([^/]+)$") {
                $rg = $Matches[1].ToLowerInvariant()
                if ($Method -eq 'GET') { if ($s.ResourceGroups.ContainsKey($rg)) { return Reply 200 @{ id = $path; location = $s.ResourceGroups[$rg] } } else { return Err 404 'ResourceGroupNotFound' } }
                if ($Method -eq 'PUT') {
                    if (-not (& $hasRole @('8e3af657-a8ff-443c-a75c-2fe8c4bcb635', 'b24988ac-6180-42a0-ab88-20f7382dd24c'))) { return Err 403 'AuthorizationFailed' }
                    $s.ResourceGroups[$rg] = $body.location
                    return Reply 201 @{ id = $path; location = $body.location }
                }
            }
            if ($path -match "^$([regex]::Escape($sub))/resourceGroups/([^/]+)/providers/Microsoft\.KeyVault/vaults/([^/]+)(/providers/Microsoft\.Authorization/roleAssignments(?:/([^/]+))?)?$") {
                $rg = $Matches[1].ToLowerInvariant(); $name = $Matches[2].ToLowerInvariant(); $ra = $Matches[3]; $raName = $Matches[4]
                $vault = $s.Vaults[$name]
                if ($vault -and $vault.rg -ne $rg) { $vault = $null }
                $vaultId = "$sub/resourceGroups/$rg/providers/Microsoft.KeyVault/vaults/$name"
                if (-not $ra) {
                    if ($Method -eq 'GET') {
                        if (-not $vault) { return Err 404 'ResourceNotFound' }
                        return Reply 200 @{ id = $path; location = $vault.location; tags = $vault.tags; properties = @{ enableRbacAuthorization = $vault.rbac; enableSoftDelete = $true; softDeleteRetentionInDays = $vault.softDeleteDays; enablePurgeProtection = $vault.purge; publicNetworkAccess = $vault.publicNetworkAccess; provisioningState = 'Succeeded'; vaultUri = "https://$name.vault.azure.net/" } }
                    }
                    if ($Method -eq 'PUT') {
                        if (-not (& $hasRole @('8e3af657-a8ff-443c-a75c-2fe8c4bcb635', 'b24988ac-6180-42a0-ab88-20f7382dd24c'))) { return Err 403 'AuthorizationFailed' }
                        if (-not $s.ResourceGroups.ContainsKey($rg)) { return Err 404 'ResourceGroupNotFound' }
                        if ($vault) { return Err 409 'exists' }
                        $s.Vaults[$name] = @{ rg = $rg; location = $body.location; softDeleteDays = $body.properties.softDeleteRetentionInDays; publicNetworkAccess = $body.properties.publicNetworkAccess; rbac = [bool] $body.properties.enableRbacAuthorization; purge = [bool] $body.properties.enablePurgeProtection; tenantId = $body.properties.tenantId; tags = @{ kvpwsafe = $body.tags.kvpwsafe; 'kvpwsafe-name' = $body.tags.'kvpwsafe-name' } }
                        return Reply 200 @{ id = $path; properties = @{ provisioningState = 'Succeeded' } }
                    }
                }
                else {
                    if (-not $vault) { return Err 404 'ResourceNotFound' }
                    if ($Method -eq 'GET' -and -not $raName) {
                        return Reply 200 @{ value = @($s.Assignments.Keys | Where-Object { $s.Assignments[$_].scope -eq $vaultId } | ForEach-Object { $a = $s.Assignments[$_]; @{ name = $_; properties = @{ scope = $a.scope; principalId = $a.principalId; roleDefinitionId = $a.roleDefinitionId } } }) }
                    }
                    if ($Method -eq 'PUT' -and $raName) {
                        if (-not (& $hasRole @('8e3af657-a8ff-443c-a75c-2fe8c4bcb635', '18d7d88d-d35e-4fb5-a5c3-7773c20a72d9', 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'))) { return Err 403 'AuthorizationFailed' }
                        if ($s.Assignments.ContainsKey($raName)) { return Err 409 'RoleAssignmentExists' }
                        if (-not $s.Groups.ContainsKey($body.properties.principalId)) { return Err 400 'PrincipalNotFound' }
                        $s.Assignments[$raName] = @{ scope = $vaultId; principalId = $body.properties.principalId; roleDefinitionId = ([string] $body.properties.roleDefinitionId).ToLowerInvariant(); principalType = $body.properties.principalType }
                        return Reply 201 @{ name = $raName }
                    }
                }
            }
        }
        [void] $s.Unknown.Add("$Method $Uri")
        return Err 400 'Attrappe kennt die Anfrage nicht'
    }.GetNewClosure()
    return @{ State = $state; Transport = $transport }
}
