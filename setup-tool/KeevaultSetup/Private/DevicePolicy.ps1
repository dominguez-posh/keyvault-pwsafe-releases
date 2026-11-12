# Device policies (#501 part d): the admin's choice in the plan (devicePolicy), the registry values it means, and the
# Intune profile (custom OMA-URI with ADMX ingestion). The values are exactly those the app reads (desktop/policy.js)
# and, for the browser extension, the fixed values of desktop/machine-setup.js; test/setup-tool-501.test.js compares
# them. Only what the admin chose is written; nothing here contains a secret (IDs, URLs and switches only).

$script:KsExtId = 'pbkjijhihclckeeefbepoedgdmajioip'
$script:KsExtFeeds = [ordered]@{
    stable = 'https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/latest/download/update.xml'
    beta   = 'https://raw.githubusercontent.com/dominguez-posh/keyvault-pwsafe-releases/early-access/update-ea.xml'
}
# Older Forcelist values of ours (earlier releases, any tag) may be replaced; everything else with our ID is foreign.
$script:KsExtOwnSource = 'https://github.com/dominguez-posh/'
# #483 (prepared): the hidden Edge Add-ons listings. Empty until they are published; the source 'store' is refused
# until then. Chrome has no store listing yet.
$script:KsStoreExtIds = [ordered]@{ stable = ''; beta = '' }
$script:KsStoreFeed = 'https://edge.microsoft.com/extensionwebstorebase/v1/crx'
$script:KsBrowserBases = [ordered]@{ edge = 'SOFTWARE\Policies\Microsoft\Edge'; chrome = 'SOFTWARE\Policies\Google\Chrome' }
$script:KsPolicyKey = 'SOFTWARE\Policies\Keevault'
$script:KsNoPolicyKey = 'SOFTWARE\Keevault'
$script:KsDpMarker = 'Keevault-Einrichtungstool (#501)'
$script:KsDpFields = @('scope', 'requirePin', 'updateChannel', 'updateMode', 'browserIntegration', 'windowsProvider', 'tenantId', 'clientId', 'connectVaults', 'extensionBrowsers', 'extensionSource')

function New-KsDevicePolicy {
    return [ordered]@{
        scope = 'machine'; requirePin = $null; updateChannel = ''; updateMode = ''; browserIntegration = $null; windowsProvider = $null
        tenantId = ''; clientId = ''; connectVaults = $false; extensionBrowsers = @(); extensionSource = 'github'
    }
}

function Test-KsDevicePolicy($Raw, $Errors) {
    # Part of Test-KeevaultSetupPlan: strict like the rest of the plan. Missing = nothing chosen (old plans stay valid).
    $d = New-KsDevicePolicy
    if ($null -eq $Raw) { return $d }
    if (-not ($Raw -is [System.Collections.IDictionary])) { $Errors.Add((KsT 'dp.object')); return $d }
    foreach ($k in $Raw.Keys) { if ($script:KsDpFields -notcontains $k) { $Errors.Add((KsT 'plan.unknown' $k 'devicePolicy')) } }
    $text = {
        param([string] $Key, [string[]] $Allowed)
        if (-not $Raw.Contains($Key) -or $null -eq $Raw[$Key]) { return $d[$Key] }
        $v = $Raw[$Key]
        if (-not ($v -is [string]) -or ($Allowed -and $Allowed -notcontains $v)) { $Errors.Add((KsT 'dp.choice' $Key ($Allowed -join ', '))); return $d[$Key] }
        return $v.Trim()
    }
    $switch = {
        param([string] $Key, [switch] $NoNull)
        if (-not $Raw.Contains($Key)) { return $d[$Key] }
        $v = $Raw[$Key]
        if ($null -eq $v -and -not $NoNull) { return $null }
        if (-not ($v -is [bool])) { $Errors.Add((KsT 'dp.bool' $Key)); return $d[$Key] }
        return $v
    }
    $d.scope = & $text 'scope' @('machine', 'user')
    $d.updateChannel = & $text 'updateChannel' @('', 'stable', 'beta')
    $d.updateMode = & $text 'updateMode' @('', 'off', 'auto', 'ask')
    $d.extensionSource = & $text 'extensionSource' @('github', 'store')
    $d.tenantId = & $text 'tenantId'
    $d.clientId = & $text 'clientId'
    $d.requirePin = & $switch 'requirePin'
    $d.browserIntegration = & $switch 'browserIntegration'
    $d.windowsProvider = & $switch 'windowsProvider'
    $d.connectVaults = & $switch 'connectVaults' -NoNull
    if ($d.tenantId -and $d.tenantId -notmatch $script:KsGuid -and $d.tenantId -notmatch '^(?=.{3,253}$)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$') { $Errors.Add((KsT 'dp.tenant')) }
    if ($d.clientId -and $d.clientId -notmatch $script:KsGuid) { $Errors.Add((KsT 'dp.client')) }
    if ($Raw.Contains('extensionBrowsers')) {
        $b = $Raw['extensionBrowsers']
        if ($b -is [string] -or $b -is [System.Collections.IDictionary] -or -not ($b -is [System.Collections.IEnumerable])) { $Errors.Add((KsT 'dp.browsers')) }
        else {
            $list = @()
            foreach ($x in @($b)) {
                if (-not ($x -is [string]) -or @('edge', 'chrome') -notcontains $x) { $Errors.Add((KsT 'dp.browsers')); continue }
                if ($list -notcontains $x) { $list += $x }
            }
            # Fixed order, so the plan hash does not depend on the order of the clicks.
            $d.extensionBrowsers = @(@('edge', 'chrome') | Where-Object { $list -contains $_ })
        }
    }
    if ($d.extensionSource -eq 'store' -and $d.extensionBrowsers.Count) {
        if ($d.extensionBrowsers -contains 'chrome') { $Errors.Add((KsT 'dp.storeChrome')) }
        if (-not $script:KsStoreExtIds[(Get-KsDpChannel $d)]) { $Errors.Add((KsT 'dp.storeMissing')) }
    }
    return $d
}

function Get-KsDpChannel($Dp) {
    if ($Dp.updateChannel -eq 'beta') { return 'beta' }
    return 'stable'
}

function Get-KsExtension($Dp) {
    # Extension ID, feed, the Forcelist value and the ExtensionSettings value (the same fixed JSON string as
    # desktop/machine-setup.js settingsValue(), so the app recognises the policy as its own).
    $channel = Get-KsDpChannel $Dp
    $id = $script:KsExtId; $feed = $script:KsExtFeeds[$channel]
    if ($Dp.extensionSource -eq 'store') { $id = $script:KsStoreExtIds[$channel]; $feed = $script:KsStoreFeed }
    return [ordered]@{
        Id = $id; Feed = $feed; Channel = $channel
        Forcelist = "$id;$feed"
        Settings = '{"' + $id + '":{"update_url":"' + $feed + '","override_update_url":true}}'
        # What counts as ours when it is already there: both feeds of the current release, any older address of ours.
        OwnForcelist = @($script:KsExtFeeds.Values | ForEach-Object { "$($script:KsExtId);$_" })
        OwnSettings = @($script:KsExtFeeds.Values | ForEach-Object { '{"' + $script:KsExtId + '":{"update_url":"' + $_ + '","override_update_url":true}}' })
    }
}

function Test-KsDevicePolicyChosen($Plan) {
    $d = $Plan.devicePolicy
    if (-not $d) { return $false }
    return ($null -ne $d.requirePin -or $d.updateChannel -or $d.updateMode -or $null -ne $d.browserIntegration -or $null -ne $d.windowsProvider -or
        $d.tenantId -or $d.clientId -or ($d.connectVaults -and @($Plan.vaults).Count) -or @($d.extensionBrowsers).Count)
}

function Get-KsDevicePolicyValues($Plan) {
    <#
        The registry values of the choice: Hive (HKLM/HKCU), Key, Name, Type (String/DWord), Value, Policy (name in
        Keevault.admx, '' for the browser values), Element (ADMX element id for values with input), Label (report).
    #>
    $d = $Plan.devicePolicy
    $out = New-Object System.Collections.Generic.List[object]
    if (-not $d) { return $out.ToArray() }
    $hive = 'HKLM'; if ($d.scope -eq 'user') { $hive = 'HKCU' }
    $add = {
        param([string] $Name, [string] $Type, $Value, [string] $Label, [string] $Element = '', [string] $Key = $script:KsPolicyKey, [string] $Policy = $Name, [string] $H = $hive)
        $out.Add([pscustomobject][ordered]@{ Hive = $H; Key = $Key; Name = $Name; Type = $Type; Value = $Value; Policy = $Policy; Element = $Element; Label = $Label })
    }
    $bool = { param($v) if ($v) { 1 } else { 0 } }
    if ($null -ne $d.requirePin) { & $add 'RequirePin' 'DWord' (& $bool $d.requirePin) (KsT 'dp.l.requirePin') }
    if ($d.updateChannel) { & $add 'UpdateChannel' 'String' $d.updateChannel (KsT 'dp.l.updateChannel') 'UpdateChannel' }
    if ($d.updateMode) { & $add 'UpdateMode' 'String' $d.updateMode (KsT 'dp.l.updateMode') 'UpdateMode' }
    if ($null -ne $d.browserIntegration) { & $add 'BrowserIntegration' 'DWord' (& $bool $d.browserIntegration) (KsT 'dp.l.browserIntegration') }
    if ($null -ne $d.windowsProvider) { & $add 'WindowsProvider' 'DWord' (& $bool $d.windowsProvider) (KsT 'dp.l.windowsProvider') }
    if ($d.tenantId) { & $add 'TenantId' 'String' $d.tenantId (KsT 'dp.l.tenantId') 'TenantId' }
    if ($d.clientId) { & $add 'ClientId' 'String' $d.clientId (KsT 'dp.l.clientId') 'ClientId' }
    if ($d.connectVaults) {
        # Value name = display name (the app shows it), the vault name when two display names are the same.
        $names = @($Plan.vaults | ForEach-Object { $_.displayName })
        foreach ($v in $Plan.vaults) {
            $name = $v.displayName
            if (@($names | Where-Object { $_ -eq $name }).Count -gt 1 -or $name -match '^\d+$') { $name = $v.name }
            & $add $name 'String' "https://$($v.name).vault.azure.net/" (KsT 'dp.l.vault') 'VaultsList' "$($script:KsPolicyKey)\Vaults" 'Vaults'
        }
    }
    if (@($d.extensionBrowsers).Count) {
        $ext = Get-KsExtension $d
        foreach ($b in $d.extensionBrowsers) {
            $base = $script:KsBrowserBases[$b]
            $bn = @{ edge = 'Edge'; chrome = 'Chrome' }[$b]
            # Only the Forcelist entry (it carries the update address). ExtensionSettings is one JSON value for every
            # extension: written by a GPO it would replace a company's list from Intune, GPP or Chrome Cloud Management
            # unseen. Only the Intune remediation script sets it, after checking the device's value (Keevault-Browser-Richtlinie.ps1).
            & $add '*' 'String' $ext.Forcelist (KsT 'dp.l.forcelist' $bn) '' "$base\ExtensionInstallForcelist" '' 'HKLM'
        }
        # The company sets the browser policy itself from now on: the app and Keevault-Geraet-Einrichten.ps1 leave it alone.
        & $add 'NoExtensionPolicy' 'DWord' 1 (KsT 'dp.l.noPolicy') '' $script:KsNoPolicyKey '' 'HKLM'
    }
    return $out.ToArray()
}

function Get-KsGpoOwn {
    <#
        What the GPO script may remove from its own GPO before writing (every value this tool can write, also those of
        an earlier choice): key, value names (empty = any) and a pattern the data must match ('' = any). Never a whole
        key: an admin's own settings in the same key of this GPO stay.
    #>
    $own = New-Object System.Collections.Generic.List[object]
    $ids = @(@($script:KsExtId) + @($script:KsStoreExtIds.Values) | Where-Object { $_ })
    foreach ($hive in 'HKLM', 'HKCU') {
        $own.Add([ordered]@{ key = "$hive\$($script:KsPolicyKey)"; names = @('RequirePin', 'UpdateChannel', 'UpdateMode', 'BrowserIntegration', 'WindowsProvider', 'TenantId', 'ClientId'); pattern = '' })
        $own.Add([ordered]@{ key = "$hive\$($script:KsPolicyKey)\Vaults"; names = @(); pattern = '^https://[A-Za-z0-9-]+\.vault\.azure\.net/$' })
    }
    foreach ($base in $script:KsBrowserBases.Values) {
        $own.Add([ordered]@{ key = "HKLM\$base\ExtensionInstallForcelist"; names = @(); pattern = '^(' + ($ids -join '|') + ');' })
    }
    $own.Add([ordered]@{ key = "HKLM\$($script:KsNoPolicyKey)"; names = @('NoExtensionPolicy'); pattern = '' })
    return $own.ToArray()
}

function ConvertTo-KsXmlAttr([string] $Text) {
    return $Text.Replace('&', '&amp;').Replace('"', '&quot;').Replace('<', '&lt;').Replace('>', '&gt;').Replace("'", '&apos;')
}

function Get-KsAdmxPath {
    # Packaged tool: <tool>\policy; in the repo: installer\policy next to setup-tool (the same files as the release ZIP).
    $tool = Get-KsToolRoot
    foreach ($dir in @((Join-Path $tool 'policy'), (Join-Path (Join-Path (Split-Path $tool -Parent) 'installer') 'policy'))) {
        if (Test-Path -LiteralPath (Join-Path $dir 'Keevault.admx')) { return $dir }
    }
    throw (KsT 'dp.noAdmx')
}

function ConvertTo-KsIntuneProfile($Plan, [string] $Name) {
    <#
        Intune device configuration profile (Graph: #microsoft.graph.windows10CustomConfiguration): the Keevault ADMX
        via ADMX ingestion, then one OMA-URI per chosen Keevault value. Browser values are not in it: Intune ADMX
        ingestion may not write below Software\Policies\Microsoft; they come with the remediation script.
    #>
    $values = @(Get-KsDevicePolicyValues $Plan | Where-Object { $_.Policy })
    if (-not $values.Count) { return $null }
    $admx = [System.IO.File]::ReadAllText((Join-Path (Get-KsAdmxPath) 'Keevault.admx'), [System.Text.Encoding]::UTF8).TrimStart([char] 0xFEFF)
    $scope = 'Device'; if ($Plan.devicePolicy.scope -eq 'user') { $scope = 'User' }
    $area = "./$scope/Vendor/MSFT/Policy/Config/Keevault~Policy~Keevault"
    $settings = New-Object System.Collections.Generic.List[object]
    $settings.Add([ordered]@{ '@odata.type' = '#microsoft.graph.omaSettingString'; displayName = 'Keevault ADMX'; description = (KsT 'dp.intune.admx')
            omaUri = './Device/Vendor/MSFT/Policy/ConfigOperations/ADMXInstall/Keevault/Policy/KeevaultAdmx'; value = $admx })
    foreach ($group in ($values | Group-Object Policy)) {
        $first = $group.Group[0]
        if ($first.Type -eq 'DWord' -and -not $first.Element) {
            $data = '<disabled/>'; if ($first.Value -eq 1) { $data = '<enabled/>' }
        }
        elseif ($first.Policy -eq 'Vaults') {
            # List with explicit names: name and value pairs, separated by U+F000 (the plan refuses it in names; a
            # name carrying it would shift the pairs, so stop here as well).
            foreach ($x in $group.Group) { if (($x.Name + $x.Value).Contains([string] [char] 0xF000)) { throw (KsT 'plan.displayName' $x.Name) } }
            $pairs = @($group.Group | ForEach-Object { (ConvertTo-KsXmlAttr $_.Name) + '&#xF000;' + (ConvertTo-KsXmlAttr $_.Value) }) -join '&#xF000;'
            $data = '<enabled/><data id="VaultsList" value="' + $pairs + '"/>'
        }
        else { $data = '<enabled/><data id="' + $first.Element + '" value="' + (ConvertTo-KsXmlAttr ([string] $first.Value)) + '"/>' }
        $settings.Add([ordered]@{ '@odata.type' = '#microsoft.graph.omaSettingString'; displayName = "Keevault $($first.Policy)"; description = $first.Label; omaUri = "$area/$($first.Policy)"; value = $data })
    }
    return [ordered]@{
        '@odata.type' = '#microsoft.graph.windows10CustomConfiguration'
        displayName   = $Name
        description   = "$($script:KsDpMarker). $(KsT 'dp.intune.desc')"
        omaSettings   = $settings.ToArray()
    }
}

function Add-KsDevicePolicyReport($Doc, $Plan) {
    # Report section (part b): what the policies set and what is left to do by hand.
    if (-not (Test-KsDevicePolicyChosen $Plan)) { return }
    Add-KsB $Doc 'h2' (KsT 'dp.rep.title')
    $scope = KsT 'dp.rep.machine'; if ($Plan.devicePolicy.scope -eq 'user') { $scope = KsT 'dp.rep.user' }
    Add-KsB $Doc 'p' (KsT 'dp.rep.intro' $scope)
    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($v in (Get-KsDevicePolicyValues $Plan)) {
        $name = $v.Name; if ($name -eq '*') { $name = KsT 'dp.rep.nextFree' }
        $rows.Add(@($v.Label, "$($v.Hive)\$($v.Key)", $name, [string] $v.Value))
    }
    Add-KsB $Doc 'table' '' @{ Head = @((KsT 'dp.rep.setting'), (KsT 'dp.rep.key'), (KsT 'dp.rep.value'), (KsT 'dp.rep.data')); Rows = $rows.ToArray() }
    foreach ($i in 1..4) { Add-KsB $Doc 'check' (KsT "dp.rep.todo.$i") @{ Done = $false } }
}
