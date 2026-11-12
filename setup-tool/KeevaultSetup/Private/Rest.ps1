# Transport and sign-in context. Every ARM and Graph request goes through Invoke-KsRest.

$script:KsArm = 'https://management.azure.com'
$script:KsGraph = 'https://graph.microsoft.com/v1.0'
$script:KsSleepSeconds = 2
$script:KsCtx = $null
$script:KsTransport = {
    param([string] $Method, [string] $Uri, [string] $Payload)
    $params = @{ Method = $Method; Uri = $Uri }
    if ($Payload) { $params.Payload = $Payload }
    # The engine decides about dry run and confirmation itself; reads must also run during -WhatIf.
    $cmd = Get-Command Invoke-AzRestMethod
    if ($cmd.Parameters.ContainsKey('WhatIf')) { $params.WhatIf = $false }
    if ($cmd.Parameters.ContainsKey('Confirm')) { $params.Confirm = $false }
    $r = Invoke-AzRestMethod @params
    [pscustomobject]@{ StatusCode = [int] $r.StatusCode; Content = [string] $r.Content }
}

function Invoke-KsRest {
    # Returns @{ Status; Body }. Status codes listed in -Ok come back instead of throwing (e.g. 404 = not there yet).
    param([string] $Method, [string] $Uri, $Body, [int[]] $Ok = @())
    $payload = $null
    if ($null -ne $Body) { $payload = $Body | ConvertTo-Json -Depth 20 -Compress }
    $r = & $script:KsTransport $Method $Uri $payload
    $parsed = $null
    if ($r.Content) { try { $parsed = $r.Content | ConvertFrom-Json } catch { $parsed = $null } }
    if ($r.StatusCode -ge 400 -and $Ok -notcontains $r.StatusCode) {
        $msg = ''
        if ($parsed -and $parsed.PSObject.Properties['error'] -and $parsed.error.PSObject.Properties['message']) { $msg = ": $($parsed.error.message)" }
        $err = New-Object System.Exception (KsT 'rest.failed' $Method (Get-KsShortUri $Uri) $r.StatusCode $msg)
        $err.Data['StatusCode'] = $r.StatusCode
        throw $err
    }
    return @{ Status = $r.StatusCode; Body = $parsed }
}

function Get-KsShortUri([string] $Uri) {
    # Error texts name the path without the host and query, so no token or filter value ends up in a log.
    $u = $Uri -replace '^https://[^/]+', ''
    return ($u -split '\?')[0]
}

function Connect-KeevaultSetup {
    <#
    .SYNOPSIS
        Meldet den Administrator mit Az.Accounts an (wie infra/) und merkt Tenant und Subscription.
    #>
    [CmdletBinding()]
    param([string] $TenantId, [string] $SubscriptionId)
    if (-not (Get-Module -ListAvailable -Name Az.Accounts)) {
        throw (KsT 'rest.noAz')
    }
    Import-Module Az.Accounts -ErrorAction Stop | Out-Null
    $ctx = Get-AzContext
    if (-not $ctx -or ($TenantId -and $ctx.Tenant.Id -ne $TenantId)) {
        $p = @{}
        if ($TenantId) { $p.Tenant = $TenantId }
        Connect-AzAccount @p | Out-Null
        $ctx = Get-AzContext
    }
    if ($SubscriptionId -and (-not $ctx.Subscription -or $ctx.Subscription.Id -ne $SubscriptionId)) {
        Set-AzContext -Subscription $SubscriptionId | Out-Null
        $ctx = Get-AzContext
    }
    $sub = ''
    if ($ctx.Subscription) { $sub = [string] $ctx.Subscription.Id }
    $script:KsCtx = @{ TenantId = [string] $ctx.Tenant.Id; SubscriptionId = $sub; Account = [string] $ctx.Account.Id }
    return Get-KeevaultSetupContext
}

function Set-KeevaultSetupTransport {
    <#
    .SYNOPSIS
        Ersetzt den Transport (Tests, Attrappe). Der Scriptblock bekommt Method, Uri, Payload und liefert
        StatusCode und Content wie Invoke-AzRestMethod.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][scriptblock] $Transport,
        [string] $TenantId = '',
        [string] $SubscriptionId = '',
        [string] $Account = '',
        [int] $SleepSeconds = 0
    )
    $script:KsTransport = $Transport
    $script:KsSleepSeconds = $SleepSeconds
    $script:KsCtx = @{ TenantId = $TenantId; SubscriptionId = $SubscriptionId; Account = $Account }
}

function Get-KeevaultSetupContext {
    if (-not $script:KsCtx) { return [pscustomobject]@{ SignedIn = $false; TenantId = ''; SubscriptionId = ''; Account = '' } }
    return [pscustomobject]@{ SignedIn = $true; TenantId = $script:KsCtx.TenantId; SubscriptionId = $script:KsCtx.SubscriptionId; Account = $script:KsCtx.Account }
}

function Assert-KsSignedIn {
    if (-not $script:KsCtx) { throw (KsT 'rest.notSignedIn') }
}
