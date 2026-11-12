# Check against public frameworks (#501 part e): the Keevault-relevant controls of CIS Microsoft Azure Foundations,
# CIS Microsoft 365 Foundations and CISA SCuBA (Entra ID), as versioned data in Data/controls.json. Read-only. Wording
# is always "geprüft gegen Kontrolle X", never "compliant" or "certified"; what cannot be checked automatically is a
# manual item, and a check that could not read its data says so ("nicht geprüft") instead of guessing.

$script:KsControls = $null
$script:KsGlobalAdmin = '62e90394-69f5-4237-9190-012177145e10'
$script:KsPhishingResistant = '00000000-0000-0000-0000-000000000004'

function Get-KsControls {
    if ($script:KsControls) { return $script:KsControls }
    $file = Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'Data') 'controls.json'
    $script:KsControls = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8).TrimStart([char] 0xFEFF) | ConvertFrom-Json
    return $script:KsControls
}

function Get-KsLang2($Pair) {
    if ($script:KsLang -eq 'en') { return [string] $Pair[1] }
    return [string] $Pair[0]
}

function Get-KsCaPolicies($Cache) {
    if (-not $Cache.ContainsKey('ca')) {
        $r = Invoke-KsRest GET "$($script:KsGraph)/identity/conditionalAccess/policies" -Ok 400, 401, 403, 404
        $Cache['ca'] = $(if ($r.Status -lt 400) { @($r.Body.value | Where-Object { $_ }) } else { $null })
    }
    return $Cache['ca']
}

function Test-KsCaAllUsers($Policy) {
    return ([string] $Policy.state -eq 'enabled' -and @($Policy.conditions.users.includeUsers) -contains 'All')
}

function Invoke-KsControl($Control, $Plan, [string] $Sub, $Cache) {
    # -> @(Status, Detail); Status: pass, fail, deviation, manual, notChecked.
    $vaultCheck = @('vaultRbac', 'vaultRecoverable', 'vaultLogging', 'vaultPrivate') -contains [string] $Control.check
    if ($vaultCheck) {
        if (-not $Sub) { return @('notChecked', (KsT 'read.noSub')) }
        if (-not @($Plan.vaults).Count) { return @('notChecked', (KsT 'cc.noVaults')) }
        $bad = @(); $unread = @(); $deviation = @()
        foreach ($v in $Plan.vaults) {
            $vs = Get-KsVaultState $Plan $Sub $v.name $Cache
            if ($vs.Status -eq 404) { $unread += (KsT 'cc.vaultMissing' $v.name); continue }
            if ($vs.Status -ge 400) { $unread += (KsT 'cc.vaultHidden' $v.name); continue }
            $p = Get-KsProp $vs.Body 'properties'
            switch ([string] $Control.check) {
                'vaultRbac' { if (-not (Get-KsProp $p 'enableRbacAuthorization')) { $bad += $v.name } }
                'vaultRecoverable' { if ((Get-KsProp $p 'enableSoftDelete') -eq $false -or -not (Get-KsProp $p 'enablePurgeProtection')) { $bad += $v.name } }
                'vaultPrivate' {
                    $private = [string] (Get-KsProp $p 'publicNetworkAccess') -eq 'Disabled' -or @(Get-KsProp $p 'privateEndpointConnections' | Where-Object { $_ }).Count -gt 0
                    if (-not $private) { $deviation += $v.name }
                }
                'vaultLogging' {
                    $r = Invoke-KsRest GET "$($script:KsArm)$($vs.Id)/providers/Microsoft.Insights/diagnosticSettings?api-version=2021-05-01-preview" -Ok 400, 403, 404
                    if ($r.Status -ge 400) { $unread += (KsT 'cc.vaultHidden' $v.name); continue }
                    $on = $false
                    foreach ($s in @($r.Body.value | Where-Object { $_ })) {
                        $sp = $s.properties
                        $dest = (Get-KsProp $sp 'workspaceId') -or (Get-KsProp $sp 'storageAccountId') -or (Get-KsProp $sp 'eventHubAuthorizationRuleId')
                        foreach ($log in @(Get-KsProp $sp 'logs')) {
                            if ($log -and $log.enabled -and $dest -and ([string] (Get-KsProp $log 'category') -eq 'AuditEvent' -or @('audit', 'allLogs') -contains [string] (Get-KsProp $log 'categoryGroup'))) { $on = $true }
                        }
                    }
                    if (-not $on) { $bad += $v.name }
                }
            }
        }
        if ($bad.Count) { return @('fail', (KsT 'cc.vaultsBad' ($bad -join ', '))) }
        if ($unread.Count) { return @('notChecked', ($unread -join '; ')) }
        if ($deviation.Count) { return @('deviation', (KsT 'cc.vaultsPublic' ($deviation -join ', '))) }
        return @('pass', (KsT 'cc.vaultsOk' (@($Plan.vaults | ForEach-Object { $_.name }) -join ', ')))
    }
    switch ([string] $Control.check) {
        'secretExpiry' { return @('deviation', (KsT 'cc.keevaultDesign')) }
        'manual' { return @('manual', '') }
        'globalAdmins' {
            if (-not $Cache.ContainsKey('ga')) {
                $r = Invoke-KsRest GET "$($script:KsGraph)/directoryRoles(roleTemplateId='$($script:KsGlobalAdmin)')/members?`$select=id" -Ok 400, 401, 403, 404
                $Cache['ga'] = $(if ($r.Status -lt 400) { @($r.Body.value | Where-Object { $_ }).Count } elseif ($r.Status -eq 404) { 0 } else { $null })
            }
            $n = $Cache['ga']
            if ($null -eq $n) { return @('notChecked', (KsT 'cc.noGraph')) }
            if ($n -ge [int] $Control.min -and $n -le [int] $Control.max) { return @('pass', (KsT 'cc.gaCount' $n)) }
            return @('fail', (KsT 'cc.gaCount' $n))
        }
        'phishingResistantMfa' {
            $ca = Get-KsCaPolicies $Cache
            if ($null -eq $ca) { return @('notChecked', (KsT 'cc.noCa')) }
            $hit = @($ca | Where-Object { (Test-KsCaAllUsers $_) -and [string] $_.grantControls.authenticationStrength.id -eq $script:KsPhishingResistant })
            if ($hit.Count) { return @('pass', (KsT 'cc.policy' (($hit | ForEach-Object { $_.displayName }) -join ', '))) }
            return @('fail', (KsT 'cc.noPolicy'))
        }
        'legacyAuthBlocked' {
            $ca = Get-KsCaPolicies $Cache
            if ($null -eq $ca) { return @('notChecked', (KsT 'cc.noCa')) }
            $hit = @($ca | Where-Object { (Test-KsCaAllUsers $_) -and @($_.conditions.clientAppTypes) -contains 'exchangeActiveSync' -and @($_.conditions.clientAppTypes) -contains 'other' -and @($_.grantControls.builtInControls) -contains 'block' })
            if ($hit.Count) { return @('pass', (KsT 'cc.policy' (($hit | ForEach-Object { $_.displayName }) -join ', '))) }
            return @('fail', (KsT 'cc.noPolicy'))
        }
        'userConsent' {
            $r = Invoke-KsRest GET "$($script:KsGraph)/policies/authorizationPolicy?`$select=defaultUserRolePermissions" -Ok 400, 401, 403, 404
            if ($r.Status -ge 400 -or -not $r.Body.defaultUserRolePermissions) { return @('notChecked', (KsT 'cc.noGraph')) }
            $self = @(@($r.Body.defaultUserRolePermissions.permissionGrantPoliciesAssigned) | Where-Object { [string] $_ -like 'ManagePermissionGrantsForSelf.*' })
            if ($self.Count) { return @('fail', (KsT 'cc.consent' ($self -join ', '))) }
            return @('pass', (KsT 'cc.consentAdmins'))
        }
    }
    return @('notChecked', (KsT 'cc.unknownCheck' ([string] $Control.check)))
}

function Test-KeevaultSetupCompliance {
    <#
    .SYNOPSIS
        Prüft die Keevault-relevanten Empfehlungen aus CIS Azure, CIS Microsoft 365 und CISA SCuBA (Data/controls.json).
        Liest nur. Ergebnis je Kontrolle: erfüllt, nicht erfüllt, begründete Abweichung, manuell, nicht geprüft.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory)] $Plan)
    Assert-KsSignedIn
    $check = Test-KeevaultSetupPlan $Plan
    if (-not $check.Valid) { throw (KsT 'plan.invalid' ($check.Errors -join ' ')) }
    $p = $check.Plan
    $sub = $p.target.subscriptionId
    if (-not $sub) { $sub = $script:KsCtx.SubscriptionId }
    $catalog = Get-KsControls
    $cache = @{}
    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($c in $catalog.controls) {
        $fw = $catalog.frameworks.([string] $c.framework)
        try { $res = Invoke-KsControl $c $p $sub $cache }
        catch { $res = @('notChecked', $_.Exception.Message) }
        # CISA SCuBA in full ("geprüft gegen Kontrolle X"); own Keevault checks by name; CIS numbers only as an unverified
        # mapping, never as the control checked against (decision Lucas 2026-11-11, CIS terms of use not clarified).
        if ([string] $c.framework -eq 'keevault') { $ref = KsT 'cc.refOwn' }
        else { $ref = KsT 'cc.ref' $fw.name $fw.edition $c.control }
        $cisRef = ''
        if ($c.PSObject.Properties['cis'] -and $c.cis) {
            $cf = $catalog.frameworks.([string] $c.cis.framework)
            $cisRef = KsT 'cc.refCis' $cf.name $cf.edition $c.cis.control
            $ref = "$ref; $cisRef"
        }
        $rows.Add([pscustomobject]@{
                Id = [string] $c.id; Framework = [string] $fw.name; Edition = [string] $fw.edition; Control = [string] $c.control; Reference = $ref; CisMapping = $cisRef
                Title = (Get-KsLang2 $c.title); Why = (Get-KsLang2 $c.why); Status = $res[0]; StatusText = (KsT "cc.s.$($res[0])"); Detail = [string] $res[1]
            })
    }
    $summary = [ordered]@{}
    foreach ($s in 'pass', 'fail', 'deviation', 'manual', 'notChecked') { $summary[$s] = @($rows | Where-Object { $_.Status -eq $s }).Count }
    return [pscustomobject]@{
        Kind = 'compliance'; Time = (Get-Date).ToString('yyyy-MM-dd HH:mm'); Account = $script:KsCtx.Account; Language = $script:KsLang
        CatalogVersion = [string] $catalog.version; CisUnverified = [bool] @($rows | Where-Object { $_.CisMapping }).Count; Controls = $rows.ToArray(); Summary = $summary
    }
}

function New-KsCheckModel($Drift, $Compliance) {
    $doc = New-Object System.Collections.Generic.List[object]
    Add-KsB $doc 'h1' (KsT 'cr.title')
    $first = @($Drift, $Compliance | Where-Object { $_ })[0]
    Add-KsB $doc 'p' (KsT 'cr.stand' $first.Time $first.Account)
    Add-KsB $doc 'note' (KsT 'cr.readOnly')
    if ($Drift) {
        Add-KsB $doc 'h2' (KsT 'cr.drift')
        Add-KsB $doc 'p' (KsT 'cr.driftSum' $Drift.Summary.ok $Drift.Summary.missing $Drift.Summary.differs $Drift.Summary.extra $Drift.Summary.notChecked)
        Add-KsB $doc 'li' "$(KsT 'rep.hash'): $($Drift.PlanHash)"
        $rows = @($Drift.Items | Where-Object { $_.Status -ne 'ok' } | ForEach-Object { , @($_.StatusText, $_.Object, $_.Expected, $_.Actual, $_.Hint) })
        if ($rows.Count) { Add-KsB $doc 'table' '' @{ Head = @((KsT 'rep.status'), (KsT 'cr.object'), (KsT 'cr.expected'), (KsT 'cr.actual'), (KsT 'cr.hint')); Rows = $rows } }
        else { Add-KsB $doc 'p' (KsT 'cr.noDrift') }
        if ($Drift.FixByRun) { Add-KsB $doc 'note' (KsT 'cr.fixRun') }
    }
    if ($Compliance) {
        Add-KsB $doc 'h2' (KsT 'cr.compliance')
        Add-KsB $doc 'p' (KsT 'cr.ccSum' $Compliance.Summary.pass $Compliance.Summary.fail $Compliance.Summary.deviation $Compliance.Summary.manual $Compliance.Summary.notChecked)
        Add-KsB $doc 'p' (KsT 'cr.catalog' $Compliance.CatalogVersion)
        if ($Compliance.CisUnverified) { Add-KsB $doc 'note' (KsT 'cr.cisHint') }
        foreach ($c in $Compliance.Controls) {
            $text = "$($c.StatusText): $($c.Title) ($($c.Reference))"
            Add-KsB $doc 'check' $text @{ Done = ($c.Status -eq 'pass'); Sub = @(@($c.Detail, $c.Why) | Where-Object { $_ }) }
        }
    }
    return $doc
}

function New-KeevaultSetupCheckReport {
    <#
    .SYNOPSIS
        Bericht zur Drift-Prüfung und/oder zur Prüfung gegen CIS/CISA: Markdown, HTML zum Drucken oder DOCX.
    #>
    [CmdletBinding()]
    param($Drift, $Compliance, [ValidateSet('Markdown', 'Html', 'Docx')][string] $Format = 'Markdown')
    if (-not $Drift -and -not $Compliance) { throw (KsT 'cr.nothing') }
    $lang = $script:KsLang
    $from = @($Drift, $Compliance | Where-Object { $_ })[0]
    if ($from.PSObject.Properties['Language'] -and @('de', 'en') -contains $from.Language) { $script:KsLang = $from.Language }
    try {
        $model = New-KsCheckModel $Drift $Compliance
        $md = ConvertTo-KsMarkdown $model
        $why = Test-KsSecretLike $md
        if ($why) { throw (KsT 'rep.secret' $why) }
        if ($Format -eq 'Html') { return (ConvertTo-KsHtml $model (KsT 'cr.title') $script:KsLang) }
        if ($Format -eq 'Docx') { return , (ConvertTo-KsDocx $model (KsT 'cr.title') $script:KsLang) }
        return $md
    }
    finally { $script:KsLang = $lang }
}
