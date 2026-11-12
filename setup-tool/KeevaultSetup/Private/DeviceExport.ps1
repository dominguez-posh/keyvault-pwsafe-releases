# Device policy package (#501 part d): files for GPO and Intune from the choice in the plan. Nothing is written into a
# domain or a tenant here: the GPO script does that only when the admin runs it with -Apply and confirms, and the
# Intune profile is uploaded only by Publish-KeevaultSetupIntuneProfile (creates a new profile, never changes one).

function ConvertTo-KsTemplate([string] $Template, $Config) {
    $path = Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'Templates') $Template
    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8).TrimStart([char] 0xFEFF)
    # One line of JSON inside a single-quoted here-string: no expansion; the plan allows no line breaks in values.
    $json = $Config | ConvertTo-Json -Depth 8 -Compress
    if ($json -match '[\r\n]') { throw (KsT 'dp.lineBreak') }
    $why = Test-KsSecretLike $json
    if ($why) { throw (KsT 'dp.secret' $why) }
    return $text.Replace('__KEEVAULT_CONFIG__', $json)
}

function Get-KsDpName { return (KsT 'dp.gpoName') }

function Get-KsDevicePolicyFiles($Plan) {
    # Ordered: relative path -> text (scripts get a BOM when written, for Windows PowerShell 5.1) or byte[].
    if (-not (Test-KsDevicePolicyChosen $Plan)) { throw (KsT 'dp.nothing') }
    $values = @(Get-KsDevicePolicyValues $Plan)
    $name = Get-KsDpName
    $files = [ordered]@{}
    $admx = Get-KsAdmxPath
    $files['GPO/PolicyDefinitions/Keevault.admx'] = [System.IO.File]::ReadAllBytes((Join-Path $admx 'Keevault.admx'))
    foreach ($lang in 'de-DE', 'en-US') { $files["GPO/PolicyDefinitions/$lang/Keevault.adml"] = [System.IO.File]::ReadAllBytes((Join-Path (Join-Path $admx $lang) 'Keevault.adml')) }

    $gpoValues = @($values | ForEach-Object {
            [ordered]@{ hive = $_.Hive; key = $_.Key; name = $_.Name; type = $_.Type; value = $_.Value; browser = (-not $_.Policy -and $_.Name -ne 'NoExtensionPolicy') }
        })
    $files['GPO/New-KeevaultGpo.ps1'] = ConvertTo-KsTemplate 'New-KeevaultGpo.ps1' ([ordered]@{ gpoName = $name; marker = $script:KsDpMarker; comment = (KsT 'dp.intune.desc'); values = $gpoValues; own = @(Get-KsGpoOwn) })

    $intune = ConvertTo-KsIntuneProfile $Plan $name
    if ($intune) {
        # The ADMX inside is the fixed template; the secret check covers the rest of the profile.
        $check = @($intune.omaSettings | Select-Object -Skip 1 | ForEach-Object { $_.value + ' ' + $_.description }) -join "`n"
        $why = Test-KsSecretLike $check
        if ($why) { throw (KsT 'dp.secret' $why) }
        $files['Intune/Keevault-Richtlinien.intune.json'] = ($intune | ConvertTo-Json -Depth 8)
    }
    $d = $Plan.devicePolicy
    if (@($d.extensionBrowsers).Count) {
        $ext = Get-KsExtension $d
        $browsers = @(foreach ($b in $d.extensionBrowsers) {
                [ordered]@{ name = @{ edge = 'Edge'; chrome = 'Chrome' }[$b]; path = $script:KsBrowserBases[$b].Substring('SOFTWARE\Policies\'.Length); id = $ext.Id; forcelist = $ext.Forcelist; settings = $ext.Settings }
            })
        $browserScript = ConvertTo-KsTemplate 'Keevault-Browser-Richtlinie.ps1' ([ordered]@{
                browsers = $browsers; ownForcelist = $ext.OwnForcelist; ownSettings = $ext.OwnSettings; ownSource = $script:KsExtOwnSource })
        $files['Intune/Keevault-Browser-Erkennung.ps1'] = $browserScript.Replace("'__KEEVAULT_DETECT__'", "'yes'")
        $files['Intune/Keevault-Browser-Richtlinie.ps1'] = $browserScript
    }
    $guide = New-KsDevicePolicyGuide $Plan $values $name ([bool] $intune) (@($d.extensionBrowsers).Count -gt 0)
    $why = Test-KsSecretLike $guide
    if ($why) { throw (KsT 'dp.secret' $why) }
    $files[(KsT 'dp.guideFile')] = $guide
    return $files
}

function ConvertTo-KsCode([string] $Text) {
    # Code span in a Markdown table cell: no backtick can end it, a pipe would end the cell.
    return '`' + $Text.Replace('`', "'").Replace('|', '\|') + '`'
}

function New-KsDevicePolicyGuide($Plan, $Values, [string] $Name, [bool] $Intune, [bool] $Browser) {
    $md = New-Object System.Collections.Generic.List[string]
    $md.Add("# $(KsT 'dp.g.title')"); $md.Add('')
    $md.Add((KsT 'dp.g.intro')); $md.Add('')
    $md.Add("## $(KsT 'dp.g.values')"); $md.Add('')
    $md.Add("| $(KsT 'dp.rep.setting') | $(KsT 'dp.rep.key') | $(KsT 'dp.rep.value') | $(KsT 'dp.rep.data') |"); $md.Add('| --- | --- | --- | --- |')
    foreach ($v in $Values) {
        $n = $v.Name; if ($n -eq '*') { $n = KsT 'dp.rep.nextFree' }
        $md.Add("| $(ConvertTo-KsMd $v.Label) | $(ConvertTo-KsCode "$($v.Hive)\$($v.Key)") | $(ConvertTo-KsCode $n) | $(ConvertTo-KsCode ([string] $v.Value)) |")
    }
    $md.Add('')
    foreach ($section in @('gpo', 'intune', 'app')) {
        if ($section -eq 'intune' -and -not $Intune -and -not $Browser) { continue }
        $md.Add("## $(KsT "dp.g.$section")"); $md.Add('')
        $i = 1
        while ($script:KsText.ContainsKey("dp.g.$section.$i")) {
            $line = KsT "dp.g.$section.$i"
            $skip = ($line -like '*{intune}*' -and -not $Intune) -or ($line -like '*{browser}*' -and -not $Browser)
            if (-not $skip) { $md.Add(($line.Replace('{intune}', '').Replace('{browser}', '').Replace('{name}', $Name))) }
            $i++
        }
        $md.Add('')
    }
    $md.Add((KsT 'dp.g.foreign'))
    return ($md -join "`n")
}

function Export-KeevaultSetupDevicePolicy {
    <#
    .SYNOPSIS
        Geräte-Richtlinien als Dateien: ADMX/ADML, GPO-Skript (Probelauf ohne -Apply), Intune-Profil (JSON) und
        Browser-Skript, dazu eine Anleitung. Schreibt nur in -Path (Ordner) oder liefert mit -Zip die Bytes eines ZIP.
    .EXAMPLE
        $plan.devicePolicy.requirePin = $true
        Export-KeevaultSetupDevicePolicy -Plan $plan -Path .\Keevault-Richtlinien
    #>
    [CmdletBinding(SupportsShouldProcess)]
    param([Parameter(Mandatory)] $Plan, [string] $Path, [switch] $Zip)
    $check = Test-KeevaultSetupPlan $Plan
    if (-not $check.Valid) { throw ($check.Errors -join '; ') }
    $files = Get-KsDevicePolicyFiles $check.Plan
    $utf8 = New-Object System.Text.UTF8Encoding $false
    $bytesOf = {
        param([string] $Rel, $Content)
        if ($Content -is [byte[]]) { return , $Content }
        $b = $utf8.GetBytes($Content)
        if ($Rel -like '*.ps1') { $b = [byte[]] (@(0xEF, 0xBB, 0xBF) + $b) }
        return , $b
    }
    if ($Zip) {
        if (-not ('System.IO.Compression.ZipArchive' -as [type])) { Add-Type -AssemblyName System.IO.Compression }
        $ms = New-Object System.IO.MemoryStream
        $archive = New-Object System.IO.Compression.ZipArchive($ms, [System.IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($rel in $files.Keys) {
                $bytes = & $bytesOf $rel $files[$rel]
                $s = $archive.CreateEntry($rel).Open()
                try { $s.Write($bytes, 0, $bytes.Length) } finally { $s.Dispose() }
            }
        }
        finally { $archive.Dispose() }
        return , $ms.ToArray()
    }
    if (-not $Path) { throw (KsT 'dp.noPath') }
    if ($PSCmdlet.ShouldProcess($Path, (KsT 'dp.write'))) {
        foreach ($rel in $files.Keys) {
            $target = Join-Path $Path ($rel -replace '/', [System.IO.Path]::DirectorySeparatorChar)
            New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
            [System.IO.File]::WriteAllBytes($target, (& $bytesOf $rel $files[$rel]))
        }
    }
    return @($files.Keys)
}

function Publish-KeevaultSetupIntuneProfile {
    <#
    .SYNOPSIS
        Optional: legt das Intune-Profil per Microsoft Graph neu an, wenn das Token es darf
        (DeviceManagementConfiguration.ReadWrite.All). Ändert nie ein vorhandenes Profil: gibt es schon eines mit dem
        Namen, bricht es ab. Ohne Recht: Datei aus Export-KeevaultSetupDevicePolicy importieren (Standardweg).
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param([Parameter(Mandatory)] $Plan, [string] $Name)
    Assert-KsSignedIn
    $check = Test-KeevaultSetupPlan $Plan
    if (-not $check.Valid) { throw ($check.Errors -join '; ') }
    if (-not $Name) { $Name = Get-KsDpName }
    $intune = ConvertTo-KsIntuneProfile $check.Plan $Name
    if (-not $intune) { throw (KsT 'dp.noIntune') }
    $uri = "$($script:KsGraph)/deviceManagement/deviceConfigurations"
    $filter = [uri]::EscapeDataString("displayName eq '$($Name.Replace("'", "''"))'")
    $r = Invoke-KsRest GET "$uri`?`$select=id,displayName&`$filter=$filter" -Ok 401, 403
    if ($r.Status -eq 401 -or $r.Status -eq 403) { throw (KsT 'dp.graphDenied') }
    if (@($r.Body.value).Count) { throw (KsT 'dp.graphExists' $Name) }
    if (-not $PSCmdlet.ShouldProcess($Name, (KsT 'dp.graphCreate'))) { return $null }
    $created = Invoke-KsRest POST $uri $intune -Ok 401, 403
    if ($created.Status -eq 401 -or $created.Status -eq 403) { throw (KsT 'dp.graphDenied') }
    return [pscustomobject]@{ Id = [string] $created.Body.id; Name = $Name }
}
