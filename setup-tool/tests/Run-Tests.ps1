# Scenario tests of the setup tool engine against the ARM/Graph stub (#501). Runs in Windows PowerShell 5.1 and
# PowerShell 7. Prints one line per scenario: "PASS <name>" or "FAIL <name> -- <reason>"; test/setup-tool-501.test.js
# turns them into node tests.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Import-Module (Join-Path $root 'KeevaultSetup\KeevaultSetup.psd1') -Force
. (Join-Path $PSScriptRoot 'FakeAzure.ps1')

$owner = '8e3af657-a8ff-443c-a75c-2fe8c4bcb635'
$groupsAdmin = 'fdd7a751-b60b-444a-984c-02652fe8fa1c'
function Use-Fake($Fake) { Set-KeevaultSetupTransport -Transport $Fake.Transport -TenantId $Fake.State.Tenant -SubscriptionId $Fake.State.Sub -Account 'admin@contoso.example' }
function Assert($Cond, [string] $Msg) { if (-not $Cond) { throw $Msg } }
function StatusOf($Result, [string] $Id) { return (@($Result.Steps | Where-Object { $_.Id -eq $Id })[0]).Status }
function Throws([scriptblock] $Block, [string] $Pattern, [string] $Msg) {
    try { & $Block | Out-Null } catch { if ($_.Exception.Message -match $Pattern) { return } ; throw "$Msg (andere Meldung: $($_.Exception.Message))" }
    throw "$Msg (kein Fehler)"
}
function New-TestPlan { New-KeevaultSetupPlan -Vault 'kv-team-a' -ResourceGroup 'rg-keevault' -SubscriptionId $script:FakeSub }

$scenarios = [ordered]@{
    'plan: steps in order, group names from the pattern' = {
        $plan = New-KeevaultSetupPlan -Vault 'kv-team-a', 'kv-team-b' -GroupPattern 'KV {vault} {level}'
        $ids = @(Get-KeevaultSetupStep $plan | ForEach-Object { $_.Id })
        Assert (($ids -join ',') -eq 'subscriptionTip,resourceGroup,vault:kv-team-a,vault:kv-team-b,groups:kv-team-a,groups:kv-team-b,roles:kv-team-a,roles:kv-team-b,pim,breakGlass,conditionalAccess,emergencyHandbook') "Reihenfolge: $($ids -join ',')"
        $g = @(Get-KeevaultSetupStep $plan | Where-Object { $_.Id -eq 'groups:kv-team-b' })[0]
        Assert ($g.Title -like '*KV kv-team-b Read, KV kv-team-b Write, KV kv-team-b Admin*') "Gruppennamen: $($g.Title)"
        $bg = @(Get-KeevaultSetupStep $plan | Where-Object { $_.Id -eq 'breakGlass' })[0]
        Assert ($bg.Questions[0].Id -eq 'breakGlassFidoLocation') 'Break-Glass fragt den Aufbewahrungsort ab'
    }
    'plan: strict validation' = {
        $ok = New-TestPlan
        $bad = @(
            @{ Change = { param($p) $p['extra'] = 1 }; Pattern = "Unbekanntes Feld 'extra'" }
            @{ Change = { param($p) $p.schema = 'other' }; Pattern = 'schema' }
            @{ Change = { param($p) $p.version = 2 }; Pattern = 'version' }
            @{ Change = { param($p) $p.vaults = @(@{ name = '1bad' }) }; Pattern = 'Tresorname' }
            @{ Change = { param($p) $p.vaults = @(@{ name = 'kv-a' }, @{ name = 'KV-A' }) }; Pattern = 'doppelt' }
            @{ Change = { param($p) $p.vaults = @(@{ name = 'kv-a'; secret = 'x' }) }; Pattern = "Unbekanntes Feld 'secret'" }
            @{ Change = { param($p) $p.target.subscriptionId = 'abc' }; Pattern = 'GUID' }
            @{ Change = { param($p) $p.groupPattern = 'KV-{vault}' }; Pattern = 'groupPattern' }
            @{ Change = { param($p) $p.groupPattern = "KV-{vault}-{level}'x" }; Pattern = 'groupPattern' }
            @{ Change = { param($p) $p.steps.pim = 'ja' }; Pattern = 'true oder false' }
            @{ Change = { param($p) $p.answers.breakGlassFidoLocation = 'Safe, PIN: 1234' }; Pattern = 'Geheimnis' }
            @{ Change = { param($p) $p.answers.breakGlassFidoLocation = 'PIN 482913 im Umschlag' }; Pattern = 'PIN' }
            @{ Change = { param($p) $p.answers.breakGlassFidoLocation = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc' }; Pattern = 'Token' }
            @{ Change = { param($p) $p.answers.breakGlassFidoLocation = 'Wiederherstellung Q2hhbmdlTWVQbGVhc2UxMjM0NTY3ODkw' }; Pattern = 'lange Zeichenfolge' }
            @{ Change = { param($p) $p.answers['notes'] = 'x' }; Pattern = "Unbekanntes Feld 'notes'" }
        )
        foreach ($case in $bad) {
            $p = (ConvertTo-KeevaultSetupPlanJson $ok | ConvertFrom-Json)
            $h = @{}; $p.PSObject.Properties | ForEach-Object { $h[$_.Name] = $_.Value }
            $h.target = @{ tenantId = ''; subscriptionId = $p.target.subscriptionId; location = $p.target.location }
            $h.steps = @{}; $p.steps.PSObject.Properties | ForEach-Object { $h.steps[$_.Name] = $_.Value }
            $h.answers = @{ breakGlassFidoLocation = '' }
            & $case.Change $h
            $check = Test-KeevaultSetupPlan $h
            Assert (-not $check.Valid) "angenommen: $($case.Pattern)"
            Assert (($check.Errors -join ' ') -match $case.Pattern) "Meldung passt nicht ($($case.Pattern)): $($check.Errors -join ' ')"
        }
        $good = New-TestPlan
        $good.answers.breakGlassFidoLocation = 'Safe im Serverraum, Raum 2.14, Schlüssel bei der IT-Leitung'
        Assert (Test-KeevaultSetupPlan $good).Valid 'ein Ort mit Raumnummer muss gehen'
    }
    'dry run lists what is missing and writes nothing; running needs the dry run hash' = {
        $fake = New-KsFake; Use-Fake $fake
        $plan = New-TestPlan
        $dry = Invoke-KeevaultSetup -Plan $plan -WhatIf
        Assert ($fake.State.Writes.Count -eq 0) "Probelauf schrieb: $($fake.State.Writes -join '; ')"
        Assert ($dry.DryRun) 'DryRun'
        foreach ($id in 'resourceGroup', 'vault:kv-team-a', 'groups:kv-team-a', 'roles:kv-team-a') { Assert ((StatusOf $dry $id) -eq 'planned') "$id ist $(StatusOf $dry $id)" }
        foreach ($id in 'subscriptionTip', 'pim', 'breakGlass', 'conditionalAccess') { Assert ((StatusOf $dry $id) -eq 'manual') "$id ist $(StatusOf $dry $id)" }
        $roles = @($dry.Steps | Where-Object { $_.Id -eq 'roles:kv-team-a' })[0]
        Assert ($roles.Actions.Count -eq 7) "7 Rollen geplant, sind $($roles.Actions.Count)"
        Throws { Invoke-KeevaultSetup -Plan $plan -Confirm:$false } 'Probelauf' 'Ausführen ohne Probelauf'
        Throws { Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash ('0' * 64) -Confirm:$false } 'geändert' 'falscher Fingerabdruck'
        $other = New-TestPlan; $other.resourceGroup = 'rg-other'
        Throws { Invoke-KeevaultSetup -Plan $other -ConfirmPlanHash $dry.PlanHash -Confirm:$false } 'geändert' 'anderer Plan mit altem Fingerabdruck'
        Assert ($fake.State.Writes.Count -eq 0) 'abgelehnte Läufe schrieben'
        Assert ($fake.State.Unknown.Count -eq 0) "unbekannte Anfragen: $($fake.State.Unknown -join '; ')"
    }
    'run creates resource group, RBAC vault, three groups and seven role assignments' = {
        $fake = New-KsFake; Use-Fake $fake
        $plan = New-TestPlan
        $dry = Invoke-KeevaultSetup -Plan $plan -WhatIf
        $run = Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash $dry.PlanHash -Confirm:$false
        foreach ($id in 'resourceGroup', 'vault:kv-team-a', 'groups:kv-team-a', 'roles:kv-team-a') { Assert ((StatusOf $run $id) -eq 'done') "$id ist $(StatusOf $run $id): $((@($run.Steps | Where-Object Id -eq $id))[0].Detail)" }
        $v = $fake.State.Vaults['kv-team-a']
        Assert ($v.rbac -and $v.purge -and $v.tags.kvpwsafe -eq 'container' -and $v.tenantId -eq $fake.State.Tenant) 'Tresor mit RBAC, Bereinigungsschutz, Marker und Tenant'
        $names = @($fake.State.Groups.Values | ForEach-Object { $_.displayName } | Sort-Object)
        Assert (($names -join ',') -eq 'Keevault-kv-team-a-Admin,Keevault-kv-team-a-Read,Keevault-kv-team-a-Write') "Gruppen: $($names -join ',')"
        $byGroup = @{}
        foreach ($a in $fake.State.Assignments.Values) {
            Assert ($a.principalType -eq 'Group') 'principalType Group'
            $n = $fake.State.Groups[$a.principalId].displayName
            $byGroup[$n] = @($byGroup[$n]) + ($a.roleDefinitionId.Split('/')[-1]) | Where-Object { $_ }
        }
        $expect = @{
            'Keevault-kv-team-a-Read'  = '4633458b-17de-408a-b874-0445c86b69e6,acdd72a7-3385-48ef-bd42-f606fba81ae7'
            'Keevault-kv-team-a-Write' = 'acdd72a7-3385-48ef-bd42-f606fba81ae7,b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
            'Keevault-kv-team-a-Admin' = '8b54135c-b56d-4d72-a534-26097cfdc8d8,acdd72a7-3385-48ef-bd42-f606fba81ae7,b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
        }
        foreach ($k in $expect.Keys) { Assert ((($byGroup[$k] | Sort-Object) -join ',') -eq $expect[$k]) "Rollen von $k`: $(($byGroup[$k] | Sort-Object) -join ',')" }
        Assert ($fake.State.Writes.Count -eq 12) "12 Schreibvorgänge erwartet, waren $($fake.State.Writes.Count)"
    }
    'second run is idempotent: everything done, nothing written' = {
        $fake = New-KsFake; Use-Fake $fake
        $plan = New-TestPlan
        $dry = Invoke-KeevaultSetup -Plan $plan -WhatIf
        Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash $dry.PlanHash -Confirm:$false | Out-Null
        $before = $fake.State.Writes.Count
        $dry2 = Invoke-KeevaultSetup -Plan $plan -WhatIf
        foreach ($id in 'resourceGroup', 'vault:kv-team-a', 'groups:kv-team-a', 'roles:kv-team-a') { Assert ((StatusOf $dry2 $id) -eq 'done') "$id ist $(StatusOf $dry2 $id)" }
        Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash $dry2.PlanHash -Confirm:$false | Out-Null
        Assert ($fake.State.Writes.Count -eq $before) "zweiter Lauf schrieb: $($fake.State.Writes[$before..($fake.State.Writes.Count - 1)] -join '; ')"
    }
    'foreign things stay untouched: access-policy vault, foreign assignment, mail group' = {
        $fake = New-KsFake; Use-Fake $fake
        $fake.State.ResourceGroups['rg-keevault'] = 'germanywestcentral'
        $fake.State.Vaults['kv-legacy'] = @{ rg = 'rg-keevault'; rbac = $false; tags = @{} }
        $fake.State.Vaults['kv-team-a'] = @{ rg = 'rg-keevault'; rbac = $true; tags = @{ kvpwsafe = 'container' } }
        $foreignId = '00000000-0000-0000-0000-00000000dddd'
        $fake.State.Assignments['foreign'] = @{ scope = "/subscriptions/$($fake.State.Sub)/resourceGroups/rg-keevault/providers/Microsoft.KeyVault/vaults/kv-team-a"; principalId = $foreignId; roleDefinitionId = "/subscriptions/$($fake.State.Sub)/providers/microsoft.authorization/roledefinitions/00482a5a-887f-4fb3-b363-3b7fe8e74483" }
        $mailId = [guid]::NewGuid().ToString()
        $fake.State.Groups[$mailId] = @{ displayName = 'Keevault-kv-mail-Read'; securityEnabled = $true; mailEnabled = $true }
        $plan = New-KeevaultSetupPlan -Vault 'kv-legacy', 'kv-team-a', 'kv-mail' -SubscriptionId $fake.State.Sub
        $dry = Invoke-KeevaultSetup -Plan $plan -WhatIf
        Assert ((StatusOf $dry 'vault:kv-legacy') -eq 'manual') "Zugriffsrichtlinien-Tresor: $(StatusOf $dry 'vault:kv-legacy')"
        Assert ((StatusOf $dry 'roles:kv-legacy') -eq 'manual') "Rollen auf Zugriffsrichtlinien-Tresor: $(StatusOf $dry 'roles:kv-legacy')"
        Assert ((StatusOf $dry 'groups:kv-mail') -eq 'failed') "E-Mail-Gruppe: $(StatusOf $dry 'groups:kv-mail')"
        $run = Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash $dry.PlanHash -Confirm:$false
        Assert (-not $fake.State.Vaults['kv-legacy'].rbac) 'Tresor mit Zugriffsrichtlinien wurde umgestellt'
        Assert ($fake.State.Assignments.ContainsKey('foreign') -and $fake.State.Assignments['foreign'].principalId -eq $foreignId) 'fremde Rollenzuweisung verändert'
        Assert ($fake.State.Groups[$mailId].mailEnabled) 'E-Mail-Gruppe verändert'
        Assert (@($fake.State.Writes | Where-Object { $_ -match '^(DELETE|PATCH)' -or $_ -like '*kv-legacy*' }).Count -eq 0) "verbotene Schreibvorgänge: $($fake.State.Writes -join '; ')"
        Assert ((StatusOf $run 'roles:kv-team-a') -eq 'done') "Rollen kv-team-a: $(StatusOf $run 'roles:kv-team-a')"
    }
    'missing rights: steps become tasks for someone else, nothing is written' = {
        $fake = New-KsFake -EntraRoles @() -AzureRoles @('acdd72a7-3385-48ef-bd42-f606fba81ae7'); Use-Fake $fake
        $fake.State.ResourceGroups['rg-keevault'] = 'germanywestcentral'
        $rights = Get-KeevaultSetupRights -SubscriptionId $fake.State.Sub -ResourceGroup 'rg-keevault'
        Assert (-not $rights.Can.armWrite -and -not $rights.Can.roleAssign -and -not $rights.Can.groupCreate) 'Leser darf nichts schreiben'
        Assert (@($rights.AzureRoles | Where-Object { $_.Name -eq 'Leser' }).Count -eq 1) 'Leser-Rolle erkannt'
        $plan = New-TestPlan
        $dry = Invoke-KeevaultSetup -Plan $plan -WhatIf
        Assert ((StatusOf $dry 'resourceGroup') -eq 'done') 'vorhandene Ressourcengruppe zählt als erledigt, auch ohne Recht'
        foreach ($id in 'vault:kv-team-a', 'groups:kv-team-a', 'roles:kv-team-a') { Assert ((StatusOf $dry $id) -eq 'noRight') "$id ist $(StatusOf $dry $id)" }
        $run = Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash $dry.PlanHash -Confirm:$false
        Assert ($fake.State.Writes.Count -eq 0) "ohne Recht geschrieben: $($fake.State.Writes -join '; ')"
        $md = New-KeevaultSetupReport -Result $run
        Assert ($md -match 'Aufgaben für jemanden mit mehr Rechten') 'Doku nennt die Aufgaben für andere'
        $fake2 = New-KsFake -EntraRoles @() -AzureRoles @() -UsersCreateGroups; Use-Fake $fake2
        Assert ((Get-KeevaultSetupRights).Can.groupCreate) 'Tenant-Einstellung: jeder darf Sicherheitsgruppen anlegen'
    }
    'vault name taken elsewhere fails before writing; plan for another tenant is refused' = {
        $fake = New-KsFake; Use-Fake $fake
        $fake.State.TakenNames = @('kv-team-a')
        $dry = Invoke-KeevaultSetup -Plan (New-TestPlan) -WhatIf
        Assert ((StatusOf $dry 'vault:kv-team-a') -eq 'failed') "vergebener Name: $(StatusOf $dry 'vault:kv-team-a')"
        $plan = New-TestPlan; $plan.target.tenantId = '00000000-0000-0000-0000-00000000eeee'
        Throws { Invoke-KeevaultSetup -Plan $plan -WhatIf } 'anderen Tenant' 'Plan eines anderen Tenants'
    }
    'export and import: portable, strict, round trip' = {
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('ks-test-' + [guid]::NewGuid().ToString('n'))
        New-Item -ItemType Directory $dir | Out-Null
        try {
            $plan = New-TestPlan
            $plan.target.tenantId = $script:FakeTenant
            $plan.answers.breakGlassFidoLocation = 'Safe im Serverraum'
            $full = Join-Path $dir 'full.json'; $port = Join-Path $dir 'portable.json'
            Export-KeevaultSetupPlan -Plan $plan -Path $full
            Export-KeevaultSetupPlan -Plan $plan -Path $port -Portable
            $back = Import-KeevaultSetupPlan -Path $full
            Assert ((Get-KeevaultSetupPlanHash $back) -eq (Get-KeevaultSetupPlanHash $plan)) 'Hin und zurück gleich'
            $p2 = Import-KeevaultSetupPlan -Path $port
            Assert (-not $p2.target.tenantId -and -not $p2.target.subscriptionId -and -not $p2.answers.breakGlassFidoLocation) 'portabel ohne Tenant, Subscription und Antworten'
            Assert ($p2.vaults[0].name -eq 'kv-team-a' -and $p2.groupPattern -eq $plan.groupPattern) 'portabel behält die Auswahl'
            $raw = Get-Content $full -Raw
            Throws { Import-KeevaultSetupPlan -Json ($raw -replace '"resourceGroup"', '"clientSecret": "x", "resourceGroup"') } 'Unbekanntes Feld' 'unbekanntes Feld beim Import'
            Throws { Import-KeevaultSetupPlan -Json ($raw -replace 'Safe im Serverraum', 'Passwort: Geheim123') } 'Geheimnis' 'Geheimnis beim Import'
            Throws { Import-KeevaultSetupPlan -Json '{ nope' } 'JSON' 'kaputtes JSON'
            $example = Import-KeevaultSetupPlan -Path (Join-Path $root 'examples\plan.example.json')
            Assert ($example.vaults.Count -eq 2) 'Beispielplan lässt sich importieren'
            $big = Join-Path $dir 'big.json'
            [System.IO.File]::WriteAllText($big, ('{"x":"' + ('a' * 300000) + '"}'))
            Throws { Import-KeevaultSetupPlan -Path $big } 'zu groß' 'zu große Datei'
        }
        finally { Remove-Item -LiteralPath $dir -Recurse -Force }
    }
    'report: done and manual steps, answers, groups; never secrets' = {
        $fake = New-KsFake; Use-Fake $fake
        $plan = New-TestPlan
        $plan.answers.breakGlassFidoLocation = 'Safe im Serverraum, Raum 2.14'
        $plan.steps.conditionalAccess = $false
        $dry = Invoke-KeevaultSetup -Plan $plan -WhatIf
        $run = Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash $dry.PlanHash -Confirm:$false
        $md = New-KeevaultSetupReport -Result $run
        foreach ($want in '## Erledigt', '## Manuelle Schritte', 'Notfallkonto', '## Antworten auf Rückfragen', 'Safe im Serverraum, Raum 2.14', 'Keevault-kv-team-a-Admin', 'Key Vault Data Access Administrator', 'Bewusst übersprungen') {
            Assert ($md.Contains($want)) "Doku enthält nicht: $want"
        }
        Assert ($md -notmatch 'eyJ|BEGIN|Passwort:|PIN:') 'Doku enthält ein Geheimnis'
        $run.Steps[0].Detail = 'client secret: abc'
        Throws { New-KeevaultSetupReport -Result $run } 'Doku nicht erzeugt' 'Geheimnis in der Doku wird abgelehnt'
        $evil = New-TestPlan
        $evil.answers.breakGlassFidoLocation = 'Safe [Link](https://example.invalid) <img src=x>'
        $r2 = Invoke-KeevaultSetup -Plan $evil -WhatIf
        $md2 = New-KeevaultSetupReport -Result $r2
        Assert ($md2 -notmatch '(?<!\\)\]\(https' -and $md2 -notmatch '(?<!\\)<img') 'Antworten bilden keine Links oder HTML in der Doku'
    }
    'Entra ID P2: without it the PIM tip becomes a note, unreadable licences keep the tip with a warning' = {
        foreach ($case in @(@('yes', 'manual', 'vorhanden'), @('no', 'info', 'benötigt Entra ID P2'), @('hidden', 'manual', 'nicht lesbar'))) {
            $fake = New-KsFake -P2 $case[0]; Use-Fake $fake
            $rights = Get-KeevaultSetupRights -SubscriptionId $fake.State.Sub -ResourceGroup 'rg-keevault'
            $want = @{ yes = $true; no = $false; hidden = $null }[$case[0]]
            Assert ($rights.EntraP2 -eq $want) "P2 $($case[0]): erkannt als $($rights.EntraP2)"
            $dry = Invoke-KeevaultSetup -Plan (New-TestPlan) -WhatIf -Rights $rights
            $pim = @($dry.Steps | Where-Object { $_.Id -eq 'pim' })[0]
            Assert ($pim.Status -eq $case[1]) "P2 $($case[0]): PIM ist $($pim.Status)"
            Assert ($pim.Detail -match $case[2]) "P2 $($case[0]): Hinweis '$($pim.Detail)'"
            $md = New-KeevaultSetupReport -Result $dry
            if ($case[0] -eq 'no') {
                Assert ($md -match 'Hinweise und Abweichungen[\s\S]*PIM[^\n]*benötigt Entra ID P2') 'Doku nennt PIM als Hinweis „benötigt P2“'
                Assert ($md -notmatch '### PIM') 'PIM steht ohne P2 nicht als Schritt zum Abhaken'
            }
        }
    }
    'documentation: environment, steps, answers, deviations and emergency handbook in Markdown, HTML and DOCX' = {
        $fake = New-KsFake; Use-Fake $fake
        $plan = New-TestPlan
        $plan.steps.conditionalAccess = $false
        $plan.answers.breakGlassFidoLocation = 'Safe im Serverraum, Raum 2.14'
        $plan.answers.breakGlassAccess = 'IT-Leitung und Geschäftsführung'
        $plan.answers.recoveryKeyLocation = 'Bankschließfach, Filiale Mitte'
        $plan.answers.contactOwner = 'Anna Muster, +49 30 1234567, it@contoso.example'
        $plan.answers.contactEmergency = '<b>Dienstleister</b> [x](https://example.invalid)'
        $dry = Invoke-KeevaultSetup -Plan $plan -WhatIf
        $run = Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash $dry.PlanHash -Confirm:$false
        $md = New-KeevaultSetupReport -Result $run
        foreach ($want in '## Umgebung', $fake.State.Sub, 'Entra ID P2 (für PIM): vorhanden', '## Tresore', '## Gruppen und Rollen', '## Erledigt', '## Manuelle Schritte und Tipps', '## Bewusst übersprungen', '## Antworten auf Rückfragen', 'Bedingter Zugriff für Administratoren (Tipp): bewusst übersprungen', '# Notfallhandbuch', 'Aufbewahrungsort des FIDO-Sticks: Safe im Serverraum, Raum 2.14', 'Zugang haben: IT-Leitung und Geschäftsführung', 'Aufbewahrungsort: Bankschließfach, Filiale Mitte', '## 3. Eine Person scheidet aus', '\#500', '## 4. Ein Gerät ist kompromittiert', '## 5. Kontakte', 'Anna Muster', '## 6. Prüfliste', 'Keevault-kv-team-a-Admin') {
            Assert ($md.Contains($want)) "Markdown enthält nicht: $want"
        }
        Assert ($md -notmatch '(?<!\\)<b>' -and $md -notmatch '(?<!\\)\]\(https') 'Antwort bildet in Markdown HTML oder Link'
        $html = New-KeevaultSetupReport -Result $run -Format Html
        Assert ($html -match '^<!doctype html>' -and $html -match '@page' -and $html -match 'class="break"') 'HTML druckbar mit Seitenumbruch vor dem Notfallhandbuch'
        Assert ($html -notmatch '<script' -and $html -notmatch '<b>Dienstleister' -and $html.Contains('&lt;b&gt;Dienstleister')) 'HTML ohne Skript, Antworten escaped'
        Assert ($html.Contains('Bankschließfach, Filiale Mitte')) 'HTML enthält die Antworten'
        $docx = New-KeevaultSetupReport -Result $run -Format Docx
        Assert ($docx -is [byte[]] -and $docx[0] -eq 0x50 -and $docx[1] -eq 0x4b) 'DOCX ist ein ZIP'
        if (-not ('System.IO.Compression.ZipArchive' -as [type])) { Add-Type -AssemblyName System.IO.Compression }
        $zip = New-Object System.IO.Compression.ZipArchive((New-Object System.IO.MemoryStream(, $docx)), [System.IO.Compression.ZipArchiveMode]::Read)
        $parts = @{}
        foreach ($e in $zip.Entries) { $r = New-Object System.IO.StreamReader($e.Open(), [System.Text.Encoding]::UTF8); $parts[$e.FullName] = $r.ReadToEnd(); $r.Dispose() }
        $zip.Dispose()
        foreach ($name in '[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml') {
            Assert $parts.ContainsKey($name) "DOCX-Teil fehlt: $name"
            [void] [xml] $parts[$name]
        }
        $text = (([xml] $parts['word/document.xml']).GetElementsByTagName('w:t') | ForEach-Object { $_.InnerText }) -join "`n"
        foreach ($want in 'Notfallhandbuch', 'Bankschließfach, Filiale Mitte', '<b>Dienstleister</b>', 'Keevault-kv-team-a-Read') { Assert ($text.Contains($want)) "DOCX enthält nicht: $want" }
        $plan2 = New-TestPlan; $plan2.steps.emergencyHandbook = $false
        $md2 = New-KeevaultSetupReport -Result (Invoke-KeevaultSetup -Plan $plan2 -WhatIf)
        Assert (-not $md2.Contains('# Notfallhandbuch')) 'ohne Schritt kein Notfallhandbuch-Teil'
    }
    'documentation never carries secrets: answers rejected, any format refused' = {
        $fake = New-KsFake; Use-Fake $fake
        $bad = @{
            recoveryKeyLocation = 'Wiederherstellungsschlüssel: 7F3A-99QX-2KLM-PP01'
            contactOwner        = 'Anna, PIN 482913'
            breakGlassAccess    = 'Passwort = Sommer2026!'
            contactEmergency    = 'Recovery key: ABCD-EFGH'
        }
        foreach ($id in $bad.Keys) {
            $p = New-TestPlan; $p.answers[$id] = $bad[$id]
            $check = Test-KeevaultSetupPlan $p
            Assert (-not $check.Valid -and ($check.Errors -join ' ') -match "answers\.$id") "Antwort mit Geheimnis angenommen: $id"
        }
        $run = Invoke-KeevaultSetup -Plan (New-TestPlan) -WhatIf
        $run.Steps[0].Detail = 'recovery key: 0123'
        foreach ($format in 'Markdown', 'Html', 'Docx') { Throws { New-KeevaultSetupReport -Result $run -Format $format } 'Doku nicht erzeugt' "Geheimnis in der Doku ($format)" }
        $clean = Invoke-KeevaultSetup -Plan (New-TestPlan) -WhatIf
        foreach ($lang in 'de', 'en') {
            Set-KeevaultSetupLanguage $lang
            try { $r = Invoke-KeevaultSetup -Plan (New-TestPlan) -WhatIf; $md = New-KeevaultSetupReport -Result $r } finally { Set-KeevaultSetupLanguage de }
            Assert ($md -notmatch 'eyJ|BEGIN |(?i)(passwor[dt]|kennwort|pin|secret|token|schl(ü|ue)ssel|key)\s*[:=]\s*\S') "Doku ($lang) enthält ein Feld: Wert-Geheimnis"
        }
        Assert ($clean.Language -eq 'de') 'Lauf merkt sich die Sprache'
    }
    'English: steps, validation, documentation and handbook' = {
        $fake = New-KsFake -P2 no; Use-Fake $fake
        Set-KeevaultSetupLanguage en
        try {
            $plan = New-TestPlan
            $plan.answers.recoveryKeyLocation = 'Safe deposit box'
            $steps = @(Get-KeevaultSetupStep $plan)
            Assert (@($steps | Where-Object { $_.Id -eq 'vault:kv-team-a' })[0].Title -eq 'Key Vault kv-team-a with RBAC') 'Schritt auf Englisch'
            $p = New-TestPlan; $p['extra'] = 1
            Assert (((Test-KeevaultSetupPlan $p).Errors -join ' ') -match "Unknown field 'extra'") 'Prüfung auf Englisch'
            $dry = Invoke-KeevaultSetup -Plan $plan -WhatIf
            Assert ($dry.Language -eq 'en') 'Lauf auf Englisch'
            $pim = @($dry.Steps | Where-Object { $_.Id -eq 'pim' })[0]
            Assert ($pim.StatusText -eq 'note' -and $pim.Detail -match 'needs Entra ID P2') "PIM-Hinweis englisch: $($pim.StatusText) $($pim.Detail)"
        }
        finally { Set-KeevaultSetupLanguage de }
        # The report keeps the language of its run, also when the module language changed meanwhile.
        $md = New-KeevaultSetupReport -Result $dry
        foreach ($want in '# Keevault setup', '## Environment', 'Entra ID P2 (for PIM): not found', '# Emergency handbook', 'Place where they are kept: Safe deposit box', '## 3. A person leaves', '## 6. Checklist for key changes and password changes', 'Reader') {
            Assert ($md.Contains($want)) "englische Doku enthält nicht: $want"
        }
        Assert ($md -notmatch 'Notfallhandbuch|Umgebung|Leser\b') 'englische Doku ohne deutsche Überschriften'
        $html = New-KeevaultSetupReport -Result $dry -Format Html
        Assert ($html -match '<html lang="en">') 'HTML lang=en'
    }
    'terraform: same groups and roles as the run, variables instead of tenant data, escaped, no secrets' = {
        $fake = New-KsFake; Use-Fake $fake
        $plan = New-TestPlan
        $plan.target.tenantId = $fake.State.Tenant
        $plan.vaults[0].displayName = 'Team "A" ${x} %{y}'
        $tf = ConvertTo-KeevaultSetupTerraform $plan
        Assert (-not $tf.Contains($fake.State.Tenant) -and -not $tf.Contains($fake.State.Sub)) 'Tenant- oder Subscription-ID im Terraform-Code'
        Assert ($tf -match 'variable "tenant_id"' -and $tf -match 'variable "subscription_id"' -and $tf -match 'tenant_id\s+= var\.tenant_id') 'Tenant und Subscription als Variablen'
        Assert ($tf.Contains('"kvpwsafe-name" = "Team \"A\" $${x} %%{y}"')) 'Anzeigename als HCL-Text escaped'
        $count = { param($kind) ([regex]::Matches($tf, "(?m)^resource `"$kind`"")).Count }
        Assert ((& $count 'azurerm_resource_group') -eq 1 -and (& $count 'azurerm_key_vault') -eq 1 -and (& $count 'azuread_group') -eq 3 -and (& $count 'azurerm_role_assignment') -eq 7) 'Ressourcen: 1 Gruppe, 1 Tresor, 3 Gruppen, 7 Zuweisungen'
        Assert ($tf -match 'rbac_authorization_enabled\s+= true' -and $tf -match 'purge_protection_enabled\s+= true' -and $tf -match 'soft_delete_retention_days\s+= 90') 'Tresor wie beim Ausführen'
        # Same (group, role) pairs as a run against the stub.
        $dry = Invoke-KeevaultSetup -Plan $plan -WhatIf
        Invoke-KeevaultSetup -Plan $plan -ConfirmPlanHash $dry.PlanHash -Confirm:$false | Out-Null
        $want = @($fake.State.Assignments.Values | ForEach-Object { "$($fake.State.Groups[$_.principalId].displayName)|$($_.roleDefinitionId.Split('/')[-1])" } | Sort-Object)
        $names = @{}
        foreach ($m in [regex]::Matches($tf, '(?s)resource "azuread_group" "(\w+)" \{\s+display_name\s+= "([^"]+)"')) { $names[$m.Groups[1].Value] = $m.Groups[2].Value }
        $got = @(foreach ($m in [regex]::Matches($tf, '(?s)roleDefinitions/([0-9a-f-]{36})"\s+principal_id\s+= azuread_group\.(\w+)\.object_id')) { "$($names[$m.Groups[2].Value])|$($m.Groups[1].Value)" }) | Sort-Object
        Assert (($got -join ',') -eq ($want -join ',')) "Terraform-Rollen weichen vom Lauf ab: $($got -join ',') / $($want -join ',')"
        $plan.steps.resourceGroup = $false; $plan.steps.vaults = $false; $plan.steps.groups = $false
        $tf2 = ConvertTo-KeevaultSetupTerraform $plan
        Assert ($tf2 -match 'data "azurerm_resource_group"' -eq $false) 'ohne Tresor-Schritt braucht es keine Ressourcengruppe'
        Assert ($tf2 -match 'data "azurerm_key_vault" "kv_team_a"' -and $tf2 -match 'data "azuread_group" "kv_team_a_admin"' -and (& { ([regex]::Matches($tf2, '(?m)^resource "')).Count }) -eq 7) 'vorhandene Tresore und Gruppen als data, nur Zuweisungen als resource'
        $plan.steps.roles = $false; $plan.steps.vaults = $true
        Assert ((ConvertTo-KeevaultSetupTerraform $plan) -match 'data "azurerm_resource_group" "keevault"') 'Tresor ohne Ressourcengruppen-Schritt nutzt data'
        $evil = New-TestPlan; $evil.vaults[0].displayName = 'client secret: abc'
        Throws { ConvertTo-KeevaultSetupTerraform $evil } 'Terraform-Code nicht erzeugt' 'Geheimnis im Terraform-Code wird abgelehnt'
    }
}

# Part d: device policies (GPO, Intune, browser script).
. (Join-Path $PSScriptRoot 'DevicePolicy-Tests.ps1')
foreach ($k in $deviceScenarios.Keys) { $scenarios[$k] = $deviceScenarios[$k] }

# Part e: drift check and check against CIS/CISA.
. (Join-Path $PSScriptRoot 'Check-Tests.ps1')
foreach ($k in $checkScenarios.Keys) { $scenarios[$k] = $checkScenarios[$k] }

foreach ($name in $scenarios.Keys) {
    try { & $scenarios[$name]; [Console]::Out.WriteLine("PASS $name") }
    catch { [Console]::Out.WriteLine("FAIL $name -- $($_.Exception.Message) @ $($_.ScriptStackTrace -replace '\r?\n', ' | ')") }
}
