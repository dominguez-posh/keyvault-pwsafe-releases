# Documentation (#501 part b): one document model from plan and result, rendered as Markdown, printable HTML or DOCX
# (Render.ps1). Environment, vaults, groups and roles, done/skipped/manual steps, answers, notes and deviations, and
# the emergency handbook. Never secrets: the tool asks for none, the answers pass the secret check, and the finished
# text is checked again before any format is returned.

function Add-KsB($Doc, [string] $Type, [string] $Text = '', [hashtable] $More = @{}) {
    $b = @{ T = $Type; X = $Text }
    foreach ($k in $More.Keys) { $b[$k] = $More[$k] }
    $Doc.Add($b)
}

function Get-KsAnswer($Plan, [string] $Id) {
    $a = $Plan.answers[$Id]
    if (-not $a) { return (KsT 'rep.open') }
    return $a
}

function New-KsReportModel($Result) {
    $p = $Result.Plan
    $doc = New-Object System.Collections.Generic.List[object]
    $steps = @($Result.Steps)
    Add-KsB $doc 'h1' (KsT 'rep.title')
    $kind = KsT 'rep.run'
    if ($Result.DryRun) { $kind = KsT 'rep.dry' }
    Add-KsB $doc 'p' (KsT 'rep.stand' $Result.Time $kind $Result.Account)
    Add-KsB $doc 'note' (KsT 'rep.owner')

    Add-KsB $doc 'h2' (KsT 'rep.env')
    $tenant = $p.target.tenantId; if (-not $tenant) { $tenant = KsT 'rep.fromSignIn' }
    $sub = $p.target.subscriptionId; if (-not $sub) { $sub = KsT 'rep.fromSignIn' }
    $p2 = KsT 'rep.p2.unknown'
    if ($Result.EntraP2 -eq $true) { $p2 = KsT 'rep.p2.yes' } elseif ($Result.EntraP2 -eq $false) { $p2 = KsT 'rep.p2.no' }
    Add-KsB $doc 'li' "$(KsT 'rep.tenant'): $tenant"
    Add-KsB $doc 'li' "$(KsT 'rep.sub'): $sub"
    Add-KsB $doc 'li' "$(KsT 'rep.rg'): $($p.resourceGroup) ($(KsT 'rep.region') $($p.target.location))"
    Add-KsB $doc 'li' "$(KsT 'rep.pattern'): $($p.groupPattern)"
    Add-KsB $doc 'li' "$(KsT 'rep.p2'): $p2"
    Add-KsB $doc 'li' "$(KsT 'rep.hash'): $($Result.PlanHash)"
    if ($Result.ToolVersion) { Add-KsB $doc 'li' "$(KsT 'rep.tool'): $($Result.ToolVersion)" }

    if (@($p.vaults).Count) {
        Add-KsB $doc 'h2' (KsT 'rep.vaults')
        $rows = New-Object System.Collections.Generic.List[object]
        foreach ($v in $p.vaults) {
            $st = @($steps | Where-Object { $_.Id -eq "vault:$($v.name)" })[0]
            $status = ''; if ($st) { $status = $st.StatusText }
            $rows.Add(@($v.name, $v.displayName, $status))
        }
        Add-KsB $doc 'table' '' @{ Head = @((KsT 'rep.vaultName'), (KsT 'rep.display'), (KsT 'rep.status')); Rows = $rows.ToArray() }
    }

    $groupSteps = @($steps | Where-Object { $_.Key -eq 'groups' -and $_.Status -ne 'skipped' })
    if ($groupSteps.Count) {
        Add-KsB $doc 'h2' (KsT 'rep.groups')
        $rows = New-Object System.Collections.Generic.List[object]
        foreach ($g in $groupSteps) {
            foreach ($level in $script:KsLevels.Keys) {
                $rows.Add(@($g.Vault, (Get-KsGroupName $p $g.Vault $level), (($script:KsLevels[$level] | ForEach-Object { Get-KsRoleName $_ }) -join ', ')))
            }
        }
        Add-KsB $doc 'table' '' @{ Head = @((KsT 'rep.vault'), (KsT 'rep.group'), (KsT 'rep.roles')); Rows = $rows.ToArray() }
    }

    foreach ($s in @(@('done', @('done')), @('planned', @('planned')), @('noRight', @('noRight')), @('failed', @('failed', 'blocked')))) {
        $list = @($steps | Where-Object { $s[1] -contains $_.Status })
        if (-not $list.Count) { continue }
        Add-KsB $doc 'h2' (KsT "rep.sec.$($s[0])")
        foreach ($st in $list) {
            $text = $st.Title
            if ($st.Detail) { $text += ": $($st.Detail)" }
            Add-KsB $doc 'check' $text @{ Done = ($st.Status -eq 'done'); Sub = @($st.Actions) }
        }
    }

    $manual = @($steps | Where-Object { $_.Status -eq 'manual' })
    if ($manual.Count) {
        Add-KsB $doc 'h2' (KsT 'rep.manual')
        foreach ($st in $manual) {
            Add-KsB $doc 'h3' $st.Title
            if ($st.Detail) { Add-KsB $doc 'p' $st.Detail }
            if ($st.Text) { Add-KsB $doc 'p' $st.Text }
            Add-KsB $doc 'check' (KsT 'rep.sign') @{ Done = $false }
        }
    }

    $skipped = @($steps | Where-Object { $_.Status -eq 'skipped' })
    if ($skipped.Count) {
        Add-KsB $doc 'h2' (KsT 'rep.skipped')
        foreach ($st in $skipped) { Add-KsB $doc 'li' $st.Title }
    }

    $questions = @($steps | Where-Object { $_.Status -ne 'skipped' } | ForEach-Object { $_.Questions } | Where-Object { $_ })
    if ($questions.Count) {
        Add-KsB $doc 'h2' (KsT 'rep.answers')
        foreach ($q in $questions) {
            $answer = $q.Answer; if (-not $answer) { $answer = KsT 'rep.open' }
            Add-KsB $doc 'li' $q.Text @{ Sub = @($answer) }
        }
    }

    Add-KsDevicePolicyReport $doc $p

    # Notes and deviations: what differs from the recommended setup, so a reviewer sees it without reading every step.
    Add-KsB $doc 'h2' (KsT 'rep.deviations')
    $dev = New-Object System.Collections.Generic.List[string]
    foreach ($st in $steps) {
        if ($st.Status -eq 'skipped') { $dev.Add((KsT 'rep.dev.skipped' $st.Title)) }
        elseif ($st.Status -eq 'info') { $dev.Add((KsT 'rep.dev.status' $st.Title $st.Detail)) }
        elseif (@('failed', 'blocked', 'noRight') -contains $st.Status -or ($st.Kind -eq 'auto' -and $st.Status -eq 'manual')) {
            $dev.Add((KsT 'rep.dev.status' $st.Title "$($st.StatusText) – $($st.Detail)"))
        }
    }
    foreach ($q in $questions) { if (-not $q.Answer) { $dev.Add((KsT 'rep.dev.question' $q.Text)) } }
    if (-not $dev.Count) { $dev.Add((KsT 'rep.dev.none')) }
    foreach ($d in $dev) { Add-KsB $doc 'li' $d }

    if (@($steps | Where-Object { $_.Key -eq 'emergencyHandbook' -and $_.Status -ne 'skipped' }).Count) { Add-KsHandbook $doc $p }
    return $doc.ToArray()
}

function Add-KsHandbook($Doc, $Plan) {
    Add-KsB $Doc 'break'
    Add-KsB $Doc 'h1' (KsT 'hb.title')
    Add-KsB $Doc 'note' (KsT 'hb.intro')
    Add-KsB $Doc 'h2' (KsT 'hb.bg')
    Add-KsB $Doc 'li' "$(KsT 'hb.bg.where'): $(Get-KsAnswer $Plan 'breakGlassFidoLocation')"
    Add-KsB $Doc 'li' "$(KsT 'hb.bg.who'): $(Get-KsAnswer $Plan 'breakGlassAccess')"
    foreach ($i in 1..4) { Add-KsB $Doc 'num' (KsT "hb.bg.$i") @{ N = $i } }
    Add-KsB $Doc 'h2' (KsT 'hb.rk')
    Add-KsB $Doc 'li' "$(KsT 'hb.rk.where'): $(Get-KsAnswer $Plan 'recoveryKeyLocation')"
    Add-KsB $Doc 'p' (KsT 'hb.rk.only')
    Add-KsB $Doc 'p' (KsT 'hb.rk.used')
    Add-KsB $Doc 'h2' (KsT 'hb.leave')
    $groups = @(foreach ($v in $Plan.vaults) { foreach ($level in $script:KsLevels.Keys) { Get-KsGroupName $Plan $v.name $level } })
    if (-not $groups.Count) { $groups = @($Plan.groupPattern) }
    $n = 0
    foreach ($k in 'hb.leave.1', 'hb.leave.2', 'hb.leave.3', 'hb.leave.4', 'hb.leave.5', 'hb.leave.6') {
        $n++
        $text = KsT $k
        if ($k -eq 'hb.leave.2') { $text = KsT $k ($groups -join ', ') }
        Add-KsB $Doc 'num' $text @{ N = $n }
    }
    Add-KsB $Doc 'h2' (KsT 'hb.device')
    foreach ($i in 1..5) { Add-KsB $Doc 'num' (KsT "hb.device.$i") @{ N = $i } }
    Add-KsB $Doc 'h2' (KsT 'hb.contacts')
    Add-KsB $Doc 'li' "$(KsT 'hb.c.owner'): $(Get-KsAnswer $Plan 'contactOwner')"
    Add-KsB $Doc 'li' "$(KsT 'hb.c.incident'): $(Get-KsAnswer $Plan 'contactEmergency')"
    Add-KsB $Doc 'li' "$(KsT 'hb.c.ms'): $(KsT 'hb.c.msText')"
    Add-KsB $Doc 'h2' (KsT 'hb.check')
    foreach ($i in 1..7) { Add-KsB $Doc 'check' (KsT "hb.check.$i") @{ Done = $false } }
    Add-KsB $Doc 'p' (KsT 'hb.checked')
}

function New-KeevaultSetupReport {
    <#
    .SYNOPSIS
        Doku zu einem Probelauf oder Lauf mit Notfallhandbuch: Markdown (Standard), HTML zum Drucken oder DOCX.
        Enthält Tenant-Daten: Dokument des Kunden, geschützt ablegen. Sprache = Sprache des Laufs.
    .EXAMPLE
        $result = Invoke-KeevaultSetup -Plan $plan -WhatIf
        New-KeevaultSetupReport -Result $result -Format Html -Path .\Keevault-Einrichtung.html
    .OUTPUTS
        Text (Markdown, Html) oder byte[] (Docx).
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] $Result, [ValidateSet('Markdown', 'Html', 'Docx')][string] $Format = 'Markdown', [string] $Path)
    $lang = $script:KsLang
    if ($Result.PSObject.Properties['Language'] -and @('de', 'en') -contains $Result.Language) { $script:KsLang = $Result.Language }
    try {
        $model = New-KsReportModel $Result
        $md = ConvertTo-KsMarkdown $model
        # One check for every format: all formats show the same blocks, and the Markdown holds all their text.
        $why = Test-KsSecretLike $md
        if ($why) { throw (KsT 'rep.secret' $why) }
        $out = $md
        if ($Format -eq 'Html') { $out = ConvertTo-KsHtml $model (KsT 'rep.title') $script:KsLang }
        if ($Format -eq 'Docx') { $out = ConvertTo-KsDocx $model (KsT 'rep.title') $script:KsLang }
        if ($Path -and $PSCmdlet.ShouldProcess($Path, (KsT 'rep.write'))) {
            if ($out -is [byte[]]) { [System.IO.File]::WriteAllBytes($Path, $out) }
            else { [System.IO.File]::WriteAllText($Path, $out, (New-Object System.Text.UTF8Encoding $false)) }
        }
        if ($out -is [byte[]]) { return , $out }
        return $out
    }
    finally { $script:KsLang = $lang }
}
