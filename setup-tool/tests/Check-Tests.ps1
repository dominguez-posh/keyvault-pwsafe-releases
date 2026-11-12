# Scenarios for part e (#501): drift check and check against CIS/CISA, dot-sourced by Run-Tests.ps1 (uses its Assert,
# Throws, Use-Fake, New-TestPlan and the stub). Placeholder data only; the registry is a stand-in, nothing reads HKLM.

function New-CheckFake([switch] $NoCa, [int] $GlobalAdmins = 3, [switch] $Logging, [switch] $ConsentOpen) {
    # The stub of part a plus what only the checks read: diagnostic settings, Conditional Access, Global Admins.
    $fake = New-KsFake
    $fake.State.Ca = @(
        @{ displayName = 'Alle: Phishing-resistente MFA'; state = 'enabled'; conditions = @{ users = @{ includeUsers = @('All') }; clientAppTypes = @('all') }; grantControls = @{ builtInControls = @(); authenticationStrength = @{ id = '00000000-0000-0000-0000-000000000004' } } }
        @{ displayName = 'Nur Bericht: Legacy blockieren'; state = 'enabledForReportingButNotEnforced'; conditions = @{ users = @{ includeUsers = @('All') }; clientAppTypes = @('exchangeActiveSync', 'other') }; grantControls = @{ builtInControls = @('block') } }
    )
    $fake.State.NoCa = [bool] $NoCa; $fake.State.Ga = $GlobalAdmins; $fake.State.Logging = [bool] $Logging; $fake.State.ConsentOpen = [bool] $ConsentOpen
    $inner = $fake.Transport
    $state = $fake.State
    $fake.Transport = {
        param([string] $Method, [string] $Uri, [string] $Payload)
        $u = [uri] $Uri
        $path = [uri]::UnescapeDataString($u.AbsolutePath)
        function Reply([int] $Code, $Obj) { [pscustomobject]@{ StatusCode = $Code; Content = ($Obj | ConvertTo-Json -Depth 10 -Compress) } }
        if ($Method -eq 'GET' -and $path -eq '/v1.0/identity/conditionalAccess/policies') {
            [void] $state.Requests.Add("$Method $Uri")
            if ($state.NoCa) { return Reply 403 @{ error = @{ message = 'Authorization_RequestDenied' } } }
            return Reply 200 @{ value = $state.Ca }
        }
        if ($Method -eq 'GET' -and $path -like "/v1.0/directoryRoles(roleTemplateId='62e90394-69f5-4237-9190-012177145e10')/members") {
            [void] $state.Requests.Add("$Method $Uri")
            return Reply 200 @{ value = @(1..$state.Ga | Where-Object { $state.Ga } | ForEach-Object { @{ id = "ga-$_" } }) }
        }
        if ($Method -eq 'GET' -and $path -eq '/v1.0/policies/authorizationPolicy') {
            [void] $state.Requests.Add("$Method $Uri")
            $grants = @('ManagePermissionGrantsForOwnedResource.microsoft-dynamically-managed-permissions-for-team')
            if ($state.ConsentOpen) { $grants += 'ManagePermissionGrantsForSelf.microsoft-user-default-legacy' }
            return Reply 200 @{ defaultUserRolePermissions = @{ allowedToCreateSecurityGroups = $state.UsersCreateGroups; permissionGrantPoliciesAssigned = $grants } }
        }
        if ($Method -eq 'GET' -and $path -like '*/providers/Microsoft.Insights/diagnosticSettings') {
            [void] $state.Requests.Add("$Method $Uri")
            $logs = @()
            if ($state.Logging) { $logs = @(@{ properties = @{ workspaceId = '/subscriptions/x/resourceGroups/y/providers/Microsoft.OperationalInsights/workspaces/law'; logs = @(@{ categoryGroup = 'audit'; enabled = $true }) } }) }
            return Reply 200 @{ value = $logs }
        }
        return (& $inner $Method $Uri $Payload)
    }.GetNewClosure()
    return $fake
}

function Invoke-SetupRun($Plan) {
    $dry = Invoke-KeevaultSetup -Plan $Plan -WhatIf
    Invoke-KeevaultSetup -Plan $Plan -ConfirmPlanHash $dry.PlanHash -Confirm:$false | Out-Null
}
function ItemsOf($Drift, [string] $Status) { return @($Drift.Items | Where-Object { $_.Status -eq $Status }) }
function Set-FakeRegistry($Values) { & (Get-Module KeevaultSetup) { param($v) $script:KsRegistry = { param($Hive, $Key) $v["$Hive\$Key"] }.GetNewClosure() } $Values }

$checkScenarios = [ordered]@{
    'drift: empty tenant -> everything missing, fix by the normal run, nothing written' = {
        $fake = New-CheckFake; $fake.State.ResourceGroups = @{}; Use-Fake $fake
        $d = Test-KeevaultSetupDrift -Plan (New-TestPlan)
        Assert ($fake.State.Writes.Count -eq 0) "Drift hat geschrieben: $($fake.State.Writes -join ', ')"
        Assert ($d.Summary.missing -eq 5 -and $d.Summary.ok -eq 0) "fehlt: RG, Tresor, 3 Gruppen (Rollen erst mit Tresor) -> $($d.Summary | ConvertTo-Json -Compress)"
        Assert ($d.FixByRun) 'Korrekturangebot über den Lauf'
        Assert (@($d.Items | Where-Object { $_.Status -eq 'missing' -and $_.Fix -ne 'run' }).Count -eq 0) 'alles Fehlende per Lauf'
    }
    'drift: after a run nothing differs; changed settings, extra roles and a second group are found' = {
        $fake = New-CheckFake; Use-Fake $fake
        $plan = New-TestPlan
        Invoke-SetupRun $plan
        $d = Test-KeevaultSetupDrift -Plan $plan
        Assert ($d.Summary.missing -eq 0 -and $d.Summary.differs -eq 0 -and $d.Summary.extra -eq 0 -and $d.Summary.notChecked -eq 0) "nach Lauf: $($d.Summary | ConvertTo-Json -Compress) $((ItemsOf $d 'notChecked' | ForEach-Object { $_.Object }) -join ';')"
        Assert ($d.Summary.ok -eq 16) "wie geplant: RG + 5 Tresorwerte + 3 Gruppen + 7 Rollen = 16, nicht $($d.Summary.ok)"
        $writes = $fake.State.Writes.Count
        $fake.State.Vaults['kv-team-a'].purge = $false
        $fake.State.Vaults['kv-team-a'].softDeleteDays = 7
        $scope = @($fake.State.Assignments.Values)[0].scope
        $fake.State.Assignments['extra-1'] = @{ scope = $scope; principalId = 'user-1'; roleDefinitionId = '/x/roleDefinitions/4633458b-17de-408a-b874-0445c86b69e6'; principalType = 'User' }
        $readId = @($fake.State.Groups.Keys | Where-Object { $fake.State.Groups[$_].displayName -eq 'Keevault-kv-team-a-Read' })[0]
        $fake.State.Assignments['extra-2'] = @{ scope = $scope; principalId = $readId; roleDefinitionId = '/x/roleDefinitions/b86a8fe4-44ce-4948-aee5-eccb2c155cd7'; principalType = 'Group' }
        $d = Test-KeevaultSetupDrift -Plan $plan
        $diff = @(ItemsOf $d 'differs' | ForEach-Object { $_.Object }) -join ';'
        Assert ($diff -match 'Purge' -and $diff -match 'Soft-Delete') "abweichend: $diff"
        $extra = @(ItemsOf $d 'extra')
        Assert ($extra.Count -eq 2 -and ($extra.Hint -join ' ') -match 'Freigabe aus der App' -and ($extra.Hint -join ' ') -match 'über ihre Stufe') "zusätzlich: $($extra.Hint -join ' | ')"
        $fake.State.Groups['dup'] = @{ displayName = 'Keevault-kv-team-a-Write'; securityEnabled = $true; mailEnabled = $false }
        $d = Test-KeevaultSetupDrift -Plan $plan
        Assert ($fake.State.Writes.Count -eq $writes) 'Drift hat geschrieben'
        Assert ((@(ItemsOf $d 'differs' | ForEach-Object { $_.Object }) -join ';') -match 'Keevault-kv-team-a-Write') 'zweite Gruppe gleichen Namens erkannt'
        Assert (@($d.Items | Where-Object { $_.Status -in 'differs', 'extra' -and $_.Fix -eq 'run' }).Count -eq 0) 'Abweichendes wird nie per Lauf "korrigiert"'
    }
    'drift: no read right -> not checked instead of missing' = {
        $fake = New-CheckFake; Use-Fake $fake
        $plan = New-TestPlan
        $inner = $fake.Transport
        $deny = { param($Method, $Uri, $Payload) if ($Uri -like '*/vaults/kv-team-a?*' -or $Uri -like '*/resourceGroups/rg-keevault?*') { return [pscustomobject]@{ StatusCode = 403; Content = '{"error":{"message":"AuthorizationFailed"}}' } }; & $inner $Method $Uri $Payload }.GetNewClosure()
        Set-KeevaultSetupTransport -Transport $deny -TenantId $fake.State.Tenant -SubscriptionId $fake.State.Sub -Account 'admin@contoso.example'
        $d = Test-KeevaultSetupDrift -Plan $plan
        Assert ((ItemsOf $d 'notChecked').Count -ge 2) "nicht geprüft: $($d.Summary | ConvertTo-Json -Compress)"
        Assert (@(ItemsOf $d 'missing' | Where-Object { $_.Object -in 'rg-keevault', 'kv-team-a' }).Count -eq 0) 'ohne Leserecht nicht als fehlend gemeldet'
    }
    'drift: device policy against the registry (stand-in), read-only' = {
        $plan = New-TestPlan
        $plan.devicePolicy.requirePin = $true; $plan.devicePolicy.updateChannel = 'stable'; $plan.devicePolicy.extensionBrowsers = @('edge')
        $orig = & (Get-Module KeevaultSetup) { $script:KsRegistry }
        Set-FakeRegistry @{ 'HKLM\SOFTWARE\Policies\Keevault' = @{ RequirePin = 1; UpdateChannel = 'beta' } }
        try {
            $d = Test-KeevaultSetupDrift -Plan $plan -Device -NoTenant
            $by = @{}; foreach ($i in $d.Items) { $by[$i.Object] = $i.Status }
            Assert ($by['HKLM\SOFTWARE\Policies\Keevault\RequirePin'] -eq 'ok') 'RequirePin wie geplant'
            Assert ($by['HKLM\SOFTWARE\Policies\Keevault\UpdateChannel'] -eq 'differs') 'UpdateChannel weicht ab'
            Assert ($by['HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist\*'] -eq 'missing') "Forcelist fehlt: $($by.Keys -join ';')"
            Assert (@($d.Items | Where-Object { $_.Area -ne 'device' }).Count -eq 0) 'ohne Tenant nur Geräte-Einträge'
            Assert (@($d.Items | Where-Object { $_.Fix -eq 'run' }).Count -eq 0) 'Geräte-Drift nie per Lauf'
        }
        finally { & (Get-Module KeevaultSetup) { param($o) $script:KsRegistry = $o } $orig }
    }
    'compliance: CISA checked in full, own checks by name, CIS only as unverified mapping, deviations and unreadable data named, read-only' = {
        $fake = New-CheckFake -GlobalAdmins 9; Use-Fake $fake
        $plan = New-TestPlan
        Invoke-SetupRun $plan
        $writes = $fake.State.Writes.Count
        $c = Test-KeevaultSetupCompliance -Plan $plan
        Assert ($fake.State.Writes.Count -eq $writes) 'Prüfung hat geschrieben'
        $s = @{}; foreach ($r in $c.Controls) { $s[$r.Id] = $r.Status }
        $want = @{ 'vault-rbac' = 'pass'; 'vault-recoverable' = 'pass'; 'vault-logging' = 'fail'; 'vault-private' = 'deviation'; 'secret-expiry' = 'deviation'; 'ga-count' = 'fail'; 'phishing-resistant' = 'pass'; 'legacy-auth' = 'fail'; 'user-consent' = 'pass'; 'pim-permanent' = 'manual' }
        foreach ($k in $want.Keys) { Assert ($s[$k] -eq $want[$k]) "$k = $($s[$k]), erwartet $($want[$k])" }
        $scuba = @($c.Controls | Where-Object { $_.Control -like 'MS.AAD.*' })
        Assert ($scuba.Count -eq 5 -and @($scuba | Where-Object { $_.Reference -notmatch '^geprüft gegen Kontrolle MS\.AAD\.\S+, CISA SCuBA' }).Count -eq 0) 'CISA-Zeilen nennen ihre Kontrolle'
        $own = @($c.Controls | Where-Object { -not $_.Control })
        Assert ($own.Count -eq 5 -and @($own | Where-Object { $_.Reference -notmatch '^Keevault-Empfehlung; ungeprüfte Zuordnung: CIS ' }).Count -eq 0) "eigene Prüfungen mit CIS nur als Zuordnung: $(($own | ForEach-Object { $_.Reference }) -join ' | ')"
        Assert (@($c.Controls | Where-Object { $_.Reference -match 'geprüft gegen Kontrolle [^;]*\bCIS\b' }).Count -eq 0) 'nie „geprüft gegen“ eine CIS-Kontrolle'
        $md = New-KeevaultSetupCheckReport -Compliance $c
        Assert ($md -notmatch '(?i)\b(konform|compliant|zertifiziert|certified)\b' -or $md -match 'Kein Zertifikat') 'keine Konformitätsaussage'
        Assert ($md -match 'CIS-Nummern sind nur eine ungeprüfte Zuordnung') 'Hinweis zur CIS-Zuordnung im Bericht'
        $fake2 = New-CheckFake -NoCa -Logging -ConsentOpen -GlobalAdmins 3; Use-Fake $fake2
        Invoke-SetupRun $plan
        $c2 = Test-KeevaultSetupCompliance -Plan $plan
        $s2 = @{}; foreach ($r in $c2.Controls) { $s2[$r.Id] = $r.Status }
        Assert ($s2['phishing-resistant'] -eq 'notChecked' -and $s2['legacy-auth'] -eq 'notChecked') 'ohne CA-Leserecht: nicht geprüft'
        Assert ($s2['vault-logging'] -eq 'pass' -and $s2['user-consent'] -eq 'fail' -and $s2['ga-count'] -eq 'pass') "Logging/Zustimmung/GA: $($s2 | ConvertTo-Json -Compress)"
    }
    'check report: drift and compliance in Markdown, HTML and DOCX, English, no secrets' = {
        $fake = New-CheckFake; Use-Fake $fake
        $plan = New-TestPlan
        $d = Test-KeevaultSetupDrift -Plan $plan
        $c = Test-KeevaultSetupCompliance -Plan $plan
        $md = New-KeevaultSetupCheckReport -Drift $d -Compliance $c
        Assert ($md -match '## Abweichungen vom Plan' -and $md -match '## Sicherheitsempfehlungen' -and $md -match 'Nur gelesen') 'Abschnitte'
        $html = New-KeevaultSetupCheckReport -Drift $d -Compliance $c -Format Html
        Assert ($html -match '<html' -and $html -notmatch '<script') 'HTML ohne Skript'
        $docx = New-KeevaultSetupCheckReport -Drift $d -Compliance $c -Format Docx
        Assert ($docx -is [byte[]] -and $docx[0] -eq 0x50 -and $docx[1] -eq 0x4b) 'DOCX ist ein ZIP'
        Set-KeevaultSetupLanguage en
        try {
            $c = Test-KeevaultSetupCompliance -Plan $plan
            $en = New-KeevaultSetupCheckReport -Compliance $c
            Assert ($en -match 'checked against control' -and $en -match 'Security recommendations' -and $en -match 'unverified mapping') 'Englisch'
        }
        finally { Set-KeevaultSetupLanguage de }
        $d.Items[0].Hint = 'password: hunter2xyz'
        Throws { New-KeevaultSetupCheckReport -Drift $d } 'Geheimnis|secret' 'Bericht mit Geheimnis wird verweigert'
    }
    'catalogue: versioned data, own short texts, CISA controls numbered, CIS only as unverified mapping' = {
        $cat = & (Get-Module KeevaultSetup) { Get-KsControls }
        Assert ($cat.schema -eq 'keevault-setup-controls' -and $cat.version -match '^\d{4}\.\d+\.\d+$') 'Schema und Version'
        foreach ($ctl in $cat.controls) {
            $fw = $cat.frameworks.($ctl.framework)
            Assert ($fw -and $fw.name -and $ctl.check) "Kontrolle $($ctl.id) unvollständig"
            Assert ($ctl.framework -in 'keevault', 'scuba-aad') "Kontrolle $($ctl.id): geprüft wird nur gegen eigene oder CISA-Formulierung"
            if ($ctl.framework -eq 'scuba-aad') { Assert ($ctl.control -match '^MS\.AAD\.\d+\.\d+v\d+$' -and $fw.edition) "Kontrolle $($ctl.id): CISA-Nummer" }
            if ($ctl.PSObject.Properties['cis']) { Assert ($cat.frameworks.($ctl.cis.framework).unverified -eq $true -and $ctl.cis.control) "Kontrolle $($ctl.id): CIS nur als ungeprüfte Zuordnung" }
            Assert (@($ctl.title).Count -eq 2 -and @($ctl.why).Count -eq 2) "Kontrolle $($ctl.id): Texte DE/EN"
            Assert (([string] $ctl.title[0]).Length -le 100) "Kontrolle $($ctl.id): nur Kurztext"
        }
    }
}
