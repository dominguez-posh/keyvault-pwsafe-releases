# The plan: what the admin chose. Exported and imported as JSON, validated strictly, never contains secrets.

$script:KsPlanSchema = 'keevault-setup-plan'
$script:KsStepIds = @('subscriptionTip', 'resourceGroup', 'vaults', 'groups', 'roles', 'pim', 'breakGlass', 'conditionalAccess', 'emergencyHandbook')
# Answers are free text checked for secrets: places, names and phone numbers, never PINs, passwords or keys.
$script:KsQuestionIds = @('breakGlassFidoLocation', 'breakGlassAccess', 'recoveryKeyLocation', 'contactOwner', 'contactEmergency')
$script:KsGuid = '^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$'
$script:KsMaxImportBytes = 262144

function ConvertTo-KsHashtable($Value) {
    # ConvertFrom-Json gives PSCustomObject in PowerShell 5.1 (no -AsHashtable): turn it into plain hashtables and
    # arrays so the validation sees every key, including unknown ones.
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        $h = [ordered]@{}
        foreach ($k in $Value.Keys) { $h[[string] $k] = ConvertTo-KsHashtable $Value[$k] }
        return $h
    }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        $h = [ordered]@{}
        foreach ($p in $Value.PSObject.Properties) { $h[$p.Name] = ConvertTo-KsHashtable $p.Value }
        return $h
    }
    if ($Value -is [string]) { return $Value }
    if ($Value -is [System.Collections.IEnumerable]) {
        $list = New-Object System.Collections.ArrayList
        foreach ($item in $Value) { [void] $list.Add((ConvertTo-KsHashtable $item)) }
        return , $list.ToArray()
    }
    return $Value
}

function Test-KsSecretLike([string] $Text, [switch] $FreeText) {
    # Heuristic guard for free text (answers, report): the tool asks for places ("Safe, Raum 2"), never for PINs,
    # passwords, recovery keys or tokens. Returns a reason or $null. -FreeText adds the check for long random-looking
    # words (typed answers only; generated names in the report would trip it).
    if (-not $Text) { return $null }
    if ($Text -match 'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}') { return (KsT 'secret.token') }
    if ($Text -match '-----BEGIN [A-Z ]+-----') { return (KsT 'secret.key') }
    if ($Text -match '(?i)\b(passw(or)?t|password|kennwort|pin|puk|secret|geheimnis|token|client.?secret|recovery.?key|wiederherstellungs\w*|schl(ü|ue)ssel|key)\b\s*[:=]\s*\S') { return (KsT 'secret.field') }
    if ($Text -match '(?i)\b(pin|puk)\b[^\d\r\n]{0,12}\d{4,}') { return (KsT 'secret.pin') }
    if (-not $FreeText) { return $null }
    $noGuid = $Text -replace '[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}', ' '
    foreach ($word in ($noGuid -split '[\s/\\,;()\[\]"''<>|`]+')) {
        if ($word.Length -ge 24 -and $word -match '[0-9]' -and $word -match '[A-Za-z]' -and $word -match '^[A-Za-z0-9+=_.~-]+$') { return (KsT 'secret.long') }
    }
    return $null
}

function New-KeevaultSetupPlan {
    <#
    .SYNOPSIS
        Erzeugt einen Plan mit Standardwerten. Alle Schritte sind ausgewählt.
    .EXAMPLE
        $plan = New-KeevaultSetupPlan -Vault 'kv-team-a' -ResourceGroup 'rg-keevault'
    #>
    [CmdletBinding()]
    param(
        [string[]] $Vault = @(),
        [string] $ResourceGroup = 'rg-keevault',
        [string] $Location = 'germanywestcentral',
        [string] $SubscriptionId = '',
        [string] $TenantId = '',
        [string] $GroupPattern = 'Keevault-{vault}-{level}'
    )
    $steps = [ordered]@{}
    foreach ($id in $script:KsStepIds) { $steps[$id] = $true }
    $answers = [ordered]@{}
    foreach ($id in $script:KsQuestionIds) { $answers[$id] = '' }
    $plan = [ordered]@{
        schema        = $script:KsPlanSchema
        version       = 1
        target        = [ordered]@{ tenantId = $TenantId; subscriptionId = $SubscriptionId; location = $Location }
        resourceGroup = $ResourceGroup
        groupPattern  = $GroupPattern
        vaults        = @($Vault | ForEach-Object { [ordered]@{ name = $_; displayName = $_ } })
        steps         = $steps
        answers       = $answers
    }
    $check = Test-KeevaultSetupPlan $plan
    if (-not $check.Valid) { throw ($check.Errors -join '; ') }
    return $check.Plan
}

function Test-KeevaultSetupPlan {
    <#
    .SYNOPSIS
        Prüft einen Plan streng (unbekannte Felder, Typen, Namen, Geheimnisse) und liefert ihn normalisiert zurück.
    .OUTPUTS
        @{ Valid; Errors; Plan }
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory, Position = 0)] $Plan)
    $errors = New-Object System.Collections.Generic.List[string]
    $p = ConvertTo-KsHashtable $Plan
    $out = $null
    if (-not ($p -is [System.Collections.IDictionary])) {
        $errors.Add((KsT 'plan.notObject'))
        return [pscustomobject]@{ Valid = $false; Errors = $errors.ToArray(); Plan = $null }
    }
    function Get-Unknown($Dict, [string[]] $Allowed, [string] $Where) {
        foreach ($k in $Dict.Keys) { if ($Allowed -notcontains $k) { $errors.Add((KsT 'plan.unknown' $k $Where)) } }
    }
    function Get-Str($Dict, [string] $Key, [string] $Where, [string] $Default = '') {
        if (-not $Dict.Contains($Key) -or $null -eq $Dict[$Key]) { return $Default }
        if (-not ($Dict[$Key] -is [string])) { $errors.Add((KsT 'plan.text' $Key $Where)); return $Default }
        return $Dict[$Key].Trim()
    }
    Get-Unknown $p @('schema', 'version', 'target', 'resourceGroup', 'groupPattern', 'vaults', 'steps', 'answers', 'devicePolicy') 'Plan'
    if ($p['schema'] -ne $script:KsPlanSchema) { $errors.Add((KsT 'plan.schema' $script:KsPlanSchema)) }
    if (-not ($p['version'] -is [int] -or $p['version'] -is [long]) -or $p['version'] -ne 1) { $errors.Add((KsT 'plan.version')) }

    $target = [ordered]@{ tenantId = ''; subscriptionId = ''; location = 'germanywestcentral' }
    if ($p.Contains('target')) {
        $t = $p['target']
        if (-not ($t -is [System.Collections.IDictionary])) { $errors.Add((KsT 'plan.target')) }
        else {
            Get-Unknown $t @('tenantId', 'subscriptionId', 'location') 'target'
            $target.tenantId = Get-Str $t 'tenantId' 'target'
            $target.subscriptionId = Get-Str $t 'subscriptionId' 'target'
            $target.location = Get-Str $t 'location' 'target' 'germanywestcentral'
        }
    }
    if ($target.tenantId -and $target.tenantId -notmatch $script:KsGuid) { $errors.Add((KsT 'plan.tenantGuid')) }
    if ($target.subscriptionId -and $target.subscriptionId -notmatch $script:KsGuid) { $errors.Add((KsT 'plan.subGuid')) }
    if ($target.location -notmatch '^[a-z0-9]{2,40}$') { $errors.Add((KsT 'plan.location')) }

    $rg = Get-Str $p 'resourceGroup' 'Plan'
    if ($rg -notmatch '^[A-Za-z0-9._()-]{1,90}$' -or $rg.EndsWith('.')) { $errors.Add((KsT 'plan.rg')) }

    $pattern = Get-Str $p 'groupPattern' 'Plan' 'Keevault-{vault}-{level}'
    if ($pattern -notmatch '^[A-Za-z0-9 ._{}-]{1,80}$' -or $pattern -notlike '*{vault}*' -or $pattern -notlike '*{level}*' -or ($pattern -replace '\{vault\}|\{level\}', '') -match '[{}]') {
        $errors.Add((KsT 'plan.pattern'))
    }

    $vaults = New-Object System.Collections.ArrayList
    $rawVaults = @()
    if ($p.Contains('vaults')) {
        if ($p['vaults'] -is [System.Collections.IDictionary] -or $p['vaults'] -is [string] -or -not ($p['vaults'] -is [System.Collections.IEnumerable])) { $errors.Add((KsT 'plan.vaultsList')) }
        else { $rawVaults = @($p['vaults']) }
    }
    if ($rawVaults.Count -gt 50) { $errors.Add((KsT 'plan.vaultsMax')) }
    $seen = @{}
    foreach ($v in $rawVaults) {
        if (-not ($v -is [System.Collections.IDictionary])) { $errors.Add((KsT 'plan.vaultObject')); continue }
        Get-Unknown $v @('name', 'displayName') 'vaults[]'
        $name = Get-Str $v 'name' 'vaults[]'
        $display = Get-Str $v 'displayName' 'vaults[]' $name
        if (-not $display) { $display = $name }
        if ($name -notmatch '^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$' -or $name -match '--') { $errors.Add((KsT 'plan.vaultName' $name)) }
        if ($display.Length -gt 64 -or $display -match '[\p{Cc}\p{Cf}\p{Co}<>]') { $errors.Add((KsT 'plan.displayName' $name)) }
        if ($seen.ContainsKey($name.ToLowerInvariant())) { $errors.Add((KsT 'plan.vaultTwice' $name)) }
        $seen[$name.ToLowerInvariant()] = $true
        [void] $vaults.Add([ordered]@{ name = $name; displayName = $display })
    }

    $steps = [ordered]@{}
    foreach ($id in $script:KsStepIds) { $steps[$id] = $true }
    if ($p.Contains('steps')) {
        $s = $p['steps']
        if (-not ($s -is [System.Collections.IDictionary])) { $errors.Add((KsT 'plan.steps')) }
        else {
            Get-Unknown $s $script:KsStepIds 'steps'
            foreach ($id in $script:KsStepIds) {
                if (-not $s.Contains($id)) { continue }
                if (-not ($s[$id] -is [bool])) { $errors.Add((KsT 'plan.stepBool' $id)) } else { $steps[$id] = $s[$id] }
            }
        }
    }

    $answers = [ordered]@{}
    foreach ($id in $script:KsQuestionIds) { $answers[$id] = '' }
    if ($p.Contains('answers')) {
        $a = $p['answers']
        if (-not ($a -is [System.Collections.IDictionary])) { $errors.Add((KsT 'plan.answers')) }
        else {
            Get-Unknown $a $script:KsQuestionIds 'answers'
            foreach ($id in $script:KsQuestionIds) {
                $text = Get-Str $a $id 'answers'
                if ($text.Length -gt 500) { $errors.Add((KsT 'plan.answerLength' $id)) }
                if ($text -match '[\x00-\x08\x0b\x0c\x0e-\x1f]') { $errors.Add((KsT 'plan.answerControl' $id)) }
                $why = Test-KsSecretLike $text -FreeText
                if ($why) { $errors.Add((KsT 'plan.answerSecret' $id $why)) }
                $answers[$id] = $text
            }
        }
    }

    # Device policies (part d, DevicePolicy.ps1): optional, missing = nothing chosen.
    $device = Test-KsDevicePolicy $p['devicePolicy'] $errors

    if ($errors.Count -eq 0) {
        $out = [ordered]@{
            schema        = $script:KsPlanSchema
            version       = 1
            target        = $target
            resourceGroup = $rg
            groupPattern  = $pattern
            vaults        = $vaults.ToArray()
            steps         = $steps
            answers       = $answers
            devicePolicy  = $device
        }
    }
    return [pscustomobject]@{ Valid = ($errors.Count -eq 0); Errors = $errors.ToArray(); Plan = $out }
}

function ConvertTo-KeevaultSetupPlanJson {
    <#
    .SYNOPSIS
        Plan als JSON. -Portable lässt Tenant, Subscription, Antworten und Tenant/Client-ID der Richtlinien weg (für einen anderen Tenant).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory, Position = 0)] $Plan, [switch] $Portable, [switch] $Compress)
    $check = Test-KeevaultSetupPlan $Plan
    if (-not $check.Valid) { throw ($check.Errors -join '; ') }
    $plan = $check.Plan
    if ($Portable) {
        $plan.target.tenantId = ''
        $plan.target.subscriptionId = ''
        foreach ($id in $script:KsQuestionIds) { $plan.answers[$id] = '' }
        $plan.devicePolicy.tenantId = ''
        $plan.devicePolicy.clientId = ''
    }
    if ($Compress) { return ($plan | ConvertTo-Json -Depth 10 -Compress) }
    return ($plan | ConvertTo-Json -Depth 10)
}

function Export-KeevaultSetupPlan {
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] $Plan, [Parameter(Mandatory)][string] $Path, [switch] $Portable)
    $json = ConvertTo-KeevaultSetupPlanJson $Plan -Portable:$Portable
    if ($PSCmdlet.ShouldProcess($Path, (KsT 'plan.export'))) {
        [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding $false))
    }
}

function Import-KeevaultSetupPlan {
    <#
    .SYNOPSIS
        Liest einen exportierten Plan. Bricht bei jedem Fehler ab (Größe, JSON, unbekannte Felder, Geheimnisse).
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory, ParameterSetName = 'Path')][string] $Path, [Parameter(Mandatory, ParameterSetName = 'Json')][string] $Json)
    if ($PSCmdlet.ParameterSetName -eq 'Path') {
        $item = Get-Item -LiteralPath $Path
        if ($item.Length -gt $script:KsMaxImportBytes) { throw (KsT 'plan.fileTooBig') }
        $Json = [System.IO.File]::ReadAllText($item.FullName, [System.Text.Encoding]::UTF8)
    }
    if ($Json.Length -gt $script:KsMaxImportBytes) { throw (KsT 'plan.textTooBig') }
    try { $raw = $Json | ConvertFrom-Json } catch { throw (KsT 'plan.noJson') }
    $check = Test-KeevaultSetupPlan $raw
    if (-not $check.Valid) { throw (KsT 'plan.invalid' ($check.Errors -join ' ')) }
    return $check.Plan
}

function Get-KeevaultSetupPlanHash {
    <#
    .SYNOPSIS
        Fingerabdruck des normalisierten Plans. Der Probelauf liefert ihn, das Ausführen verlangt ihn zurück.
    #>
    [CmdletBinding()]
    param([Parameter(Mandatory, Position = 0)] $Plan)
    $json = ConvertTo-KeevaultSetupPlanJson $Plan -Compress
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($json)) } finally { $sha.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-KsGroupName($Plan, [string] $Vault, [string] $Level) {
    return $Plan.groupPattern.Replace('{vault}', $Vault).Replace('{level}', $Level)
}
