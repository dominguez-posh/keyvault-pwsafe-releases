# Scenarios for the device policies (#501 part d), dot-sourced by Run-Tests.ps1 (uses its Assert, Throws, New-TestPlan
# and the stub). Placeholder data only. The GPO script runs against stand-ins for the GroupPolicy cmdlets, the browser
# script against a test key below HKCU; nothing touches a domain, a tenant or HKLM.

function New-DpPlan {
    $plan = New-TestPlan
    $plan.vaults = @([ordered]@{ name = 'kv-team-a'; displayName = 'Team "A" & B' })
    return $plan
}
function Get-DpFiles($Plan) {
    $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('ks-dp-' + [guid]::NewGuid().ToString('n'))
    $rel = @(Export-KeevaultSetupDevicePolicy -Plan $Plan -Path $dir)
    $files = [ordered]@{}
    foreach ($r in $rel) { $files[$r] = [System.IO.File]::ReadAllText((Join-Path $dir $r), [System.Text.Encoding]::UTF8).TrimStart([char] 0xFEFF) }
    Remove-Item -LiteralPath $dir -Recurse -Force
    return $files
}
function Get-DpConfig([string] $Script) {
    $m = [regex]::Match($Script, "(?s)\`$ConfigJson = @'\r?\n(.*?)\r?\n'@")
    Assert $m.Success 'Konfiguration im Skript gefunden'
    return ($m.Groups[1].Value | ConvertFrom-Json)
}
function Test-DpSecret([string] $Text) { return (& (Get-Module KeevaultSetup) { param($t) Test-KsSecretLike $t } $Text) }

$global:KsGpLog = New-Object System.Collections.ArrayList
$global:KsGpState = @{ Own = $null; Others = @() }
function Install-GpStubs {
    # Stand-ins for the GroupPolicy module: they log every write, reads come from $global:KsGpState.
    function global:Get-GPO { param([string] $Name, [switch] $All, [string] $Domain, $ErrorAction)
        if ($All) { return @(@($global:KsGpState.Own) + $global:KsGpState.Others | Where-Object { $_ }) }
        $g = @(@($global:KsGpState.Own) + $global:KsGpState.Others | Where-Object { $_ -and $_.DisplayName -eq $Name })
        if (-not $g.Count) { throw "GPO $Name nicht gefunden" }
        return $g[0] }
    function global:Get-GPRegistryValue { param($Guid, [string] $Key, [string] $ValueName, [string] $Domain, $ErrorAction)
        $g = @(@($global:KsGpState.Own) + $global:KsGpState.Others | Where-Object { $_ -and $_.Id -eq $Guid })
        $hits = @(if ($g.Count) { $g[0].Values | Where-Object { $_.Key -eq $Key -and (-not $ValueName -or $_.ValueName -eq $ValueName) } })
        if (-not $hits.Count) { throw 'nicht gesetzt' }
        return $hits }
    # Preferences (GPP registry items) of a GPO: .Prefs, same shape as .Values plus Context.
    function global:Get-GPPrefRegistryValue { param($Guid, [string] $Context, [string] $Key, [string] $ValueName, [string] $Domain, $ErrorAction)
        $g = @(@($global:KsGpState.Own) + $global:KsGpState.Others | Where-Object { $_ -and $_.Id -eq $Guid })
        $hits = @(if ($g.Count) { $g[0].Prefs | Where-Object { $_.Context -eq $Context -and $_.Key -eq $Key -and (-not $ValueName -or $_.ValueName -eq $ValueName) } })
        if (-not $hits.Count) { throw 'nicht gesetzt' }
        return $hits }
    function global:New-GPO { param([string] $Name, [string] $Comment, [string] $Domain) [void] $global:KsGpLog.Add("New-GPO $Name | $Comment"); return [pscustomobject]@{ Id = [guid]::NewGuid(); DisplayName = $Name; Description = $Comment } }
    function global:Set-GPRegistryValue { param($Guid, [string] $Key, [string] $ValueName, [string] $Type, $Value, [string] $Domain) [void] $global:KsGpLog.Add("Set $Key|$ValueName|$Type|$Value") }
    function global:Remove-GPRegistryValue { param($Guid, [string] $Key, [string] $ValueName, [string] $Domain, $ErrorAction) [void] $global:KsGpLog.Add("Remove $Key|$ValueName") }
}
function Remove-GpStubs { foreach ($f in 'Get-GPO', 'Get-GPRegistryValue', 'Get-GPPrefRegistryValue', 'New-GPO', 'Set-GPRegistryValue', 'Remove-GPRegistryValue') { Remove-Item "function:global:$f" -ErrorAction SilentlyContinue } }
function Invoke-GpScript([string] $Path, [hashtable] $Params) {
    $global:KsGpLog.Clear()
    $global:LASTEXITCODE = 0
    $out = try { & $Path @Params 2>&1 | Out-String } catch { "THROWN: $($_.Exception.Message)" }
    return [pscustomobject]@{ Out = $out; Exit = $global:LASTEXITCODE; Writes = @($global:KsGpLog) }
}

$deviceScenarios = [ordered]@{
    'device policy: strict validation, old plans valid, portable export drops tenant and client' = {
        $old = (ConvertTo-KeevaultSetupPlanJson (New-TestPlan) | ConvertFrom-Json)
        $old.PSObject.Properties.Remove('devicePolicy')
        $check = Test-KeevaultSetupPlan $old
        Assert ($check.Valid -and $check.Plan.devicePolicy.scope -eq 'machine' -and $null -eq $check.Plan.devicePolicy.requirePin) 'Plan ohne devicePolicy bleibt gültig, nichts gewählt'
        $bad = @(
            @{ Change = { param($d) $d.scope = 'domain' }; Pattern = 'scope' }
            @{ Change = { param($d) $d.requirePin = 'ja' }; Pattern = 'requirePin' }
            @{ Change = { param($d) $d.updateChannel = 'nightly' }; Pattern = 'updateChannel' }
            @{ Change = { param($d) $d.extensionBrowsers = 'edge' }; Pattern = 'extensionBrowsers' }
            @{ Change = { param($d) $d.extensionBrowsers = @('firefox') }; Pattern = 'extensionBrowsers' }
            @{ Change = { param($d) $d.tenantId = 'kein tenant!' }; Pattern = 'tenantId' }
            @{ Change = { param($d) $d.clientId = 'abc' }; Pattern = 'clientId' }
            @{ Change = { param($d) $d['password'] = 'x' }; Pattern = "Unbekanntes Feld 'password'" }
            @{ Change = { param($d) $d.extensionBrowsers = @('edge'); $d.extensionSource = 'store' }; Pattern = '#483' }
        )
        foreach ($case in $bad) {
            $p = New-TestPlan
            & $case.Change $p.devicePolicy
            $c = Test-KeevaultSetupPlan $p
            Assert (-not $c.Valid -and ($c.Errors -join ' ') -match $case.Pattern) "nicht abgelehnt oder falsche Meldung ($($case.Pattern)): $($c.Errors -join ' ')"
        }
        # Review #501 (low): U+F000 separates the VaultsList pairs in the Intune profile; private-use and format
        # characters (zero-width, bidi overrides) are refused in display names, like control characters.
        foreach ($c in 0xF000, 0xE000, 0x200B, 0x202E, 0xFEFF, 0x85) {
            $p = New-TestPlan
            $p.vaults[0].displayName = 'Team' + [char] $c + 'X'
            $chk = Test-KeevaultSetupPlan $p
            Assert (-not $chk.Valid -and ($chk.Errors -join ' ') -match 'Anzeigename') ("Anzeigename mit U+{0:X4} nicht abgelehnt" -f $c)
        }
        $p = New-TestPlan; $p.vaults[0].displayName = 'Team Ä – Zürich'
        Assert (Test-KeevaultSetupPlan $p).Valid 'normaler Anzeigename mit Umlaut und Gedankenstrich gilt'
        $p = New-TestPlan
        $p.devicePolicy.tenantId = '00000000-0000-0000-0000-00000000bbbb'; $p.devicePolicy.clientId = '00000000-0000-0000-0000-0000000000cc'
        $p.devicePolicy.extensionBrowsers = @('chrome', 'edge', 'edge')
        $c = Test-KeevaultSetupPlan $p
        Assert ($c.Valid -and (@($c.Plan.devicePolicy.extensionBrowsers) -join ',') -eq 'edge,chrome') 'Browser in fester Reihenfolge, ohne Doppelte'
        $portable = ConvertTo-KeevaultSetupPlanJson $p -Portable | ConvertFrom-Json
        Assert (-not $portable.devicePolicy.tenantId -and -not $portable.devicePolicy.clientId) 'portabel ohne Tenant- und Client-ID'
        $back = Import-KeevaultSetupPlan -Json (ConvertTo-KeevaultSetupPlanJson $p)
        Assert ($back.devicePolicy.clientId -eq '00000000-0000-0000-0000-0000000000cc') 'Export/Import behält die Richtlinien'
    }
    'device policy: files contain only the chosen values and no secrets' = {
        $plan = New-DpPlan
        Throws { Get-DpFiles $plan } 'Keine Geräte-Richtlinie' 'ohne Auswahl kein Paket'
        $plan.devicePolicy.requirePin = $true
        $files = Get-DpFiles $plan
        Assert ((@($files.Keys) -join ',') -eq 'GPO/PolicyDefinitions/Keevault.admx,GPO/PolicyDefinitions/de-DE/Keevault.adml,GPO/PolicyDefinitions/en-US/Keevault.adml,GPO/New-KeevaultGpo.ps1,Intune/Keevault-Richtlinien.intune.json,Anleitung.md') "Dateien: $(@($files.Keys) -join ',')"
        $cfg = Get-DpConfig $files['GPO/New-KeevaultGpo.ps1']
        Assert (@($cfg.values).Count -eq 1 -and $cfg.values[0].name -eq 'RequirePin' -and $cfg.values[0].value -eq 1 -and $cfg.values[0].hive -eq 'HKLM') "GPO-Werte: $(@($cfg.values | ForEach-Object { $_.name }) -join ',')"
        $intune = $files['Intune/Keevault-Richtlinien.intune.json'] | ConvertFrom-Json
        Assert ((@($intune.omaSettings | ForEach-Object { $_.omaUri.Split('/')[-1] }) -join ',') -eq 'KeevaultAdmx,RequirePin') "Intune-Werte: $(@($intune.omaSettings | ForEach-Object { $_.omaUri }) -join ',')"
        foreach ($other in 'UpdateChannel', 'TenantId', 'ClientId', 'WindowsProvider', 'BrowserIntegration', 'ExtensionSettings', 'Forcelist', 'kv-team-a', $script:FakeTenant, $script:FakeSub) {
            # The script itself is fixed code (its help names every policy); what it writes is its configuration's values
            # (the fixed list "own" names everything it may remove from its own GPO, chosen or not).
            Assert (-not $files['Anleitung.md'].Contains($other) -and -not (ConvertTo-Json @($cfg.values) -Depth 6 -Compress).Contains($other)) "nicht gewählt und trotzdem drin: $other"
        }
        # Everything chosen: each value once, browser values only for the chosen browser, then no secret anywhere.
        $d = $plan.devicePolicy
        $d.updateChannel = 'beta'; $d.updateMode = 'ask'; $d.browserIntegration = $true; $d.windowsProvider = $false
        $d.tenantId = 'contoso.onmicrosoft.com'; $d.clientId = '00000000-0000-0000-0000-0000000000cc'; $d.connectVaults = $true; $d.extensionBrowsers = @('edge')
        $files = Get-DpFiles $plan
        $cfg = Get-DpConfig $files['GPO/New-KeevaultGpo.ps1']
        $names = @($cfg.values | ForEach-Object { $_.name }) -join ','
        # Review #501 (medium): the GPO sets only the Forcelist entry, never ExtensionSettings (one JSON value for every
        # extension: it would replace a company blocklist); only the Intune remediation script sets it after checking.
        Assert ($names -eq 'RequirePin,UpdateChannel,UpdateMode,BrowserIntegration,WindowsProvider,TenantId,ClientId,Team "A" & B,*,NoExtensionPolicy') "GPO-Werte: $names"
        Assert (-not (ConvertTo-Json @($cfg.values) -Depth 6 -Compress).Contains('ExtensionSettings')) 'GPO setzt ExtensionSettings'
        $fl = @($cfg.values | Where-Object { $_.name -eq '*' })[0]
        Assert ($fl.key -eq 'SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist' -and $fl.value -eq 'pbkjijhihclckeeefbepoedgdmajioip;https://raw.githubusercontent.com/dominguez-posh/keyvault-pwsafe-releases/early-access/update-ea.xml') "Forcelist mit Update-Adresse: $($fl.key) $($fl.value)"
        Assert ($files['Anleitung.md'].Contains('Grenze:') -and $files['Anleitung.md'].Contains('Chrome Browser Cloud Management') -and $files['Anleitung.md'].Contains('GPP')) 'Anleitung nennt die Grenze der Prüfung'
        Assert (-not (@($files.Keys | Where-Object { $_ -ne 'GPO/New-KeevaultGpo.ps1' } | ForEach-Object { $files[$_] }) + (ConvertTo-Json @($cfg.values) -Depth 6) -join "`n").Contains('Google\Chrome')) 'Chrome nicht gewählt, nicht drin'
        foreach ($rel in @($files.Keys | Where-Object { $_ -notlike 'GPO/PolicyDefinitions/*' })) {
            $text = $files[$rel]
            if ($rel -like '*.intune.json') { $j = $text | ConvertFrom-Json; $j.omaSettings[0].value = ''; $text = $j | ConvertTo-Json -Depth 8 }
            $why = Test-DpSecret $text
            Assert (-not $why) "$rel sieht nach Geheimnis aus: $why"
        }
        Assert (-not ($files.Values -join "`n").Contains($script:FakeTenant)) 'Tenant des Plans nur, wenn als Richtlinie gewählt'
        $evil = New-DpPlan; $evil.vaults[0].displayName = 'client secret: abc'; $evil.devicePolicy.connectVaults = $true
        Throws { Get-DpFiles $evil } 'nicht erzeugt' 'Geheimnis in einem Wert wird abgelehnt'
    }
    'device policy: ADMX and ADML are valid XML, the Intune JSON matches the schema' = {
        $plan = New-DpPlan
        $d = $plan.devicePolicy
        $d.requirePin = $false; $d.updateChannel = 'stable'; $d.windowsProvider = $true; $d.tenantId = '00000000-0000-0000-0000-00000000bbbb'; $d.connectVaults = $true; $d.scope = 'user'
        $files = Get-DpFiles $plan
        $admx = [xml] $files['GPO/PolicyDefinitions/Keevault.admx']
        Assert ($admx.policyDefinitions.NamespaceURI -eq 'http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions') 'ADMX-Namensraum'
        $policies = @{}
        foreach ($p in $admx.policyDefinitions.policies.policy) { $policies[$p.name] = $p }
        foreach ($lang in 'de-DE', 'en-US') {
            $adml = [xml] $files["GPO/PolicyDefinitions/$lang/Keevault.adml"]
            Assert (@($adml.policyDefinitionResources.resources.stringTable.string | Where-Object { $_.id -eq 'UpdateChannel' }).Count -eq 1) "$lang`: UpdateChannel"
        }
        $j = $files['Intune/Keevault-Richtlinien.intune.json'] | ConvertFrom-Json
        Assert ((@($j.PSObject.Properties.Name) -join ',') -eq '@odata.type,displayName,description,omaSettings') "Felder des Profils: $(@($j.PSObject.Properties.Name) -join ',')"
        Assert ($j.'@odata.type' -eq '#microsoft.graph.windows10CustomConfiguration' -and $j.displayName -is [string] -and $j.description -like 'Keevault-Einrichtungstool (#501)*') 'Profiltyp, Name, Kennzeichen'
        $first = $true
        foreach ($s in $j.omaSettings) {
            Assert ((@($s.PSObject.Properties.Name) -join ',') -eq '@odata.type,displayName,description,omaUri,value') "Felder einer Einstellung: $(@($s.PSObject.Properties.Name) -join ',')"
            Assert ($s.'@odata.type' -eq '#microsoft.graph.omaSettingString' -and $s.value -is [string] -and $s.displayName) 'omaSettingString mit Text'
            if ($first) {
                Assert ($s.omaUri -eq './Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/Keevault/Policy/KeevaultAdmx') "ADMX-Ingestion zuerst: $($s.omaUri)"
                Assert ($s.value -eq $files['GPO/PolicyDefinitions/Keevault.admx']) 'Ingestion enthält genau die ADMX'
                $first = $false; continue
            }
            $m = [regex]::Match($s.omaUri, '^\./User/Vendor/MSFT/Policy/Config/Keevault~Policy~Keevault/(\w+)$')
            Assert $m.Success "OMA-URI: $($s.omaUri)"
            $policy = $policies[$m.Groups[1].Value]
            Assert $policy "Richtlinie $($m.Groups[1].Value) fehlt in der ADMX"
            $x = [xml] "<r>$($s.value)</r>"
            Assert (@($x.r.ChildNodes)[0].LocalName -in 'enabled', 'disabled') "enabled/disabled: $($s.value)"
            foreach ($data in @($x.r.SelectNodes('data'))) {
                $ids = @($policy.elements.ChildNodes | ForEach-Object { $_.id })
                Assert ($ids -contains $data.id) "Element $($data.id) nicht in $($policy.name)"
            }
        }
        $vaults = @($j.omaSettings | Where-Object { $_.omaUri -like '*/Vaults' })[0]
        Assert (([xml] "<r>$($vaults.value)</r>").r.data.value -eq ('Team "A" & B' + [char] 0xF000 + 'https://kv-team-a.vault.azure.net/')) "Tresorliste escaped: $($vaults.value)"
        $pin = @($j.omaSettings | Where-Object { $_.omaUri -like '*/RequirePin' })[0]
        Assert ($pin.value -eq '<disabled/>') 'RequirePin aus = disabled'
    }
    'device policy: the GPO script changes nothing without -Apply and confirmation, never a foreign GPO' = {
        $plan = New-DpPlan
        $plan.devicePolicy.requirePin = $true; $plan.devicePolicy.extensionBrowsers = @('edge')
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('ks-gpo-' + [guid]::NewGuid().ToString('n'))
        Export-KeevaultSetupDevicePolicy -Plan $plan -Path $dir | Out-Null
        $gpo = Join-Path $dir 'GPO\New-KeevaultGpo.ps1'
        Install-GpStubs
        try {
            $global:KsGpState = @{ Own = $null; Others = @() }
            $r = Invoke-GpScript $gpo @{}
            Assert ($r.Writes.Count -eq 0 -and $r.Exit -eq 0 -and $r.Out -match 'Probelauf: nichts geändert' -and $r.Out -match 'RequirePin = 1') "Probelauf: $($r.Out) / $($r.Writes -join '; ')"
            Assert ($r.Out -match 'Grenze: .*GPP.*Intune, Chrome Browser Cloud Management' -and $r.Out -notmatch 'ExtensionSettings \(') "Probelauf nennt die Grenze nicht: $($r.Out)"
            $r = Invoke-GpScript $gpo @{ Apply = $true; WhatIf = $true }
            Assert ($r.Writes.Count -eq 0) "-WhatIf schrieb: $($r.Writes -join '; ')"
            # -NonInteractive: the confirmation prompt cannot be answered, so nothing may be written.
            $r = Invoke-GpScript $gpo @{ Apply = $true }
            Assert ($r.Writes.Count -eq 0) "ohne Bestätigung geschrieben: $($r.Writes -join '; ')"
            $r = Invoke-GpScript $gpo @{ Apply = $true; Confirm = $false }
            # A new GPO: nothing to remove; only the Forcelist entry for the browser, never ExtensionSettings.
            $want = @('New-GPO Keevault - Richtlinien | Keevault-Einrichtungstool (#501)*',
                'Set HKLM\SOFTWARE\Policies\Keevault|RequirePin|DWord|1', 'Set HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist|1|String|pbkjijhihclckeeefbepoedgdmajioip;https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/latest/download/update.xml',
                'Set HKLM\SOFTWARE\Keevault|NoExtensionPolicy|DWord|1')
            Assert (-not ($r.Writes -like '*ExtensionSettings*')) "GPO schreibt ExtensionSettings: $($r.Writes -join ' ; ')"
            Assert ($r.Writes.Count -eq $want.Count) "Schreibvorgänge: $($r.Writes -join ' ; ')"
            Assert ($r.Writes[0] -like $want[0]) "neues GPO mit Kennzeichen: $($r.Writes[0])"
            foreach ($w in $want[1..($want.Count - 1)]) { Assert ($r.Writes -contains $w) "fehlt: $w" }
            # A GPO of the same name that this script did not create stays untouched.
            $global:KsGpState = @{ Own = [pscustomobject]@{ Id = [guid]::NewGuid(); DisplayName = 'Keevault - Richtlinien'; Description = 'Von Hand angelegt' }; Others = @() }
            $r = Invoke-GpScript $gpo @{ Apply = $true; Confirm = $false }
            Assert ($r.Writes.Count -eq 0 -and $r.Exit -eq 2) "fremdes GPO verändert oder kein Abbruch: $($r.Exit) $($r.Writes -join '; ')"
            # Another GPO already sets the Edge Forcelist: stop, change nothing.
            $other = [pscustomobject]@{ Id = [guid]::NewGuid(); DisplayName = 'Firma Edge'; Description = ''; Values = @([pscustomobject]@{ Key = 'HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist'; ValueName = '1' }) }
            $global:KsGpState = @{ Own = $null; Others = @($other) }
            $r = Invoke-GpScript $gpo @{ Apply = $true; Confirm = $false }
            Assert ($r.Writes.Count -eq 0 -and $r.Exit -eq 3 -and $r.Out -match 'Firma Edge') "Konflikt nicht erkannt: $($r.Exit) $($r.Out)"
            # The same through the preferences (GPP registry item) of another GPO: also a conflict.
            $gpp = [pscustomobject]@{ Id = [guid]::NewGuid(); DisplayName = 'Firma GPP'; Description = ''; Values = @(); Prefs = @([pscustomobject]@{ Context = 'Computer'; Key = 'HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist'; ValueName = '1' }) }
            $global:KsGpState = @{ Own = $null; Others = @($gpp) }
            $r = Invoke-GpScript $gpo @{ Apply = $true; Confirm = $false }
            Assert ($r.Writes.Count -eq 0 -and $r.Exit -eq 3 -and $r.Out -match 'Firma GPP \(Einstellungen/GPP\)') "GPP-Konflikt nicht erkannt: $($r.Exit) $($r.Out)"
            # Its own GPO from an earlier run is updated: only the values this script writes are removed (by name or
            # content), never a whole key; the admin's own Edge setting, a foreign Forcelist entry and a non-vault value stay.
            $kv = { param($k, $n, $v) [pscustomobject]@{ Key = $k; ValueName = $n; Value = $v } }
            $own = [pscustomobject]@{ Id = [guid]::NewGuid(); DisplayName = 'Keevault - Richtlinien'; Description = 'Keevault-Einrichtungstool (#501). x'; Values = @(
                    (& $kv 'HKLM\SOFTWARE\Policies\Keevault' 'RequirePin' 0), (& $kv 'HKLM\SOFTWARE\Policies\Keevault' 'UpdateChannel' 'beta'), (& $kv 'HKLM\SOFTWARE\Policies\Keevault' 'Fremd' 'x'),
                    (& $kv 'HKLM\SOFTWARE\Policies\Keevault\Vaults' 'Alt' 'https://kv-old.vault.azure.net/'), (& $kv 'HKLM\SOFTWARE\Policies\Keevault\Vaults' 'Notiz' 'https://example.invalid/'),
                    (& $kv 'HKLM\SOFTWARE\Policies\Microsoft\Edge' 'HomepageLocation' 'https://intranet.example.invalid/'),
                    (& $kv 'HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist' '1' 'pbkjijhihclckeeefbepoedgdmajioip;https://github.com/dominguez-posh/old.xml'),
                    (& $kv 'HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist' '2' 'aaaabbbbccccddddeeeeffffgggghhhh;https://example.invalid/u.xml'),
                    (& $kv 'HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist' '3' 'pbkjijhihclckeeefbepoedgdmajioip;https://github.com/dominguez-posh/old.xml'),
                    (& $kv 'HKLM\SOFTWARE\Keevault' 'NoExtensionPolicy' 1)) }
            $global:KsGpState = @{ Own = $own; Others = @() }
            $r = Invoke-GpScript $gpo @{ Apply = $true; Confirm = $false }
            $removed = @($r.Writes -like 'Remove *' | Sort-Object)
            $wantRemoved = @('Remove HKLM\SOFTWARE\Keevault|NoExtensionPolicy', 'Remove HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist|3', 'Remove HKLM\SOFTWARE\Policies\Keevault\Vaults|Alt',
                'Remove HKLM\SOFTWARE\Policies\Keevault|RequirePin', 'Remove HKLM\SOFTWARE\Policies\Keevault|UpdateChannel', 'Remove HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist|1') | Sort-Object
            Assert (($removed -join ';') -eq ($wantRemoved -join ';')) "entfernt: $($removed -join ' ; ')"
            Assert ($r.Exit -eq 0 -and ($r.Writes.Count - $removed.Count) -eq ($want.Count - 1) -and -not ($r.Writes -like 'New-GPO*')) "eigenes GPO aktualisieren: $($r.Writes -join '; ')"
        }
        finally { Remove-GpStubs; Remove-Item -LiteralPath $dir -Recurse -Force }
    }
    'device policy: the browser script sets only its own values and leaves foreign ones alone' = {
        $plan = New-DpPlan
        $plan.devicePolicy.updateChannel = 'beta'; $plan.devicePolicy.extensionBrowsers = @('edge', 'chrome')
        $dir = Join-Path ([System.IO.Path]::GetTempPath()) ('ks-br-' + [guid]::NewGuid().ToString('n'))
        Export-KeevaultSetupDevicePolicy -Plan $plan -Path $dir | Out-Null
        $fix = Join-Path $dir 'Intune\Keevault-Browser-Richtlinie.ps1'
        $detect = Join-Path $dir 'Intune\Keevault-Browser-Erkennung.ps1'
        $root = 'HKCU:\Software\KeevaultSetupTest-' + [guid]::NewGuid().ToString('n')
        $pol = "$root\Policies"; $mark = "$root\Keevault"
        $id = 'pbkjijhihclckeeefbepoedgdmajioip'
        $ea = "$id;https://raw.githubusercontent.com/dominguez-posh/keyvault-pwsafe-releases/early-access/update-ea.xml"
        $run = { param($Path, [hashtable] $More = @{}) $global:LASTEXITCODE = 0; $o = & $Path -PolicyRoot $pol -MarkPath $mark @More | Out-String; [pscustomobject]@{ Out = $o; Exit = $global:LASTEXITCODE } }
        $list = { param($b) $k = "$pol\$b\ExtensionInstallForcelist"; if (Test-Path $k) { $i = Get-Item $k; @($i.GetValueNames() | Sort-Object | ForEach-Object { "$_=$($i.GetValue($_))" }) -join ',' } else { '' } }
        try {
            $r = & $run $detect
            Assert ($r.Exit -eq 1 -and -not (Test-Path $root)) "Erkennung: Exit $($r.Exit), schrieb $(Test-Path $root)"
            # Edge: a foreign extension at 1 and our old stable entry at 2; Chrome: a foreign entry with our ID.
            New-Item "$pol\Microsoft\Edge\ExtensionInstallForcelist" -Force | Out-Null
            New-ItemProperty "$pol\Microsoft\Edge\ExtensionInstallForcelist" -Name '1' -Value 'aaaabbbbccccddddeeeeffffgggghhhh;https://example.invalid/u.xml' | Out-Null
            New-ItemProperty "$pol\Microsoft\Edge\ExtensionInstallForcelist" -Name '2' -Value "$id;https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/latest/download/update.xml" | Out-Null
            New-Item "$pol\Google\Chrome\ExtensionInstallForcelist" -Force | Out-Null
            New-ItemProperty "$pol\Google\Chrome\ExtensionInstallForcelist" -Name '1' -Value "$id;https://example.invalid/company.xml" | Out-Null
            $r = & $run $fix
            Assert ($r.Exit -eq 0) "Korrektur Exit $($r.Exit): $($r.Out)"
            Assert ((& $list 'Microsoft\Edge') -eq "1=aaaabbbbccccddddeeeeffffgggghhhh;https://example.invalid/u.xml,2=$ea") "Edge-Liste: $(& $list 'Microsoft\Edge')"
            Assert ((Get-ItemProperty "$pol\Microsoft\Edge").ExtensionSettings -like '*early-access/update-ea.xml*') 'Edge: ExtensionSettings gesetzt'
            Assert ((& $list 'Google\Chrome') -eq "1=$id;https://example.invalid/company.xml" -and $null -eq (Get-ItemProperty "$pol\Google\Chrome").ExtensionSettings) "Chrome fremd, unverändert: $(& $list 'Google\Chrome')"
            Assert ($r.Out -match 'Chrome: Richtlinie der Firma') 'Chrome als Firmenrichtlinie gemeldet'
            Assert ((Get-ItemProperty $mark).NoExtensionPolicy -eq 1) 'NoExtensionPolicy gesetzt'
            $r = & $run $detect
            Assert ($r.Exit -eq 0) "nach der Korrektur meldet die Erkennung nichts: $($r.Out)"
            # A foreign ExtensionSettings: Edge is the company's from then on, nothing changes.
            Set-ItemProperty "$pol\Microsoft\Edge" -Name ExtensionSettings -Value '{"*":{"installation_mode":"blocked"}}'
            Remove-ItemProperty "$pol\Microsoft\Edge\ExtensionInstallForcelist" -Name '2'
            & $run $fix | Out-Null
            Assert ((& $list 'Microsoft\Edge') -eq '1=aaaabbbbccccddddeeeeffffgggghhhh;https://example.invalid/u.xml') 'fremdes ExtensionSettings: Edge unverändert'
            Set-ItemProperty "$pol\Microsoft\Edge" -Name ExtensionSettings -Value ('{"' + $id + '":{"update_url":"https://raw.githubusercontent.com/dominguez-posh/keyvault-pwsafe-releases/early-access/update-ea.xml","override_update_url":true}}')
            & $run $fix | Out-Null
            Assert ((& $list 'Microsoft\Edge') -eq "1=aaaabbbbccccddddeeeeffffgggghhhh;https://example.invalid/u.xml,2=$ea") 'erste freie Nummer'
            $r = & $run $fix @{ Remove = $true }
            Assert ((& $list 'Microsoft\Edge') -eq '1=aaaabbbbccccddddeeeeffffgggghhhh;https://example.invalid/u.xml' -and $null -eq (Get-ItemProperty "$pol\Microsoft\Edge").ExtensionSettings) 'Entfernen: nur eigene Werte'
            Assert ((& $list 'Google\Chrome') -eq "1=$id;https://example.invalid/company.xml" -and $null -eq (Get-ItemProperty $mark).NoExtensionPolicy) 'Entfernen: Fremdes bleibt, Kennzeichen weg'
        }
        finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $dir -Recurse -Force }
    }
    'device policy: Graph upload only creates a new profile, never changes one, and only with confirmation' = {
        $log = New-Object System.Collections.ArrayList
        $state = @{ Existing = @(); Status = 200 }
        $transport = {
            param([string] $Method, [string] $Uri, [string] $Payload)
            [void] $log.Add("$Method $(([uri] $Uri).AbsolutePath)")
            if ($state.Status -ne 200) { return [pscustomobject]@{ StatusCode = $state.Status; Content = '{"error":{"message":"Forbidden"}}' } }
            if ($Method -eq 'GET') { return [pscustomobject]@{ StatusCode = 200; Content = (@{ value = $state.Existing } | ConvertTo-Json -Compress) } }
            return [pscustomobject]@{ StatusCode = 201; Content = '{"id":"11111111-1111-1111-1111-111111111111"}' }
        }.GetNewClosure()
        Set-KeevaultSetupTransport -Transport $transport -TenantId $script:FakeTenant -SubscriptionId $script:FakeSub -Account 'admin@contoso.example'
        $plan = New-DpPlan; $plan.devicePolicy.requirePin = $true
        $state.Status = 403
        Throws { Publish-KeevaultSetupIntuneProfile -Plan $plan -Confirm:$false } 'Datei Keevault-Richtlinien.intune.json importieren' 'ohne Recht: Hinweis auf die Datei'
        $state.Status = 200; $state.Existing = @(@{ id = 'x'; displayName = 'Keevault - Richtlinien' })
        Throws { Publish-KeevaultSetupIntuneProfile -Plan $plan -Confirm:$false } 'bleibt unverändert' 'vorhandenes Profil'
        $state.Existing = @()
        Publish-KeevaultSetupIntuneProfile -Plan $plan -WhatIf | Out-Null
        Assert (-not ($log -like 'POST*')) "-WhatIf legte an: $($log -join '; ')"
        $made = Publish-KeevaultSetupIntuneProfile -Plan $plan -Confirm:$false
        Assert ($made.Id -eq '11111111-1111-1111-1111-111111111111' -and @($log -like 'POST*').Count -eq 1) "ein POST: $($log -join '; ')"
        Assert (-not ($log -match '^(PATCH|PUT|DELETE)')) "verändert oder gelöscht: $($log -join '; ')"
    }
    'device policy: the documentation lists the chosen policies' = {
        $fake = New-KsFake; Use-Fake $fake
        $plan = New-TestPlan
        $plan.devicePolicy.requirePin = $true; $plan.devicePolicy.updateChannel = 'beta'
        $md = New-KeevaultSetupReport -Result (Invoke-KeevaultSetup -Plan $plan -WhatIf)
        foreach ($want in '## Geräte-Richtlinien (GPO und Intune)', 'App-PIN verlangen', 'RequirePin', 'UpdateChannel', 'GPO verknüpft') { Assert ($md.Contains($want)) "Doku enthält nicht: $want" }
        Assert (-not $md.Contains('ExtensionSettings')) 'nicht gewählte Browser-Richtlinie steht nicht in der Doku'
        $none = New-KeevaultSetupReport -Result (Invoke-KeevaultSetup -Plan (New-TestPlan) -WhatIf)
        Assert (-not $none.Contains('Geräte-Richtlinien')) 'ohne Auswahl kein Abschnitt'
    }
}
